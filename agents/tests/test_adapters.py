import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from pydantic import ValidationError
from pydantic_ai.models.test import TestModel

# crewai_horizon must import before dspy_deontic: dspy's lazy numpy import breaks the real numpy
# import that crewai (via chromadb) needs later.
from lexcompiler_agents import crewai_horizon, dspy_deontic, hermes_ast, langgraph_rag, pydantic_ai_critic
from lexcompiler_agents.mcp_client import AgentOutput, McpTool


def test_pydantic_ai_critic_calls_the_mcp_tool_and_returns_typed_output(stub):
    client = stub("lex-z3-prover-mcp", {"prove_repository_compliance_z3": {"verdicts": [{"clauseId": "CLAUSE-DPA-4.2", "status": "UNSAT_VIOLATION"}]}})
    out = pydantic_ai_critic.run(TestModel(), client)
    assert isinstance(out, AgentOutput)
    assert client.calls[0][0] == "prove_repository_compliance_z3"


def test_langgraph_rag_rewrites_once_on_low_confidence_then_answers(stub):
    reports = [
        {"retrievedChunks": [{"cragVerdict": "AMBIGUOUS_REFINED", "chunk": {"citationOrPath": "x"}}], "rewrittenDeonticQuery": "DEONTIC_SEARCH(q)"},
        {"retrievedChunks": [{"cragVerdict": "CORRECT_HIGH_CONFIDENCE", "chunk": {"citationOrPath": "api/fastapi_intake.py:33"}}], "synthesizedNeuroSymbolicAnswer": "Z3 refutes HIPAA.", "ragasMetrics": {"contextPrecision": 0.8}},
    ]
    client = stub("lex-hybrid-rag-mcp", {"hybrid_contextual_graph_rag_query": lambda args: reports.pop(0)})
    out = langgraph_rag.run("Which endpoints log SSNs?", client)
    assert [c[1]["query"] for c in client.calls] == ["Which endpoints log SSNs?", "DEONTIC_SEARCH(q)"]
    assert out.keyFacts == ["api/fastapi_intake.py:33"] and out.confidence == 0.8


def test_hermes_parses_tool_call_tags_and_native_calls():
    assert hermes_ast.parse_tool_calls({"content": 'x <tool_call>{"name": "scan", "arguments": {"a": 1}}</tool_call>'}) == [("scan", {"a": 1})]
    assert hermes_ast.parse_tool_calls({"tool_calls": [{"function": {"name": "scan", "arguments": {}}}]}) == [("scan", {})]


def test_hermes_loop_against_a_stub_ollama(stub):
    replies = [
        {"content": '<tool_call>{"name": "scan_polyglot_repository_ast", "arguments": {}}</tool_call>'},
        {"content": json.dumps({"summary": "5 files scanned.", "keyFacts": ["schema/postgres_pii.sql"], "confidence": 0.7})},
    ]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            body = json.dumps({"message": replies.pop(0)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = stub("lex-polyglot-ast-mcp", {"scan_polyglot_repository_ast": {"filesScanned": 5}})
        out = hermes_ast.run(client, model="qwen2.5-coder:7b", base=f"http://127.0.0.1:{server.server_port}")
        assert out.summary == "5 files scanned." and client.calls == [("scan_polyglot_repository_ast", {})]
    finally:
        server.shutdown()


def test_hermes_correction_turn_forces_the_answer_schema(stub):
    """A small model that wraps its answer in a made-up tool call gets one turn with no tools and the schema as Ollama's format."""
    replies = [
        {"content": '<tool_call>{"name": "scan_polyglot_repository_ast", "arguments": {}}</tool_call>'},
        {"content": '{"name": "format_agent_output", "parameters": {"output": "5 files"}}'},
        {"content": json.dumps({"summary": "5 files scanned.", "keyFacts": ["api/fastapi_intake.py:31"], "confidence": 0.8})},
    ]
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            body = json.dumps({"message": replies.pop(0)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = stub("lex-polyglot-ast-mcp", {"scan_polyglot_repository_ast": {"filesScanned": 5}})
        out = hermes_ast.run(client, base=f"http://127.0.0.1:{server.server_port}")
        assert out.keyFacts == ["api/fastapi_intake.py:31"]
        assert requests[0]["model"] == "llama3.2" and "tools" in requests[0] and "format" not in requests[0]
        assert "tools" not in requests[2] and requests[2]["format"]["required"] == ["summary", "confidence"]
    finally:
        server.shutdown()


def test_crewai_args_model_marks_required_enums_and_optionals():
    tool = McpTool(
        "fetch_live_regulatory_feed",
        "Fetch the feed",
        {
            "type": "object",
            "required": ["jurisdiction"],
            "properties": {
                "jurisdiction": {"type": "string", "enum": ["EU", "US", "ALL"], "description": "Jurisdiction filter"},
                "limit": {"type": "integer", "description": "Max items"},
            },
        },
    )
    model = crewai_horizon.args_model(tool)
    assert model.model_fields["jurisdiction"].is_required()
    assert not model.model_fields["limit"].is_required()
    assert model.model_fields["jurisdiction"].annotation.__args__ == ("EU", "US", "ALL")
    inst = model.model_validate({"jurisdiction": "US"})
    assert inst.jurisdiction == "US" and inst.limit is None
    with pytest.raises(ValidationError):
        model.model_validate({"limit": 5})  # missing the required field
    with pytest.raises(ValidationError):
        model.model_validate({"jurisdiction": "XX"})  # outside the enum


def test_crewai_compact_feed_truncates_excerpts_and_keeps_flags():
    result = {
        "totalStatutesFetched": 2,
        "items": [
            {"source": "EUR_LEX", "title": "A", "publicationDate": "2026-10-01", "url": "u", "illustrative": 1, "excerpt": "x" * 400},
            {"source": "FEDERAL_REGISTER", "title": "B", "publicationDate": None, "url": None, "excerpt": "short"},
        ],
    }
    out = json.loads(crewai_horizon.compact_feed(result, excerpt_chars=50))
    assert out["totalStatutesFetched"] == 2
    assert len(out["items"][0]["excerpt"]) == 50
    assert out["items"][0]["illustrative"] is True and out["items"][1]["illustrative"] is False
    assert out["items"][0]["published"] == "2026-10-01"


def test_crewai_mcp_tools_wrap_the_client_and_shape_feed_results(stub):
    feed = {
        "totalStatutesFetched": 1,
        "items": [{"source": "EUR_LEX", "title": "T", "publicationDate": "2026-01-01", "url": "u", "illustrative": False, "excerpt": "e" * 600}],
    }
    client = stub(
        "lex-statute-ingest-mcp",
        {"fetch_live_regulatory_feed": feed, "parse_dpa_contract_clause": {"clauseType": "retention"}},
    )
    tools = {t.name: t for t in crewai_horizon.mcp_tools(client)}
    assert set(tools) == {"fetch_live_regulatory_feed", "parse_dpa_contract_clause"}

    shaped = json.loads(tools["fetch_live_regulatory_feed"]._run(jurisdiction="ALL", limit=None))
    assert shaped["items"][0]["title"] == "T" and len(shaped["items"][0]["excerpt"]) == 280
    # None-valued kwargs are dropped before the MCP call; the feed tool's result is compacted.
    assert client.calls[0] == ("fetch_live_regulatory_feed", {"jurisdiction": "ALL"})

    raw = json.loads(tools["parse_dpa_contract_clause"]._run(clause="keep 30 days"))
    assert raw == {"clauseType": "retention"}
    assert client.calls[1] == ("parse_dpa_contract_clause", {"clause": "keep 30 days"})


def test_crewai_horizon_kickoff_against_a_stub_llm(stub, monkeypatch):
    """A stubbed OpenAI-compatible endpoint drives one tool call, then the JSON final answer.

    An unrecognized model name makes CrewAI fall back to its text ReAct loop, so the replies use
    the Thought/Action/Final Answer format rather than native tool calls."""
    feed = {
        "totalStatutesFetched": 1,
        "items": [{"source": "EUR_LEX", "title": "AI Act corrigendum", "publicationDate": "2026-10-27", "url": "u", "illustrative": True, "excerpt": "Corrects Article 14."}],
    }
    answer = {"summary": "One illustrative EUR-Lex corrigendum.", "keyFacts": ["EUR-Lex: AI Act corrigendum"], "confidence": 0.7}
    replies = [
        {"role": "assistant", "content": 'Thought: I need the regulatory feed first.\nAction: fetch_live_regulatory_feed\nAction Input: {"jurisdiction": "ALL"}'},
        {"role": "assistant", "content": "Thought: The feed is in.\nFinal Answer: " + json.dumps(answer)},
    ]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            reply = replies.pop(0) if replies else {"role": "assistant", "content": "Thought: Done.\nFinal Answer: " + json.dumps(answer)}
            body = json.dumps({
                "id": "c1", "object": "chat.completion", "created": 0, "model": "stub",
                "choices": [{"index": 0, "message": reply, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("OPENAI_API_BASE", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "stub")
    try:
        client = stub("lex-statute-ingest-mcp", {"fetch_live_regulatory_feed": feed})
        out = crewai_horizon.run(client, model="openai/stub")
        assert isinstance(out, AgentOutput) and out.confidence == 0.7
        # The stub tool advertises an empty input schema, so its args are validated away.
        assert [c[0] for c in client.calls] == ["fetch_live_regulatory_feed"]
    finally:
        server.shutdown()


def test_dspy_deontic_react_calls_the_compiler_tool_and_returns_typed_output(stub, monkeypatch):
    from dspy.utils import DummyLM

    answers = [
        {"next_thought": "Compile the clause.", "next_tool_name": "compile_clause_to_deontic_logic", "next_tool_args": {"clause": "Data must be purged within 24 hours."}},
        {"next_thought": "Have the compilation.", "next_tool_name": "finish", "next_tool_args": {}},
        {"reasoning": "The tool returned the deontic assertions.", "result": {"summary": "Obligation to purge within 24h.", "keyFacts": ["24 hours"], "confidence": 0.9}},
    ]
    monkeypatch.setattr(dspy_deontic, "make_lm", lambda model=None: DummyLM(answers))
    client = stub("lex-deontic-compiler-mcp", {"compile_clause_to_deontic_logic": {"obligations": ["O(purge_24h)"], "smt2": "(assert true)"}})
    out = dspy_deontic.run("Data must be purged within 24 hours.", client)
    assert out.summary == "Obligation to purge within 24h." and out.keyFacts == ["24 hours"] and out.confidence == 0.9
    assert client.calls[0] == ("compile_clause_to_deontic_logic", {"clause": "Data must be purged within 24 hours."})


def test_openai_agents_returns_typed_output_when_the_model_skips_the_handoff(stub):
    # Regression: a model that answers directly (no handoff to the reviewer) returned a bare string.
    from agents import OpenAIChatCompletionsModel, set_tracing_disabled
    from openai import AsyncOpenAI

    from lexcompiler_agents import openai_agents_remediation

    answer = {"summary": "Patched 5 files; post-patch Z3 is SAT_COMPLIANT.", "keyFacts": ["SAT_COMPLIANT"], "confidence": 0.9}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            body = json.dumps({
                "id": "c1", "object": "chat.completion", "created": 0, "model": "stub",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(answer)}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    set_tracing_disabled(True)
    try:
        client = stub("lex-remediation-pr-mcp", {"synthesize_remediation_pr": {"postPatchStatus": "SAT_COMPLIANT"}})
        llm = AsyncOpenAI(base_url=f"http://127.0.0.1:{server.server_port}/v1", api_key="stub")
        out = openai_agents_remediation.run(client, OpenAIChatCompletionsModel(model="stub", openai_client=llm))
        assert isinstance(out, AgentOutput) and out.keyFacts == ["SAT_COMPLIANT"]
    finally:
        server.shutdown()
