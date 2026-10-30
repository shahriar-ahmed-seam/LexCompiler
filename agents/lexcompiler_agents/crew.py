"""python -m lexcompiler_agents crew: the six agents in order, each in its own framework.

Each agent gets the previous agent's report as context and checks it against its own tool calls. The run is
sent to the server (POST /api/agents/crew/runs/import), which stores it with the tokens it logged for each
agent. The gate comes from the remediation tool itself, not from an agent's text.
"""
from __future__ import annotations

import importlib
import json
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from .mcp_client import AGENTS, CLIENT_HEADERS, AgentOutput, McpClient, setting

#: The crew's order (AGENTS.md §2).
ORDER = list(AGENTS)

Runner = Callable[[str, str], AgentOutput]


def default_runner(model: str | None = None, clause: str = "PII must be encrypted at rest and purged within 72 hours.", query: str = "Which code constructs violate the active clauses?") -> Runner:
    """Runs one agent of the crew by id with the previous agent's report as context."""

    def run(agent_id: str, context: str) -> AgentOutput:
        server, module = AGENTS[agent_id]
        mod = importlib.import_module(f".{module}", __package__)
        client = McpClient(server)
        if module == "langgraph_rag":
            from .llm import grounded_answer

            return mod.run(query, client, llm_answer=grounded_answer(agent_id), context=context)
        if module == "dspy_deontic":
            return mod.run(clause, client, model, context=context)
        if module == "pydantic_ai_critic":
            return mod.run(model, client, context=context)
        if module == "hermes_ast":
            # Hermes runs on local Ollama; a framework model string for the cloud agents doesn't apply to it.
            return mod.run(client=client, context=context)
        return mod.run(client=client, model=model, context=context)

    return run


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def gate_from_tool(client: McpClient) -> str:
    """The AGENTS.md §3 gate, read from the remediation tool's own result."""
    out = client.call_tool_json("synthesize_and_verify_remediation_pr", {})
    if out.get("status") == "ALL_COMPLIANT_NO_PR_NEEDED":
        return "NOTHING_TO_FIX"
    return "PATCH_VERIFIED" if out.get("postPatchZ3Status") == "SAT_COMPLIANT" else "PATCH_BLOCKED"


def run_crew(runner: Runner, gate_client: McpClient | None = None) -> dict[str, Any]:
    """Runs the crew; stops at the first failed agent and skips the rest."""
    started, t0 = _now(), time.perf_counter()
    steps: list[dict[str, Any]] = []
    context = ""
    failed = False
    for i, agent_id in enumerate(ORDER):
        base = {"stepNumber": i + 1, "agentId": agent_id, "received": {"report": json.loads(context)} if context else {}}
        if failed:
            steps.append({**base, "status": "SKIPPED", "execution": "SKIPPED", "summary": "Not run: an earlier agent failed.", "handoff": {}, "latencyMs": 0})
            continue
        s0 = time.perf_counter()
        try:
            out = runner(agent_id, context)
            report = out.model_dump()
            steps.append({**base, "status": "COMPLETED", "execution": "LLM_AGENT", "summary": out.summary, "handoff": report, "latencyMs": round((time.perf_counter() - s0) * 1000)})
            context = json.dumps(report)
        except Exception as err:  # one agent's failure ends the chain, and the run says which and why
            failed = True
            steps.append({**base, "status": "FAILED", "execution": "LLM_AGENT", "summary": "The agent failed.", "error": f"{type(err).__name__}: {err}"[:500], "handoff": {}, "latencyMs": round((time.perf_counter() - s0) * 1000)})
    gate = "INCOMPLETE" if failed else gate_from_tool(gate_client or McpClient("lex-remediation-pr-mcp"))
    return {"startedAt": started, "finishedAt": _now(), "useModels": True, "gate": gate, "latencyMs": round((time.perf_counter() - t0) * 1000), "steps": steps}


def store_run(run: dict[str, Any], base_url: str | None = None, token: str | None = None) -> str:
    """Sends the run to the server; returns its id there."""
    base_url = base_url or setting("LEXCOMPILER_URL", "http://127.0.0.1:3001")
    token = token or setting("LEXCOMPILER_API_TOKEN")
    headers = {"Content-Type": "application/json", **CLIENT_HEADERS, **({"Authorization": f"Bearer {token}"} if token else {})}
    req = urllib.request.Request(f"{base_url.rstrip('/')}/api/agents/crew/runs/import", data=json.dumps(run).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())["id"]
