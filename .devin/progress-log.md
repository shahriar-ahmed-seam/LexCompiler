# Devin dev-team progress log

Resume anchor: read this first, then `git status` / `git log --oneline -5`.

## Team config (validated 2026-11-08, `devin doctor` → 3 profiles loaded)
- `.devin/agents/lex-researcher.md` — `swe-2-low`, read-only (read/grep/glob/web_search)
- `.devin/agents/lex-implementer.md` — `swe-2-high` (was swe-2-max; repinned per model-optimization rule: Max reserved for lead/reviews), edit/write/exec
- `.devin/agents/lex-verifier.md` — `swe-2-high`, no write tools (read/grep/glob/exec)
- No `swe-2-flash` ID exists in devin 3000.12.28; swe-2 effort tiers are low/high/max (+ `-lightning` speed variants). No `medium` tier, no `reasoning:` frontmatter field.
- **Custom profiles can't spawn in a session that predates their creation** — activate next session. Fallback used: lead implements; never `subagent_general` (inherits parent SWE-2 Max).
- Promo/pricing status is only visible in the interactive `/model` picker + `/usage`; not queryable in-session. User should sanity-check `/usage` after the first real worker run.

## Done
- [x] Architecture map (commit ec44e55 baseline).
- [x] Subagent profiles created + doctor-validated.
- [x] Crew-run display research: endpoints exist (`GET /api/workspaces/:id/crew-runs[/:id]`, `view` perm), zero backend work needed.
- [x] Baseline: agentRoutes+workspaceCrew+crew+AgentCrewPanel tests = 33/33 green.
- [x] Feature: product "Agent runs" read-only tab on Checks page — branch `feat/product-crew-runs`.
      Files: `src/product/types.ts` (+CrewGate/CrewStep/CrewRunSummary/CrewRun), `src/product/CrewRunsPanel.tsx` (new), `src/product/pages/Checks.tsx` (4th tab), `src/product/CrewRunsPanel.test.tsx` (new, 5 tests).
      Verified: 5/5 new tests, baseline files still green, `tsc -p tsconfig.json --noEmit` clean, eslint clean.

## In flight (all need merge approval + Seam-repo sync after merge)
- PR #44 `feat/product-crew-runs` — "Agent runs" tab on Checks. **CI green.**
- PR #45 `feat/webhook-settings-ui` — "Webhooks" tab on Settings. **CI green.**
- PR #46 `feat/fedreg-fetch-button` — legal feed FedReg fetch button. **CI green.**
- PR #47 `test/crewai-dspy-adapters` — CrewAI+DSPy pytest coverage. CI failed: `requirements-test.txt` lacked crewai/dspy → added same pins as requirements.txt, pushed. Re-running.
- PR #48 `fix/record-lab` — record.mjs dashboard tab → /lab. **CI green.**
- PR #49 `fix/github-comment-escaping` — githubText() neutralizes @mentions/#refs/links/HTML in check summaries, annotations, review comments. CI running.
- PR #50 `docs/merge-notes-and-handoff` — HANDOFF + MERGE_CONFLICTS open-items closed; lost "Run it" notes restored. Docs only.

## PR summary (Nov 8) — all CI green except 51/52 pending (trivial)
- #44 crew-runs tab on Checks · #45 webhook Settings tab · #46 FedReg fetch button · #47 CrewAI/DSPy tests (+requirements-test fix) · #48 record.mjs→/lab · #49 githubText escaping · #50 HANDOFF/merge-notes updates · #51 .dockerignore (1.96GB→~40MB context) · #52 .devin/ profiles+log

## Deployment readiness validated (no deploy)
- `docker build -f Dockerfile` clean; container refuses 0.0.0.0 without token; health 200, /api/state 401→200 w/ token; HEALTHCHECK healthy; compose config valid.

## Remaining open items
- ~~Webhook emit-point e2e test gap~~ — done, PR #54 (scanLocalRepo + nightly + GitHub scanJob emit points, 5 tests).
- ~~Crew-runs in /lab~~ — done, PR #55 (`LabCrewRuns` on the MCP & Agents tab, stored `agent_crew_runs`, read-only).
- VPS deploy (needs approval + infra); emails-in-exception-bodies + viewers-read-evidence (product decisions).

## Status: DONE (Nov 8)
- Full local suite ran before merge: typecheck/lint/test (405/406 — ruleCardAnalyze load-flake, passes standalone)/verify:cli/verify:realworld/build + pytest 10/10.
- PRs #44–#52 all merged on origin (merge commits, `3118283`). Seam sync: shahriar-ahmed-seam/LexCompiler#48 merged after green CI; trees identical (`aed3555d`).
- Custom workers (lex-*) activate from a fresh session (profile registry snapshots at startup).

## Gotchas learned
- `src/contrast.test.tsx` enforces 4.5:1 text contrast on #fafafa for all `src/product/` files — never use text-zinc-400/300 for text there (icons in Links are fine).
- `.venv-agents`: `import dspy` before `import crewai` crashes numpy (`dtype("bool") not understood`); crewai must import first (documented in test_adapters.py header).
- Claude's handoff rules confirmed: two repos (origin MRSHAKILS + Seam's shahriar-ahmed-seam, push-by-URL, no remote) — after each merge to origin main, push main to a Seam branch + PR + merge. `git checkout -- target-repo` before tests. No AI-credit spend. Full pre-merge suite: typecheck lint test verify:cli verify:realworld build + pytest agents/tests.

## Next priorities (from HANDOFF + architecture map)
1. `docs/video/tools/record.mjs` should open `/lab`, not `/` (small).
2. Escaping Markdown and @mentions in GitHub comments (`server/github/`).
3. Leftover merge notes cleanup.
4. Deployment readiness: build prod Docker image, run `docs/DEPLOY.md` checklist locally (no deploy).
5. Crew runs in engine console `/lab` (`GET /api/agents/crew/runs` returns bundled-repo runs).

## Conventions to keep
- Branch → PR → CI green → merge; never push to main; local git identity only; no AI attribution trailers.
- `npm test` + `npm run verify:cli` minimum before merge; full gate = typecheck, lint, test, verify:cli, verify:realworld, build + pytest agents.
- No secrets (`data/`, `.env*`, `repos/`), no destructive DB ops, no model-provider changes inside LexCompiler.

## Status: Nov 9 — all PRs merged, repos synced
- PR #54 (scan.completed emit tests) + #55 (/lab crew runs) merged on origin after green CI; Seam sync #50 merged.
- PR #56 (evidence product decisions: keep emails in bodies, keep evidence on view; README line added) merged; Seam sync #51 merged. Trees identical: `70dc164`.
- `MERGE_CONFLICTS.md` "left open" list is now fully resolved.
- In flight: `docs/first-deploy` — DEPLOY.md first-deploy walkthrough + `LEXCOMPILER_SIGN_IN` in env example + HANDOFF status lines.
- **Remaining:** actual VPS deploy (needs owner: VPS + DNS name + go-ahead; walkthrough in DEPLOY.md); fresh-session check that lex-* workers spawn; `ruleCardAnalyze` proxy-flake fix (optional); demo-account rotation note for the VPS (covered by demo-accounts.txt guidance).
