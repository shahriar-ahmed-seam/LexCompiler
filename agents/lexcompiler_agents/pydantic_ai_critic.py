"""agent-z3-formal-critic: Pydantic-AI agent with typed output over the Z3 prover MCP tools."""
from __future__ import annotations

from pydantic_ai import Agent, Tool
from pydantic_ai.usage import UsageLimits

from .llm import route
from .mcp_client import AgentOutput, McpClient

AGENT_ID = "agent-z3-formal-critic"


def default_model():
    """The server's agent route as an OpenAI-compatible chat model."""
    from openai import AsyncOpenAI
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    r = route(AGENT_ID)
    client = AsyncOpenAI(base_url=r.base_url, api_key=r.api_key, default_headers=r.headers, max_retries=1)
    return OpenAIChatModel(r.agent_id, provider=OpenAIProvider(openai_client=client))


def build_agent(model, client: McpClient) -> Agent:
    def make(tool):
        def call(**kwargs) -> str:
            return client.call_tool(tool.name, kwargs)

        call.__name__ = tool.name
        # The MCP input schema is passed on as is, so the model sees the tool's real parameters.
        return Tool.from_schema(call, name=tool.name, description=tool.description, json_schema=tool.input_schema or {"type": "object", "properties": {}})

    tools = [make(t) for t in client.list_tools()]
    return Agent(
        model,
        output_type=AgentOutput,
        tools=tools,
        system_prompt=(
            "You are LexCompiler's Z3 formal critic. Prove the repository against the active clauses with the tools. "
            "For each clause report its status (SAT_COMPLIANT, UNSAT_VIOLATION or UNKNOWN_NEEDS_REVIEW), the unsat core "
            "and the offending file:line locations exactly as the tool returned them. Never invent results."
        ),
    )


def run(model=None, client: McpClient | None = None, task: str = "Prove the repository against every active clause.", request_limit: int = 6) -> AgentOutput:
    agent = build_agent(model or default_model(), client or McpClient("lex-z3-prover-mcp"))
    return agent.run_sync(task, usage_limits=UsageLimits(request_limit=request_limit)).output
