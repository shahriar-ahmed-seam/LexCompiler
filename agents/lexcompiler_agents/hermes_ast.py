"""agent-polyglot-ast-mapper: Hermes-style function calling on a local Ollama model (Qwen2.5-Coder)."""
from __future__ import annotations

import json
import os
import re
import urllib.request

from .llm import extract_json
from .mcp_client import AgentOutput, McpClient, with_context

TOOL_CALL = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.S)


def compact_scan(result: dict) -> str:
    """The scan without code snippets and edit anchors (about 35,000 characters → under 3,000), so it fits a small local model's context."""
    findings = [
        {"type": f.get("constructType"), "at": f"{f.get('filePath')}:{f.get('line')}", "function": f.get("functionName"), "language": f.get("language")}
        for f in result.get("astFindings") or []
    ]
    tables = [
        {
            "table": t.get("tableName"),
            "at": f"{t.get('filePath')}:{t.get('startLine')}",
            "containsPII": t.get("containsPII"),
            "retentionHours": t.get("retentionHoursConfigured"),
            "tenantKeyIsolation": t.get("hasTenantKeyIsolation"),
            "unencryptedPiiColumns": t.get("unencryptedPiiColumns"),
        }
        for t in result.get("sqlTables") or []
    ]
    return json.dumps({"filesScanned": result.get("filesScanned"), "totalAstNodes": result.get("totalAstNodes"), "constructs": findings, "sqlTables": tables})


#: Tools whose results are reshaped before the model sees them.
SHAPERS = {"scan_polyglot_repository_ast": compact_scan}


def _chat(base: str, model: str, messages: list[dict], tools: list[dict]) -> dict:
    # num_predict caps each answer: small models can otherwise generate until the request times out.
    body = json.dumps({"model": model, "messages": messages, "tools": tools, "stream": False, "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 800}}).encode()
    req = urllib.request.Request(f"{base.rstrip('/')}/api/chat", data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.loads(res.read())["message"]


def parse_tool_calls(message: dict) -> list[tuple[str, dict]]:
    """Ollama's native tool_calls, or Hermes <tool_call>{"name":…,"arguments":…}</tool_call> tags in the text."""
    calls = [(c["function"]["name"], c["function"].get("arguments") or {}) for c in message.get("tool_calls") or []]
    for m in TOOL_CALL.finditer(message.get("content") or ""):
        obj = json.loads(m.group(1))
        calls.append((obj["name"], obj.get("arguments") or {}))
    return calls


def run(client: McpClient | None = None, model: str | None = None, base: str | None = None, max_turns: int = 4, context: str = "") -> AgentOutput:
    client = client or McpClient("lex-polyglot-ast-mcp")
    model = model or os.environ.get("LEXCOMPILER_HERMES_MODEL", "qwen2.5-coder:7b")
    base = base or os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    tools = [{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}} for t in client.list_tools()]
    messages = [
        {"role": "system", "content": "You map polyglot repositories to compliance constructs. Call a tool with <tool_call>{\"name\": ..., \"arguments\": {...}}</tool_call>. "
         f"When done, answer with JSON: {json.dumps(AgentOutput.model_json_schema())}"},
        {"role": "user", "content": with_context("Scan the repository and list the compliance-relevant constructs.", context)},
    ]
    corrected = False
    for _ in range(max_turns):
        msg = _chat(base, model, messages, tools)
        calls = parse_tool_calls(msg)
        messages.append({"role": "assistant", "content": msg.get("content") or "", **({"tool_calls": msg["tool_calls"]} if msg.get("tool_calls") else {})})
        if not calls:
            text = msg.get("content") or ""
            try:
                return AgentOutput.model_validate_json(extract_json(text))
            except ValueError as err:  # pydantic's ValidationError is a ValueError too
                if corrected:
                    raise RuntimeError(f"{model} did not return a valid answer after one correction: {text[:300]!r}") from err
                # One correction turn, as in the server's agent runtime.
                corrected = True
                messages.append({"role": "user", "content": f"Your answer is invalid ({str(err).splitlines()[0][:200]}). Reply with only the JSON object: {{\"summary\": ..., \"keyFacts\": [...], \"confidence\": ...}}."})
                continue
        for name, args in calls:
            shape = SHAPERS.get(name)
            messages.append({"role": "tool", "content": shape(client.call_tool_json(name, args)) if shape else client.call_tool(name, args)})
    raise RuntimeError(f"Hermes agent did not finish within {max_turns} turns")
