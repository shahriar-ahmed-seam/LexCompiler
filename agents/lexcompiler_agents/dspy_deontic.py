"""agent-deontic-extractor: DSPy ReAct program with a typed signature over the deontic-compiler tools."""
from __future__ import annotations

import dspy

from .llm import route
from .mcp_client import AgentOutput, McpClient

AGENT_ID = "agent-deontic-extractor"


class DeonticExtraction(dspy.Signature):
    """Compile a legal clause into deontic logic with the compiler tools: obligations O(φ), prohibitions F(φ) and
    permissions P(φ), the SMT-LIB2 assertions and the OPA Rego rule. Summarise the obligations and quote the
    numbers (hours, thresholds, regions) exactly as the tools returned them."""

    clause: str = dspy.InputField()
    result: AgentOutput = dspy.OutputField()


def make_lm(model: str | None = None) -> dspy.LM:
    """The server's agent route, or an explicit LiteLLM model string (provider key from the environment)."""
    if model:
        return dspy.LM(model, temperature=0)
    r = route(AGENT_ID)
    return dspy.LM(f"openai/{r.agent_id}", api_base=r.base_url, api_key=r.api_key, extra_headers=r.headers, temperature=0, max_tokens=1500, cache=False, num_retries=1)


def run(clause: str, client: McpClient | None = None, model: str | None = None, max_iters: int = 3) -> AgentOutput:
    client = client or McpClient("lex-deontic-compiler-mcp")

    def make(tool):
        def call(**kwargs) -> str:
            return client.call_tool(tool.name, kwargs)

        call.__name__ = tool.name
        call.__doc__ = tool.description
        return dspy.Tool(call, name=tool.name, desc=tool.description, args=tool.input_schema.get("properties", {}))

    program = dspy.ReAct(DeonticExtraction, tools=[make(t) for t in client.list_tools()], max_iters=max_iters)
    with dspy.context(lm=make_lm(model)):
        return program(clause=clause).result
