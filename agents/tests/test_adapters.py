import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from pydantic_ai.models.test import TestModel

from lexcompiler_agents import hermes_ast, langgraph_rag, pydantic_ai_critic
from lexcompiler_agents.mcp_client import AgentOutput


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
