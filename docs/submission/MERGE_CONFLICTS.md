# Where the two versions of LexCompiler conflict

For Shakil Ahmed and Shahriar Ahmed Seam. Written October 31, 2026, from a trial merge of `MRSHAKILS/LexCompiler` (`main` at c9e8782) and `shahriar-ahmed-seam/LexCompiler` (`main` at 69a7b31). Nothing was changed on either `main`.

## The short version

Both versions start from PR #36 (the AI gateway). After that, each of you built the same product phases separately:

- **Shakil's fork** has 68 commits since then. It built the product guide's phases in order, one PR each: the legal workspace (`/legal`), scanning and fixes, the evidence log, contract and regulation changes, the agent crew on workspace repositories, regulation watch, and the fix agent.
- **Shahriar's repo** has 15 commits, 5 of them the agent PRs (#41, #42) from Shakil. Most of the rest is one large commit, `2b25d5b`, "the demo cycle": a full web app, password sign-in, a rule card, exceptions, MCP for coding assistants and a signed evidence log.

So the overlap isn't two people editing the same lines. **Rule cards, exceptions, evidence, MCP for assistants and sign-in each exist twice, built differently.** Git can't choose between them; you have to.

**15 files conflict.** Every other changed file merges cleanly. 23 files exist only in Shahriar's repo and 60 only in Shakil's, and those don't conflict at all, but many of them depend on code on their own side.

## The 15 conflicts

### Small: a few minutes each

| File | What differs | How to solve it |
|---|---|---|
| `.env.example` | Shakil's has one extra comment | Keep it |
| `server/crew.test.ts` | One timeout | Solved: both now use 60 s |
| `docs/PRODUCT_GUIDE.md` | 2 small hunks of status text | Keep both, reword |
| `docs/HANDOFF.md` | Both rewrote the status sections | Keep both histories under one heading |
| `server/security.ts` | Shakil's refuses to run the sandbox on a public host; Shahriar's allows password sign-in as a guard | **Keep both checks** |
| `server/github/checkRun.ts` | Shakil's adds `waiverLine`, `upcoming`; Shahriar's adds `waivers` | Keep `upcoming`; choose one waiver format (depends on exceptions below) |
| `server/github.test.ts` | Each expects a different check-run details URL | Follows the choice of web app |

### Medium: follow from the big decisions

| File | What differs |
|---|---|
| `server/github/webhooks.ts` | "Request exception": Shakil's calls `requestExceptionsFromCheckRun`; Shahriar's calls `deps.onRequestException` |
| `server/github/scanJob.ts` | 5 hunks. The scan's follow-up steps differ: Shakil's has AI explanations, suggestions and Coming up; Shahriar's has its own evidence and waiver steps |
| `src/main.tsx` | Which app opens: Shakil's `/legal` and `/settings`, or Shahriar's `ProductApp` |
| `server/index.ts` | 8 hunks. Each side wires up its own services; Shahriar's sets `trust proxy` always, Shakil's only through `LEXCOMPILER_TRUST_PROXY` |
| `server/product/router.ts` | 7 hunks. Different routes on each side (see below) |

### Hard: two different designs of the same thing

| File | Shakil's version | Shahriar's version | Why it can't just be merged |
|---|---|---|---|
| `server/db/migrations.ts` | 14 migrations | 6 migrations | **Migrations 4 to 6 share numbers but mean different things.** A database already at version 6 would skip the other side's tables |
| `server/evidence/log.ts` | `EvidenceRecord`, per-workspace signers, RFC 3161 timestamps, `verifyRecords` | `EvidenceEntry`, one signer, `verifyEntries`, used by the browser check | Two record formats. Keep one, and move the other's callers. Records already signed can't be rewritten |
| `server/product/ruleCard.ts` | `buildRuleCard`, questions, impact preview | `analyzeRule`, quote-checked model values, highlights | Different data shapes, and each web app expects its own |

## What only one side has

**Only in Shakil's fork:** the legal workspace with documents and clauses; regulation feed and watch; "Coming up"; counterparty path scopes; fix PRs and suggestions; AI explanations on PRs; the fix agent; the agent crew on workspace repositories and its panel; OAuth for MCP; RFC 3161 timestamps; Keycloak setup; voiceover and submission files; live runs on GitHub.

**Only in Shahriar's repo:**
- the full light web app (`src/product/`): Overview, Rules, Checks, Exceptions, Evidence, Assistants, Settings, Share;
- password sign-in (`server/auth/passwords.ts`, scrypt);
- `server/product/governance.ts`, `flows.ts`, `workspaceRoutes.ts`, `publicRoutes.ts`;
- share-page verification in the browser (Web Crypto);
- the model-extraction checks (41 correct / 2 wrong alone, 43 / 0 with the checks);
- `server/governance.test.ts`, the whole cycle over HTTP.

## Decisions you two need to make

1. **Which web app is the product?** Shahriar's `src/product` is more complete as an app; Shakil's `/legal` has more features. **Suggestion:** keep `src/product` as the shell and add Shakil's features to it as pages.
2. **Which evidence log?** **Suggestion:** Shakil's, because it has per-workspace keys and timestamps. Then point Shahriar's share page at it.
3. **Which rule card?** **Suggestion:** Shakil's shape, plus Shahriar's quote-checked extraction, which has the measured results.
4. **Which exception flow?** They're close. Pick one set of routes.
5. **Sign-in:** these can coexist. Keep OIDC and password sign-in as options.

## Suggested merge plan (after the submission)

Don't try this today. On a new branch, with nothing else changing:
1. Make Shakil's `main` the base, because it has the longer history and the live runs.
2. Renumber Shahriar's migration 4 as new migrations after 14, keeping only what is missing (password sign-in tables and exception details). Treat existing databases as disposable test data, or write a one-time conversion.
3. Settle evidence, then the rule card, then exceptions, one PR each.
4. Bring `src/product` across and repoint it at the kept APIs, a page at a time. `server/governance.test.ts` is the test to get green.
5. Fix `index.ts`, `router.ts` and `scanJob.ts` as each step lands.
6. Run the full check after every step. Expect about 2 to 4 focused days.

## What this means for today's submission

- Submit `MRSHAKILS/LexCompiler`: the video, diagram and form notes describe it.
- Don't merge the two versions before the deadline. Half-merged code could break what works.
- The branch `mrshakils/full-work` on Shahriar's repo is an exact copy of Shakil's `main`, so both versions are in one place. **Don't merge that branch into `main`.** Its draft PR exists only so you can see the differences.
