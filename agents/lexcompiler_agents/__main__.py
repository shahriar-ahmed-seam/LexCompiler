"""python -m lexcompiler_agents <agent-id> [--model MODEL] [--query TEXT] [--clause TEXT] [--no-model]

Runs one agent against a running LexCompiler server. By default the agent's model is the server's agent
route (the model configured for that agent on the server); --model uses a framework model string
instead, with the provider key from this process's environment.
"""
from __future__ import annotations

import argparse
import importlib

from .mcp_client import AGENTS, McpClient


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("agent", choices=sorted(AGENTS))
    p.add_argument("--model", default=None, help="framework model string, e.g. gemini/gemini-2.5-flash (CrewAI) or openai:gpt-4o (Pydantic-AI)")
    p.add_argument("--query", default="Which code constructs violate the active clauses?")
    p.add_argument("--clause", default="PII must be encrypted at rest and purged within 72 hours.")
    p.add_argument("--no-model", action="store_true", help="agent-contextual-graph-rag only: answer from the retriever, without a model")
    a = p.parse_args()
    server, module = AGENTS[a.agent]
    mod = importlib.import_module(f".{module}", __package__)
    client = McpClient(server)
    if module == "langgraph_rag":
        from .llm import grounded_answer

        out = mod.run(a.query, client, llm_answer=None if a.no_model else grounded_answer(a.agent))
    elif module == "dspy_deontic":
        out = mod.run(a.clause, client, a.model)
    elif module == "pydantic_ai_critic":
        out = mod.run(a.model, client)
    else:
        out = mod.run(client=client, model=a.model)
    print(out.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
