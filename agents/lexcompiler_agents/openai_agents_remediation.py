"""agent-remediation-pr-enforcer: OpenAI Agents SDK (the successor of Swarm) with a handoff to a reviewer."""
from __future__ import annotations

import json
import os

from agents import Agent, FunctionTool, Model, OpenAIChatCompletionsModel, Runner, set_tracing_disabled

from .llm import route
from .mcp_client import AgentOutput, McpClient

AGENT_ID = "agent-remediation-pr-enforcer"

# The SDK uploads traces to OpenAI by default; the crew handles client code. LEXCOMPILER_AGENTS_TRACING=1 turns them on.
set_tracing_disabled(os.environ.get("LEXCOMPILER_AGENTS_TRACING") != "1")


def mcp_function_tools(client: McpClient) -> list[FunctionTool]:
    def make(tool):
        async def invoke(_ctx, args_json: str) -> str:
            return client.call_tool(tool.name, json.loads(args_json or "{}"))

        schema = tool.input_schema or {"type": "object", "properties": {}}
        return FunctionTool(name=tool.name, description=tool.description, params_json_schema=schema, on_invoke_tool=invoke, strict_json_schema=False)

    return [make(t) for t in client.list_tools()]


def default_model() -> Model:
    """The server's agent route as a Chat Completions model."""
    from openai import AsyncOpenAI

    r = route(AGENT_ID)
    client = AsyncOpenAI(base_url=r.base_url, api_key=r.api_key, default_headers=r.headers, max_retries=1)
    return OpenAIChatCompletionsModel(model=r.agent_id, openai_client=client)


def run(client: McpClient | None = None, model: str | Model | None = None, max_turns: int = 6) -> AgentOutput:
    client = client or McpClient("lex-remediation-pr-mcp")
    model = model or default_model()
    reviewer = Agent(
        name="PR gate reviewer",
        instructions=(
            "Check the post-patch Z3 status the synthesizer's tool returned. Only SAT_COMPLIANT may be merged; say plainly when it is "
            "anything else. Summarise the patch: files, what each change does, and the rule it satisfies."
        ),
        model=model,
        output_type=AgentOutput,
    )
    # Typed on both agents: a model that answers without handing off must still return AgentOutput.
    synthesizer = Agent(
        name="Remediation synthesizer",
        instructions="Synthesize and verify the remediation with the tools, then hand off to the reviewer with the tool's post-patch status.",
        model=model,
        tools=mcp_function_tools(client),
        handoffs=[reviewer],
        output_type=AgentOutput,
    )
    return Runner.run_sync(synthesizer, "Remediate the repository and verify the patch.", max_turns=max_turns).final_output
