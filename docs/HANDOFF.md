# LexCompiler handoff

Updated October 30, 2026, after PR #40. Judging is on **December 26, 2026**.

**Current priority:** make the 6-agent crew in `AGENTS.md` real. Don't trim the claims in `AGENTS.md` or the README; build toward them. Where the work stands and what's left is in [The agent crew](#the-agent-crew).

This file covers where the work stands, how to run the demo, the demo-video script, and what's next. The full plan is in `docs/PRODUCT_GUIDE.md`: section 4 has the build phases, section 5 covers AI, RAG and MCP, and section 7 has the schedule.

## Working rules

- Every change goes branch → pull request with a detailed description → CI green → merge. Don't push to `main` directly.
- Before a merge, run the full check (below). `AGENTS.md` requires at least `npm test` and `npm run verify:cli`.
- Never commit secrets. `.env`, `data/` (database, GitHub App key, signing key, demo passwords) and `repos/` are gitignored.
- The 5 untracked files in `server/analyzer/` are the owner's analyzer rewrite, saved on the branch `wip/analyzer-ir`. Don't commit them.

## Where things stand

| PR | What it did |
|---|---|
| #29–#33 | Phases 0–2: merges, product database, GitHub App that checks pull requests |
| #34 | Product guide section 5: AI, RAG, MCP, setup for coding assistants |
| #35, #36 | Phase 2a: RAG embeddings, duration parser, honest labels, AI gateway, extraction eval |
| #37 | The demo cycle: the web app, password sign-in, the rule card with AI drafting, exceptions, the MCP server for coding assistants, the signed evidence log and share links |
| #38 | Copy fix: the empty Exceptions inbox now says "Legal decides" to non-Legal roles instead of "you decide" |
| #39 | Handoff update for #38 |
| #40 | Agent crew foundation: the server's agent model route with a daily budget, all six Python agents running against the live server, five of them on DeepSeek |

| Phase | Status |
|---|---|
| 0–2, 2a | Done |
| 3 Lawyer's workspace | Rule card, approval, versions, retirement, re-checks on approval. Not built: PDF/DOCX upload, clause splitting, counterparty scope |
| 4 Fixes and exceptions | Exceptions from GitHub, coding assistants and the web app; Legal decides with an expiry; PR comments; re-checks; expiry job. Not built: fix PRs, suggestion comments |
| 4a MCP for coding assistants | `POST /mcp` with personal tokens and five tools; tested from Kiro. Not built: `suggest_fix`, the 2026-07-28 protocol revision, OAuth |
| 5 Evidence and auditor | Signed, hash-chained log; share links; verification in the browser; public keys. Not built: zip pack with `verify.mjs`, RFC 3161 timestamps |
| 6 Contract and regulation changes | Not started |
| Agent crew (`AGENTS.md` §2) | Each agent runs on its own in its framework against the live server; five reach DeepSeek through the agent route. Not built: agents passing results to each other, the 7B local model for Hermes, a remediation PR opened on GitHub, the agents in the product screens |
| 7 Online | Password sign-in and a Cloudflare quick tunnel. Not built: a permanent deployment |

## The demo accounts

Four people in the workspace "FinHealth AI". The passwords are in `data/demo-accounts.txt` (mode 0600, gitignored). They are kept when the demo is reset; `--reset-passwords` makes new ones.

| Person | Email | Role | Shows |
|---|---|---|---|
| Arif Hossain, Engineering Manager | `arif@finhealth.example` | Owner | Overview, GitHub connection, AI setting, plan and usage |
| Nusrat Jahan, Head of Legal | `nusrat@finhealth.example` | Legal | Rule card, approvals, the exception inbox, share links |
| Tanvir Rahman, Backend Engineer | `tanvir@finhealth.example` | Engineer | Checks, requesting exceptions, coding-assistant tokens |
| Lena Fischer, Security Officer at Klinikum Spree | `lena@klinikum-spree.example` | Viewer | Everything, read-only; or the share link with no account |

GitHub's "Request exception" button maps the GitHub account `shahriar-ahmed-seam` to Tanvir (`--engineer-github`).

## Run the demo server

Everything the demo needs is in `.env` (gitignored): password sign-in, the DeepSeek key for rule drafting and five agents, the AI ceilings, the smee webhook URL, and a scratch copy of the fixture for the engine console.

```bash
# 1. Webhook relay (GitHub → this machine). The channel URL is in .env (LEXCOMPILER_GITHUB_WEBHOOK_URL).
npx -y smee-client@5.0.0 --url "$(grep ^LEXCOMPILER_GITHUB_WEBHOOK_URL= .env | cut -d= -f2)" \
  --target http://127.0.0.1:3001/api/github/webhooks

# 2. Build the web app once after pulling, then start the server.
npm run build
npx tsx --env-file=.env server/index.ts
# → "listening on http://127.0.0.1:3001 (sign-in required: email and password)"

# 3. Optional: a public HTTPS address for judges (changes on every start).
cloudflared tunnel --url http://localhost:3001
# Then restart the server with LEXCOMPILER_PUBLIC_URL=<that https URL>, so share links and
# GitHub check-run links use it.
```

- Open `http://localhost:3001` and sign in. The original demo screens are at `/lab` ("Engine console" in the sidebar).
- **If PR checks stop appearing,** the smee relay has probably stopped. Restart it, then redeliver the missed events from the GitHub App's settings (Advanced → Recent deliveries).
- **Kiro is already connected.** `~/.kiro/settings/mcp.json` points at `http://localhost:3001/mcp` with a 90-day token for Tanvir ("Kiro (demo laptop)"). If Kiro shows the server as disconnected, reconnect it from Kiro's MCP panel.

## Reset before recording

The evidence log is append-only, so a reset archives the workspace and starts a new one. Repositories and the demo people's coding-assistant tokens move over (Kiro stays connected), and old scans are deleted. Passwords stay the same.

```bash
npx tsx --env-file=.env server/cli/seed-demo.ts --fresh --demo --engineer-github shahriar-ahmed-seam
```

The running server then re-checks `main` and the open pull requests (about a minute). The new workspace starts with three rules approved (logging, AI review, data residency). The DPA retention clause is left for Nusrat to approve on camera, so PR #1 starts green.

Old comments stay on PR #1 on GitHub. For a clean timeline, open a new branch and pull request with `api/loan_applications.py` (product guide, Phase 2 test).

## The demo, scene by scene

About six minutes. Use two browser profiles, for Nusrat and Tanvir, plus a private window for Lena.

1. **Arif, Overview.** One repository connected, three rules in effect, the pull request passing, the activity feed. Settings → GitHub shows the installation; Settings → AI shows the cloud model, `deepseek-chat`, and the daily budget.
2. **Nusrat writes a rule.** Rules → New rule → "Klinikum Spree DPA §4.2" → Read the clause. The rule card shows "Confirmed. deepseek-chat read 72 hours from 'purged within 72 hours'. The quote is in the clause, and the parser read the same value", the plain reading, and "3 places would fail". Then **Approve and enforce**. To show the guard rail, try "Unclear clause": the card asks a question instead of guessing.
3. **GitHub.** Within a minute, PR #1's check turns red: "1 new finding (R-4)" at `api/loan_applications.py:20`, with a **Request exception** button. The ruleset blocks merging.
4. **Tanvir's coding assistant (Kiro).** Ask: *"Check my changes with LexCompiler before I commit."* `check_changes` reports what the PR check would report. Fix a new log line with `redact_pii`, and it passes. For the R-4 finding that can't be fixed yet, the assistant offers `request_exception`. Alternatively, click **Request exception** on GitHub. Either way, a bot comment appears on the PR.
5. **Nusrat decides.** The sidebar shows "Exceptions 1". Approve it for 30 days with a condition. The PR gets an "Exception approved" comment, the check re-runs and turns green, and its summary lists "Waived by Legal … until …" with the signed evidence record's hash.
6. **Lena audits.** Nusrat opens Evidence → Create share link → open it in the private window. No account is needed. Click **Verify in this browser**: every Ed25519 signature and hash link is checked in the auditor's browser. The page shows who approved each rule, every check, and the exception with its reason.
7. **Tanvir gets his key.** Coding assistants → create a token (shown once) → copy the configuration for Kiro, Claude Code, Cursor, VS Code, Codex, Claude Desktop or Antigravity. Recent assistant activity lists each tool call.

Each step was run on October 30 against the real GitHub repository. Two steps were driven differently than in the video: `request_exception` went through the MCP Inspector with Tanvir's token rather than from Kiro, and the GitHub button was simulated with a correctly signed `check_run.requested_action` webhook rather than clicked.

## AI and the DeepSeek budget

- **Where the key is used.** The DeepSeek key is set in `.env` for the `drafting` task (`LEXCOMPILER_AGENT_DRAFTING_*`) and, since #40, for five agents (`LEXCOMPILER_AGENT_<ID>_*`: horizon scanner, deontic extractor, contextual graph RAG, Z3 critic, remediation). PR checks never call a model.
- **Two separate caps.**
  - Rule drafting is capped per workspace by `LEXCOMPILER_AI_MAX_DAILY_TOKENS=15000`, about 50 rule-card reads a day. A read costs about 290 tokens.
  - All agents together are capped by `LEXCOMPILER_AGENT_MAX_DAILY_TOKENS=100000` cloud tokens per UTC day. Past it, the agent route answers 429 and the TypeScript runtime refuses too. 100,000 DeepSeek tokens cost about 3 cents.
- **What judges can spend.** Only rule drafting. The agent route is operator-only (judges get 403). The engine console no longer runs agent models when it opens.
- **Spend so far.** The balance was $0.87 in the morning and $0.85 after the agent work on October 30: 28 agent calls, 95,028 tokens. About half of that was one CrewAI run before its tool output was shortened (see Things that bite). Check the balance with `curl -s https://api.deepseek.com/user/balance -H "Authorization: Bearer <key>"`.
- **Extraction eval** with DeepSeek (45 clauses): alone 41 correct and 2 wrong; with the checks 43 correct and 0 wrong. The table is in the product guide, section 5.3.

## The agent crew

`AGENTS.md` §2 lists six agents, each in its own framework and with its own MCP server. The Python code is in `agents/lexcompiler_agents/`; the MCP servers are in `server/mcp/mcpSuite.ts` (one HTTP endpoint each, `/api/mcp/<server>/rpc`). The product guide, section 5.7, has the details.

**How a run works.** `python -m lexcompiler_agents <agent-id>` lists the tools of the agent's MCP server and lets the framework's agent call them. Every tool result comes from the real engine: the Z3 solver, the AST parsers, the RAG store, the remediation loop and the live EUR-Lex and Federal Register feeds. The agent's model call goes to the server's **agent route**, `POST /api/agents/llm/v1/chat/completions` (`relayAgentChat` in `server/ai/gateway.ts`). The route:
- takes the agent id as `model` and uses that agent's `LEXCOMPILER_AGENT_<ID>_*` model;
- keeps the provider key on the server, so the Python process never sees it;
- enforces the agents' daily budget and logs each call in `ai_calls` with the agent id as the task;
- accepts only the operator token (`LEXCOMPILER_API_TOKEN`);
- rewrites JSON-schema output for DeepSeek, which doesn't support it.

```bash
# Once: the frameworks (about 1.2 GB; the pins in agents/requirements.txt resolve together).
python3 -m venv .venv-agents && .venv-agents/bin/pip install -r agents/requirements.txt

# With the server running. The agents read LEXCOMPILER_URL and LEXCOMPILER_API_TOKEN from .env.
cd agents
../.venv-agents/bin/python -m lexcompiler_agents agent-z3-formal-critic
../.venv-agents/bin/python -m lexcompiler_agents agent-deontic-extractor --clause "Processor shall purge … within 72 hours …"
../.venv-agents/bin/python -m lexcompiler_agents agent-contextual-graph-rag --query "Which code keeps personal data longer than 72 hours?"
../.venv-agents/bin/python -m lexcompiler_agents agent-horizon-scanner
../.venv-agents/bin/python -m lexcompiler_agents agent-remediation-pr-enforcer
LEXCOMPILER_HERMES_MODEL=qwen2.5-coder:0.5b ../.venv-agents/bin/python -m lexcompiler_agents agent-polyglot-ast-mapper
```

**Runs on October 30** (fixture repository, `deepseek-chat`):

| Agent | Framework | Result | Cost |
|---|---|---|---|
| `agent-z3-formal-critic` | Pydantic-AI | All 4 clauses UNSAT, with unsat cores and file:line locations that match the Z3 tool | 2 calls, 3,008 tokens, 6 s |
| `agent-deontic-extractor` | DSPy ReAct | Read 72 hours and tenant-isolated keys from a DPA clause, with the SMT-LIB2 and Rego | 4 calls, 12,085 tokens, 12 s |
| `agent-contextual-graph-rag` | LangGraph | Named `schema/postgres_pii.sql:4` (720 h) from the retrieved chunks | 1 call, 979 tokens, 6 s |
| `agent-horizon-scanner` | CrewAI | Classified 13 live EUR-Lex and Federal Register items | 3 calls, 8,358 tokens, 14 s |
| `agent-remediation-pr-enforcer` | OpenAI Agents SDK | Patch for 5 files; post-patch Z3 SAT_COMPLIANT; reviewer handoff | 3 calls, 7,200 tokens, 8 s |
| `agent-polyglot-ast-mapper` | Hermes-style calls to Ollama | Ran to the end on `qwen2.5-coder:0.5b`, but the answer described the tool, not the scan. Needs a bigger local model | local, free |

**What `AGENTS.md` names but isn't true yet.** Keep these in mind when recording or writing the submission:
- **Models.** Each agent's model is a `.env` setting, so the named models can be used where a key exists. Two can't be used as named:
  - Claude 3.7 Sonnet was retired from the Anthropic API on February 19, 2026 ([Vercel AI SDK guide](https://sdk.vercel.ai/docs/guides/sonnet-3-7)).
  - OpenAI replaced Swarm with the Agents SDK ([openai/swarm](https://github.com/openai/swarm)), which is what agent 6 uses.
  - Today five agents run on `deepseek-chat`. DeepSeek's API currently answers that name with `deepseek-flash`. If the name stops working, switch to `deepseek-flash`, which also spends reasoning tokens.
- **Agent 3** names `Qwen-2.5-Coder-7B`; only the 0.5B model is installed.
- **Agent 4** names Llama-3.3-70B and BGE-Reranker. Neo4j and the reranker run only when `LEXCOMPILER_NEO4J_URL` and `LEXCOMPILER_RERANKER_MODEL` are set; by default the graph is in memory and there's no reranker.
- **Agent 6** names PR #409. The remediation tool builds and verifies a patch but opens no pull request (`prNumber: 0`). The GitHub App has `contents: read` only.
- **The crew** doesn't pass results between agents yet. Each run is independent and reads the bundled fixture.

**Next, in order:**
1. ~~**Chain the crew.**~~ Done: `server/agents/crew.ts` (`POST /api/agents/crew/runs`, stored in `agent_crew_runs`, migration 5) and `python -m lexcompiler_agents crew` (stored through `/api/agents/crew/runs/import`, with each agent's tokens from `ai_calls`). Handoffs come from tool results only. Guide 5.7 has the table. Still to do: show the runs in the engine console and the product screens.
2. **Hermes on a real model.** Pull `qwen2.5-coder:7b` (about 4.7 GB). This machine has 15 GB of RAM with little free while Chrome and Kiro run, so try `qwen2.5-coder:3b` if the 7B is too slow. Then re-run agent 3.
3. **Remediation opens a real PR.** Give the GitHub App `contents: write` and `pull_requests: write`, then open the verified patch as a pull request on `finhealth-core-platform`, but only when post-patch Z3 is SAT_COMPLIANT (the `AGENTS.md` §3 gate).
4. **Point agents at real repositories.** The six MCP servers read the bundled fixture and the demo clauses. Let a run take a workspace and repository, so the crew works on the repository and rules the judges see.
5. **Tests.** Add vitest cases for the agent route (403 for signed-in users, the budget's 429, `relayBody` for DeepSeek) and pytest cases for the CrewAI and DSPy adapters against a stub server.
6. **Product placement** (product guide, 5.7): the horizon scanner becomes Regulation watch (Phase 6), and the remediation agent becomes the fix agent (Phase 4).

## Full check before a merge

```bash
for s in typecheck lint test verify:cli verify:realworld build; do npm run --silent $s || echo "FAILED: $s"; done
.venv-agents/bin/python -m pytest -q agents/tests   # the Python agent adapters (CI runs this too)
```

`server/governance.test.ts` runs the whole demo cycle against the API: sign-in, rule approval, MCP check and exception request, Legal's decision, evidence verification, a share link, and tampering detection.

## Next steps

0. **The agent crew** (current priority): the list at the end of [The agent crew](#the-agent-crew).
1. **A permanent address for judges** (before December). The quick tunnel's URL changes on every start and depends on this machine. Options: a named Cloudflare tunnel on a domain, or a small VPS running `npm run build && npm start` with `data/` on a persistent disk (product guide, Phase 7).
2. **Phase 3 leftovers:** PDF/DOCX upload and clause splitting, and counterparty scope on the rule card.
3. **Phase 4 leftovers:** "Open fix PR" from the dashboard, and review comments with suggested changes.
4. **Phase 4a leftovers:** `suggest_fix`, and the 2026-07-28 protocol revision.
5. **Phase 5 leftovers:** a zip evidence pack with an offline `verify.mjs`.
6. **Phase 6:** Bangla addendum scoped to Nodi Microfinance, effective dates, and the regulation feed.

## Things that bite

- **The smee relay dies quietly.** If checks stop appearing on GitHub, check that it runs, then redeliver missed events. IDs in GitHub's delivery API can be larger than 2^53, so read them as strings.
- **DeepSeek doesn't accept `json_schema`.** The client sends `json_object` for `api.deepseek.com` automatically (`LEXCOMPILER_AGENT_<TASK>_JSON_MODE` overrides it).
- **With sign-in on, requests from this machine get no special rights.** A tunnel makes public requests arrive from loopback, so loopback can't mean "administrator". Scripts use `LEXCOMPILER_API_TOKEN` from `.env`.
- **The contrast test checks the light product app against #fafafa** and the engine console against its dark panels. Dark surfaces in the product live in `src/product/dark/`.
- **PGlite allows one process per data directory.** A second server on the same `data/` gets an in-memory vector store.
- **`node:sqlite` is a release candidate in Node 24.** Keep all SQL in `server/db` and the stores.
- **Use `localhost`, not `127.0.0.1`,** in the browser. Session cookies are tied to the host name.
- **DeepSeek's `json_object` mode stops tool calls.** With it set, the model writes JSON instead of calling tools, and the OpenAI Agents SDK failed with "Invalid JSON". The agent route sets `json_object` only when a request has no tools; otherwise the schema goes into the system prompt.
- **CrewAI sends every tool result again on each turn.** The first CrewAI run passed the full 11,000-character feed each time and used 52,248 tokens. `crewai_horizon.py` now shortens the feed and caps turns, and the run takes 8,358 tokens. Shorten any large tool result before a framework sees it (Hermes does the same for the AST scan).
- **CrewAI asks on its first run whether to upload traces,** and waits 20 seconds. The adapter turns the question off for its process, and telemetry is off too. The OpenAI Agents SDK's trace upload is off unless `LEXCOMPILER_AGENTS_TRACING=1`.
- **Small local models run on without a limit.** Hermes caps each answer (`num_predict`); without that, `qwen2.5-coder:0.5b` generated until the request timed out after 5 minutes.
- **An unknown `category` used to fall through to another clause template.** `compile_prose_to_smt_and_rego` turned a retention clause into a data-residency rule when DSPy passed `DATA_RETENTION`. The tool's schema now lists the valid categories.
- **`/lab?agentModels=1` spends model credit.** Without it, the engine console's agent steps call their tools directly.
