"""JSON-RPC client for LexCompiler's streamable-HTTP MCP endpoint (POST /api/mcp/<server>/rpc)."""
from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

#: Sent on every request to the server; the API guard requires it for loopback callers.
CLIENT_HEADERS = {"X-LexCompiler-Client": "python-agents"}


def setting(name: str, default: str | None = None) -> str | None:
    """An environment variable, else the same key from the repository's .env (LEXCOMPILER_ENV_FILE overrides
    the path). Only the key asked for is read, so provider keys in .env never enter the agents' process."""
    value = os.environ.get(name)
    if value:
        return value
    path = Path(os.environ.get("LEXCOMPILER_ENV_FILE") or Path(__file__).resolve().parents[2] / ".env")
    try:
        for line in path.read_text().splitlines():
            key, sep, raw = line.strip().partition("=")
            if sep and key.strip() == name:
                return raw.strip().strip("\"'") or default
    except OSError:
        pass
    return default


class AgentOutput(BaseModel):
    """Structured answer every agent returns (same schema as the TypeScript runtime)."""

    summary: str = Field(description="Two-sentence summary grounded in the tool results.")
    keyFacts: list[str] = Field(default_factory=list, description="Facts taken from tool results.")
    confidence: float = Field(ge=0, le=1)


@dataclass
class McpTool:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class McpClient:
    server_id: str
    base_url: str = field(default_factory=lambda: setting("LEXCOMPILER_URL", "http://127.0.0.1:3001"))
    token: str | None = field(default_factory=lambda: setting("LEXCOMPILER_API_TOKEN"))
    _id: int = 0

    def rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}).encode()
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **CLIENT_HEADERS}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(f"{self.base_url.rstrip('/')}/api/mcp/{self.server_id}/rpc", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=120) as res:
            reply = json.loads(res.read())
        if "error" in reply:
            raise RuntimeError(f"MCP {method} failed: {reply['error'].get('message')}")
        return reply["result"]

    def list_tools(self) -> list[McpTool]:
        return [McpTool(t["name"], t.get("description", ""), t.get("inputSchema", {})) for t in self.rpc("tools/list")["tools"]]

    def _call(self, name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
        result = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            raise RuntimeError("\n".join(c.get("text", "") for c in result.get("content", [])))
        return result

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None, limit: int = 8000) -> str:
        """Tool result as text for an LLM prompt (truncated to `limit` characters)."""
        text = "\n".join(c.get("text", "") for c in self._call(name, arguments).get("content", []))
        return text if len(text) <= limit else f"{text[:limit]}\n…(truncated)"

    def call_tool_json(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Full structured result, for programmatic use."""
        result = self._call(name, arguments)
        if "structuredContent" in result:
            return result["structuredContent"]
        return json.loads("".join(c.get("text", "") for c in result.get("content", [])))


# Agent id -> (MCP server, framework module) — mirrors server/agents/multiAgentOrchestrator.ts.
AGENTS = {
    "agent-horizon-scanner": ("lex-statute-ingest-mcp", "crewai_horizon"),
    "agent-deontic-extractor": ("lex-deontic-compiler-mcp", "dspy_deontic"),
    "agent-polyglot-ast-mapper": ("lex-polyglot-ast-mcp", "hermes_ast"),
    "agent-contextual-graph-rag": ("lex-hybrid-rag-mcp", "langgraph_rag"),
    "agent-z3-formal-critic": ("lex-z3-prover-mcp", "pydantic_ai_critic"),
    "agent-remediation-pr-enforcer": ("lex-remediation-pr-mcp", "openai_agents_remediation"),
}
