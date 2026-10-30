"""Model access for the crew.

Every framework (CrewAI, DSPy, LangGraph, Pydantic-AI, the OpenAI Agents SDK) talks to the server's
agent route, an OpenAI-compatible endpoint at /api/agents/llm/v1. The request's "model" is the agent
id; the server picks the model configured for that agent (LEXCOMPILER_AGENT_<ID>_*), holds the
provider key, enforces the agents' daily token budget and logs the call. The agents never see a
provider key. The Hermes agent runs on a local Ollama model instead.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .mcp_client import CLIENT_HEADERS, AgentOutput, setting


@dataclass(frozen=True)
class AgentRoute:
    agent_id: str
    base_url: str
    api_key: str
    headers: dict[str, str]


def route(agent_id: str) -> AgentRoute:
    base = (setting("LEXCOMPILER_URL", "http://127.0.0.1:3001") or "").rstrip("/")
    token = setting("LEXCOMPILER_API_TOKEN")
    if not token:
        raise RuntimeError("Set LEXCOMPILER_API_TOKEN (the server's operator token) so the agents can reach the agent route.")
    return AgentRoute(agent_id, f"{base}/api/agents/llm/v1", token, dict(CLIENT_HEADERS))


def extract_json(text: str) -> str:
    """The JSON object in a model answer (fenced or bare)."""
    if "```" in text:
        inner = text.split("```", 2)[1]
        text = inner[4:] if inner.startswith("json") else inner
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"no JSON object in the answer: {text[:200]!r}")
    return text[start : end + 1]


def grounded_answer(agent_id: str, max_sources: int = 6):
    """A LangGraph answer node: the agent's model answers only from the retrieved chunks."""
    from openai import OpenAI

    r = route(agent_id)
    client = OpenAI(base_url=r.base_url, api_key=r.api_key, default_headers=r.headers, max_retries=1)

    def answer(query: str, report: dict[str, Any]) -> AgentOutput:
        chunks = report.get("retrievedChunks", [])[:max_sources]
        sources = "\n\n".join(
            f"[{i + 1}] {c['chunk']['citationOrPath']}\n{(c['chunk'].get('rawChunkText') or '')[:700]}" for i, c in enumerate(chunks)
        )
        res = client.chat.completions.create(
            model=r.agent_id,
            temperature=0,
            max_tokens=700,
            messages=[
                {
                    "role": "system",
                    "content": "You answer compliance questions about a code repository using only the numbered sources. "
                    "Every key fact must name the source path it comes from. If the sources do not answer the question, say so and use a low confidence.",
                },
                {"role": "user", "content": f"Question: {query}\n\nSources:\n{sources or '(none retrieved)'}"},
            ],
            response_format={"type": "json_schema", "json_schema": {"name": "AgentOutput", "schema": AgentOutput.model_json_schema()}},
        )
        return AgentOutput.model_validate(json.loads(extract_json(res.choices[0].message.content or "")))

    return answer
