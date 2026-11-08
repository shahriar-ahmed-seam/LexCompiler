# How the two versions of LexCompiler were merged

For Shakil Ahmed and Shahriar Ahmed Seam. The merge was done on November 7, 2026, on the branch `merge/seam-main`. It joins `shahriar-ahmed-seam/LexCompiler` (`main` at 69a7b31) into `MRSHAKILS/LexCompiler` (`main`). The file name is kept from the earlier conflict report, which this page replaces.

## The rule

Both repositories built the same features separately. For each feature we kept the better implementation and dropped the duplicate. Nothing was dropped without a reason. The table below gives the reason for each.

## What was kept

| Feature | Kept from | Why | What was dropped |
|---|---|---|---|
| Database migrations 1-14 | Shakil | They match the live database. | Shahriar's own copies of migrations 4-6 (reconciled, see below). |
| Users, tokens, MCP log, exceptions columns | Shahriar | The web app needs them. | Nothing. They are migrations 15-17. |
| Store (one SQL engine) | Shakil (`ProductStore`) | One place for all SQL. | Shahriar's duplicate SQL. `GovernanceStore` is now a thin adapter that keeps his method names. |
| Rule compiler and overrides | Shakil's override engine, with Shahriar's wider checks | One engine, five checked fields. | His inline bounds block. |
| Rule card | Shakil's rule card, with Shahriar's `analyzeRule` on top | Shakil's quote check and AI status are stronger. | A second card builder. His types were renamed (`AnalyzedRule`). |
| Evidence log | Shakil (`EvidenceLog`, `EvidenceRecorder`) | Signed per workspace, with Ed25519 and ECDSA. | His signer and his sync `append`. His list, count, verify and describe functions were added on top. |
| Exceptions, flows, GitHub comments | Shakil's async flows, with Shahriar's revoke and request text | One lifecycle for every way to ask. | His second request handler and the `pr_comment`-only job. |
| GitHub check run and scan job | Shakil | Full evidence line, member-checked `/scans/<id>`. | His redirect for `/scans/<id>` and his extra evidence line. |
| MCP server (`/mcp`) | Shakil's router and OAuth | It already supports three protocol versions and OAuth tokens. | His POST `/mcp` handler. His prose answers, optional repo, semantic search and client name were ported in. |
| Public share API | Both | Shakil's `/api/share`, plus Shahriar's `/api/public/share/<token>` as an adapter. | His `keys.json` route. |
| Web app | Shahriar | It is the better product screen. | Shakil's old dashboard stays as `/lab`. |
| Legal workspace and settings | Shakil | Not built on the other side. | Nothing. |
| Demo seed | Both | All flags of both sides work. | Nothing. |
| Security and proxy settings | Both | Both checks are kept. | The hourly expiry sweep (one sweep every 10 minutes now). |

## The database

- Migrations 1-14 are unchanged.
- Migration 15 adds to `users`: `password_hash`, `github_login`, `title` (with a unique index on `github_login`). It adds to `workspaces`: `plan` (default `pilot`) and `archived_at`.
- Migration 16 adds to `api_tokens`: `token_hint` (can be empty) and `last_client`. It adds to `mcp_calls`: `user_id`, `client`, `summary`. It fills `user_id` from the token owner.
- Migration 17 adds to `exceptions`: `rule_key` and `requester_label`. It fills `rule_key` from the rule. It changes the stored value `mcp` to `assistant`.
- `reconcileSeamLineage` fixes databases built by Shahriar's code. His migration 4 has another name and does not add Shakil's columns for 4-6. The function adds those columns, records migrations 4, 5, 6, 12, 13 and 15-17 where they apply, and lets the normal loop run the rest. It does nothing on databases from Shakil's code.
- Old unprefixed share tokens from Shahriar's databases no longer open. Shares now use the `lexc_share_` prefix. Reseed those databases.
- Evidence signed by Shahriar's single global key still verifies when the record header names that key. Reseeding is still the clean path.

## URLs after the merge

| URL | What it is |
|---|---|
| `/` | Shahriar's web app (sign-in needed) |
| `/legal` | Lawyer's workspace |
| `/settings` | Assistant settings |
| `/share/<token>` | Share page for auditors |
| `/lab` | The old dashboard |
| `/app/checks/<id>` | Check page, used as the `details_url` of check runs |
| `/scans/<id>` | Member-checked scan page, with a link to the web app |

## Review findings that were fixed

- Revoking a share twice no longer writes a second `share.revoked` record.
- The Shahriar legacy signing key is accepted by `keysFor`; HANDOFF has a reseed note.
- Approving a rule scanned the default branch twice. The `rules_changed` job now re-checks only open pull requests of repositories in scope.
- The HTTPS redirect is on only when `LEXCOMPILER_TRUST_PROXY` is set. Before, it could loop behind a proxy. `docs/DEPLOY.md` is updated.
- Open redirect through `returnTo` (for example `/\evil.example`) is closed with a shared `safeReturnPath` in sign-in and OIDC.
- `share.*` evidence bodies were visible in other shares. They now have no rules in scope, so no share or pack includes them.
- `docs/PRODUCT_GUIDE.md` showed `/scans/<id>` as the `details_url`; it now shows `/app/checks/<id>`.
- HANDOFF lost some headings in the merge. "What works today" is restored, and the duplicate headings are renamed.

## What is left open

- ~~`docs/video/tools/record.mjs` still opens `/` and waits for the old dashboard.~~ Fixed: it opens `/lab` now (November 8).
- ~~Some "Run it" and Ollama notes in HANDOFF were not added back.~~ Restored: the Node 24 / `gh` / Ollama requirements, the GitHub App bootstrap, and the seed variant are back in "Run the demo server" (November 8).
- ~~Emails inside exception bodies are visible through shares.~~ Decided (November 8): kept. Evidence bodies record who acted as `{ name, email, userId }` so a signed record identifies the person unambiguously; a name alone is not unique and a user id means nothing to an auditor. A share is a deliberate, scoped, expiring disclosure made by an owner or Legal, and the human-readable surfaces (share page, `report.html`) already show names first. The pack's `README.txt` now says bodies name who acted. Stripping emails would be irreversible for the records written meanwhile; keeping them is not.
- ~~Text typed by users (reason, client name, names) is not escaped for Markdown or @mentions in GitHub comments.~~ Fixed: `githubText` (`server/github/markdown.ts`) neutralizes mentions, issue refs, links and raw HTML in check summaries, annotations and review comments (November 8). The exception-request comment stays raw on purpose — a person may legitimately want an @mention there.
- ~~Viewers can read signed evidence bodies in the web app.~~ Decided (November 8): kept. `GET .../evidence` stays on `view`. The bodies hold nothing `view` does not already grant: members with emails (`/members`), exception reasons and deciders (`/exceptions`), findings by fingerprint (`/scans`), rule texts (`/rules`) and counterparties. The only addition is that a share was created or revoked (label, counterparty, period, by whom; never the token). The evidence log is the proof layer over data viewers already see, and an internal observer role is exactly who should be able to check it.

## How it was checked

- Typecheck and lint pass (15 old `any` warnings only).
- 60 test files, 326 tests pass.
- `npm run verify:cli`, `verify:realworld`, the build, and the agents pytest suite pass.
- A copy of the live database (version 14: 1 workspace, 4 rules, 16 evidence records, 2 exceptions) upgraded to version 17. Every row was kept, and all 16 evidence records verify afterwards.
