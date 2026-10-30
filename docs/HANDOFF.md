# LexCompiler handoff

Updated October 30, 2026, after PR #38. Judging is on **December 26, 2026**.

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

| Phase | Status |
|---|---|
| 0–2, 2a | Done |
| 3 Lawyer's workspace | Rule card, approval, versions, retirement, re-checks on approval. Not built: PDF/DOCX upload, clause splitting, counterparty scope |
| 4 Fixes and exceptions | Exceptions from GitHub, coding assistants and the web app; Legal decides with an expiry; PR comments; re-checks; expiry job. Not built: fix PRs, suggestion comments |
| 4a MCP for coding assistants | `POST /mcp` with personal tokens and five tools; tested from Kiro. Not built: `suggest_fix`, the 2026-07-28 protocol revision, OAuth |
| 5 Evidence and auditor | Signed, hash-chained log; share links; verification in the browser; public keys. Not built: zip pack with `verify.mjs`, RFC 3161 timestamps |
| 6 Contract and regulation changes | Not started |
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

Everything the demo needs is in `.env` (gitignored): password sign-in, the DeepSeek key for rule drafting only, the AI ceiling, the smee webhook URL, and a scratch copy of the fixture for the engine console.

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

- The DeepSeek key is set only for the `drafting` task (`LEXCOMPILER_AGENT_DRAFTING_*` in `.env`). Agents, the engine console and checks can't spend it. PR checks never call a model.
- A rule-card read costs about 290 tokens (well under $0.001). The workspace budget is capped by `LEXCOMPILER_AI_MAX_DAILY_TOKENS=15000`, about 50 reads a day.
- The balance was $0.87 on October 30. Check it with `curl -s https://api.deepseek.com/user/balance -H "Authorization: Bearer <key>"`.
- Extraction eval with DeepSeek (45 clauses): alone 41 correct and 2 wrong; with the checks 43 correct and 0 wrong. The table is in the product guide, section 5.3.

## Full check before a merge

```bash
for s in typecheck lint test verify:cli verify:realworld build; do npm run --silent $s || echo "FAILED: $s"; done
```

`server/governance.test.ts` runs the whole demo cycle against the API: sign-in, rule approval, MCP check and exception request, Legal's decision, evidence verification, a share link, and tampering detection.

## Next steps

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
