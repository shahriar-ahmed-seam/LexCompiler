"""agent-horizon-scanner: CrewAI role-based crew over the statute-ingest MCP tools."""
from __future__ import annotations

import json
import os
from typing import Any, Literal, Optional

# CrewAI sends anonymous telemetry and traces by default; the crew handles client code and rules.
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

from crewai import LLM, Agent, Crew, Task  # noqa: E402
from crewai.tools import BaseTool  # noqa: E402
from pydantic import BaseModel, Field, create_model  # noqa: E402

from .llm import extract_json, route  # noqa: E402
from .mcp_client import AgentOutput, McpClient, McpTool  # noqa: E402

AGENT_ID = "agent-horizon-scanner"
_JSON_TYPES: dict[str, Any] = {"string": str, "number": float, "integer": int, "boolean": bool, "array": list, "object": dict}


def args_model(tool: McpTool) -> type[BaseModel]:
    """A Pydantic model of the MCP tool's input schema, so the model sees the real parameters."""
    schema = tool.input_schema or {}
    required = set(schema.get("required") or [])
    fields: dict[str, Any] = {}
    for name, spec in (schema.get("properties") or {}).items():
        py: Any = Literal[tuple(spec["enum"])] if spec.get("enum") else _JSON_TYPES.get(spec.get("type"), Any)
        description = spec.get("description")
        fields[name] = (py, Field(..., description=description)) if name in required else (Optional[py], Field(None, description=description))
    return create_model(f"{tool.name}_args", **fields)


def compact_feed(result: dict[str, Any], excerpt_chars: int = 280) -> str:
    """The feed without the long excerpts: CrewAI resends every tool result on each turn, so size is cost."""
    items = result.get("items") or []
    rows = [
        {
            "source": i.get("source"),
            "title": i.get("title"),
            "published": i.get("publicationDate"),
            "url": i.get("url"),
            "illustrative": bool(i.get("illustrative")),
            "excerpt": (i.get("excerpt") or "")[:excerpt_chars],
        }
        for i in items
    ]
    return json.dumps({"totalStatutesFetched": result.get("totalStatutesFetched", len(items)), "items": rows}, ensure_ascii=False)


#: Tools whose results are reshaped before the model sees them.
SHAPERS = {"fetch_live_regulatory_feed": compact_feed}


def mcp_tools(client: McpClient) -> list[BaseTool]:
    tools = []
    for t in client.list_tools():
        class _Tool(BaseTool):
            name: str = t.name
            description: str = t.description or t.name
            args_schema: type[BaseModel] = args_model(t)

            def _run(self, **kwargs) -> str:  # noqa: D401 - CrewAI tool contract
                args = {k: v for k, v in kwargs.items() if v is not None}
                shape = SHAPERS.get(self.name)
                return shape(client.call_tool_json(self.name, args)) if shape else client.call_tool(self.name, args, limit=6000)

        tools.append(_Tool())
    return tools


def _no_first_run_prompt() -> None:
    """CrewAI asks on its first run whether to upload traces, and waits 20 s for an answer. The crew never uploads
    traces, so the question is skipped for this process (nothing is written to the user's CrewAI settings)."""
    try:
        from crewai.events.listeners.tracing.utils import _first_time_trace_hook

        _first_time_trace_hook.set(lambda: False)
    except ImportError:  # a CrewAI release without the hook
        pass


def make_llm(model: str | None = None) -> LLM:
    """The server's agent route, or an explicit CrewAI model string (provider key from the environment)."""
    if model:
        return LLM(model=model, temperature=0)
    r = route(AGENT_ID)
    return LLM(model=r.agent_id, custom_openai=True, base_url=r.base_url, api_key=r.api_key, default_headers=r.headers, temperature=0, max_tokens=1500)


def run(client: McpClient | None = None, model: str | None = None) -> AgentOutput:
    client = client or McpClient("lex-statute-ingest-mcp")
    scanner = Agent(
        role="Regulatory horizon scanner",
        goal="Find regulatory changes in EUR-Lex and the U.S. Federal Register that could affect the company's compliance rules",
        backstory="You monitor official regulatory sources for amendments. You report only what the tools return and say when an item is marked illustrative.",
        tools=mcp_tools(client),
        llm=make_llm(model),
        max_iter=3,
        allow_delegation=False,
        verbose=False,
    )
    task = Task(
        description=(
            "Call fetch_live_regulatory_feed once with jurisdiction ALL. For each item it returns, name the obligation it concerns "
            "(data retention or erasure, logging of personal data, human review of AI decisions, data residency, encryption, or none). "
            "Use parse_dpa_contract_clause for at most two items whose excerpt is unclear. Say when an item is marked illustrative."
        ),
        expected_output=(
            'Only a JSON object: {"summary": two sentences on what changed, "keyFacts": one short entry per item with its source, '
            'title and the obligation it concerns, "confidence": a number between 0 and 1}.'
        ),
        agent=scanner,
        output_pydantic=AgentOutput,
    )
    _no_first_run_prompt()
    result = Crew(agents=[scanner], tasks=[task], verbose=False, tracing=False).kickoff()
    if result.pydantic is not None:
        return result.pydantic
    return AgentOutput.model_validate(json.loads(extract_json(result.raw or "")))
