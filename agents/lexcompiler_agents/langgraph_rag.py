"""agent-contextual-graph-rag: LangGraph state machine — retrieve, grade (CRAG), rewrite, answer."""
from __future__ import annotations

import sys
from typing import Callable, TypedDict

from langgraph.graph import END, START, StateGraph

from .mcp_client import AgentOutput, McpClient


class RagState(TypedDict, total=False):
    query: str
    attempts: int
    report: dict
    answer: AgentOutput


def build_graph(client: McpClient, llm_answer: Callable[[str, dict], AgentOutput] | None = None):
    def retrieve(state: RagState) -> RagState:
        report = client.call_tool_json("hybrid_contextual_graph_rag_query", {"query": state["query"], "topK": 4})
        return {"report": report, "attempts": state.get("attempts", 0) + 1}

    def grade(state: RagState) -> str:
        chunks = state["report"].get("retrievedChunks", [])
        good = any(c.get("cragVerdict") == "CORRECT_HIGH_CONFIDENCE" for c in chunks)
        return "answer" if good or state["attempts"] >= 2 else "rewrite"

    def rewrite(state: RagState) -> RagState:
        # Corrective RAG: fall back to the deontic rewrite the retriever proposed.
        return {"query": state["report"].get("rewrittenDeonticQuery") or f"{state['query']} obligations violations"}

    def answer(state: RagState) -> RagState:
        r = state["report"]
        if llm_answer:
            try:
                return {"answer": llm_answer(state["query"], r)}
            except Exception as err:  # the model is optional: fall back to the retriever's answer, and say so
                print(f"[agent-contextual-graph-rag] model answer failed, using the retriever's answer: {err}", file=sys.stderr)
        chunks = r.get("retrievedChunks", [])
        return {
            "answer": AgentOutput(
                summary=r.get("synthesizedNeuroSymbolicAnswer", "")[:400] or "No grounded answer.",
                keyFacts=[c["chunk"]["citationOrPath"] for c in chunks],
                confidence=float(r.get("ragasMetrics", {}).get("contextPrecision", 0)),
            )
        }

    g = StateGraph(RagState)
    g.add_node("retrieve", retrieve)
    g.add_node("rewrite", rewrite)
    g.add_node("answer", answer)
    g.add_edge(START, "retrieve")
    g.add_conditional_edges("retrieve", grade, {"answer": "answer", "rewrite": "rewrite"})
    g.add_edge("rewrite", "retrieve")
    g.add_edge("answer", END)
    return g.compile()


def run(query: str, client: McpClient | None = None, llm_answer=None) -> AgentOutput:
    return build_graph(client or McpClient("lex-hybrid-rag-mcp"), llm_answer).invoke({"query": query})["answer"]
