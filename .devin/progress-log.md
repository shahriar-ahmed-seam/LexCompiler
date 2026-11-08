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

## Next priorities (from HANDOFF + architecture map)
1. Deployment readiness: build prod Docker image, run `docs/DEPLOY.md` checklist locally (no deploy).
2. Webhook emit-point e2e test gap ("no test drives the scan-job emit point end to end") — optional test hardening.
3. Crew runs in engine console `/lab` (`GET /api/agents/crew/runs`) — optional.

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
