import json

from lexcompiler_agents import crew
from lexcompiler_agents.mcp_client import AgentOutput, with_context


def test_each_agent_gets_the_previous_report_and_the_gate_comes_from_the_tool(stub):
    seen = []

    def runner(agent_id, context):
        seen.append((agent_id, context))
        return AgentOutput(summary=f"{agent_id} done", keyFacts=[f"{agent_id}:1"], confidence=0.9)

    gate = stub("lex-remediation-pr-mcp", {"synthesize_and_verify_remediation_pr": {"status": "READY_TO_MERGE", "postPatchZ3Status": "SAT_COMPLIANT"}})
    run = crew.run_crew(runner, gate_client=gate)

    assert [a for a, _ in seen] == crew.ORDER
    assert seen[0][1] == ""
    for (prev, _), (_, context) in zip(seen, seen[1:]):
        assert json.loads(context)["summary"] == f"{prev} done"
    assert run["steps"][1]["received"] == {"report": run["steps"][0]["handoff"]}
    assert [s["status"] for s in run["steps"]] == ["COMPLETED"] * 6
    assert run["gate"] == "PATCH_VERIFIED"


def test_a_failed_agent_ends_the_chain():
    def runner(agent_id, context):
        if agent_id == "agent-polyglot-ast-mapper":
            raise RuntimeError("qwen2.5-coder:0.5b did not return a valid answer")
        return AgentOutput(summary="ok", keyFacts=[], confidence=0.5)

    run = crew.run_crew(runner, gate_client=None)
    assert [s["status"] for s in run["steps"]] == ["COMPLETED", "COMPLETED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED"]
    assert "did not return a valid answer" in run["steps"][2]["error"]
    assert run["gate"] == "INCOMPLETE"


def test_gate_reads_nothing_to_fix_and_blocked_from_the_tool(stub):
    ok = stub("lex-remediation-pr-mcp", {"synthesize_and_verify_remediation_pr": {"status": "ALL_COMPLIANT_NO_PR_NEEDED"}})
    blocked = stub("lex-remediation-pr-mcp", {"synthesize_and_verify_remediation_pr": {"status": "BLOCKED_UNRESOLVED", "postPatchZ3Status": "UNSAT_VIOLATION"}})
    assert crew.gate_from_tool(ok) == "NOTHING_TO_FIX"
    assert crew.gate_from_tool(blocked) == "PATCH_BLOCKED"


def test_with_context_puts_the_previous_report_before_the_task():
    assert with_context("Prove it.") == "Prove it."
    text = with_context("Prove it.", '{"summary": "3 rules compiled"}')
    assert text.index("3 rules compiled") < text.index("Prove it.")
