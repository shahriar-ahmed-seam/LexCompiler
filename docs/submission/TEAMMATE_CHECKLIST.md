# Submission checklist for the teammate taking over

Written October 31, 2026, by Shakil Ahmed's working session. This is the one page to follow to finish the CloudCamp BD submission (International AI Builders Congress 2026).

**Deadline: October 31, 2026, 11:59 PM GMT+6, on cloudcampbd.com.**

## Where things are

| What | Where |
|---|---|
| Text for every form field | `docs/submission/FORM_NOTES.md` |
| Demo video (2:35, 1080p, English + Bangla voiceover) | `docs/video/lexcompiler-demo.mp4` |
| Narration script | `docs/video/narration.json` |
| Overview diagram | `docs/submission/lexcompiler-architecture.svg` (editable in Figma), `.png` (image) |
| Figma file | https://www.figma.com/design/8i5PbZ7o0PaigcqKQXlEWf/Untitled (Shakil's account) |
| Project state and live results | `docs/HANDOFF.md` |
| Full product guide | `docs/PRODUCT_GUIDE.md` |
| Scripts to re-record the video or redraw the diagram | `docs/video/tools/` |

**Two repositories exist, and they are not the same.**
- `MRSHAKILS/LexCompiler` is the complete product: legal workspace, agent crew on workspace repositories, regulation watch, fix agent, AI explanations.
- `shahriar-ahmed-seam/LexCompiler` has its own separate work, plus the agent crew from PRs #41 and #42.

They conflict in 15 files, because both built the same features separately. `docs/submission/MERGE_CONFLICTS.md` explains every conflict and the decisions you two need to make. Do not merge them before the deadline.

The video and the diagram show the complete product, so **submit `https://github.com/MRSHAKILS/LexCompiler` as the GitHub URL** unless the two are combined first. The form notes already say this.

## Must do, in order

### 1. Decide about the "one prompt only" rule (do this first)

The knowledge base says participants in the Zero to Launch and Idea to Unicorn prompt challenges must generate the whole system from **one master prompt** covering 8 modules, with only confirmations afterwards. LexCompiler was built over many sessions and pull requests.

- Check which track you are entering and whether the rule applies to it. If you aren't sure, ask the organizers.
- No master prompt exists yet. Don't describe one as what built the project: that would be false. If the form asks for it, either pick a track without the rule, or write it clearly as a specification of the system.

### 2. Watch the video, then upload it

- Watch all of `docs/video/lexcompiler-demo.mp4` with sound.
- Upload it to YouTube as **Public** or **Unlisted**, not Private. Paste the link into the form (10 points).
- Check these in the video:
  - around 2:00, the MCP screen's top cards show "Models: None Configured". This is because the recording server had no default model set; it isn't a fault, but re-record if you don't like it.
  - the Bangla line (about 2:12) sounds right to a Bangla speaker.
  - the two names at the end are spelled correctly.

### 3. Finish the Figma link (1 point)

Figma's connector could not import the diagram, so this is manual and needs Shakil's Figma account:
1. Drag `docs/submission/lexcompiler-architecture.svg` onto the canvas. Use the PNG if fonts shift.
2. Rename the file "LexCompiler Architecture".
3. Set **Share** to "Anyone with the link can view".
4. Open the link in a private window to confirm it works.

### 4. Fill in the team (up to 7 points)

Register every member (1 point each, up to 5). Claim the NRB and female-member bonuses only if they are true. This session did not know the team's details.

### 5. Live demo URL (1 point)

Nothing is hosted right now. Choose one:
- **Cloudflare tunnel from Shakil's laptop:** fast, but it works only while the laptop is on and awake, and it gets a new URL on each start. Commands are in "Run the live demo" below.
- **Hosting:** `Dockerfile` and `docs/DEPLOY.md` are ready but have never been deployed. Allow time for this.

If you can't keep a demo running, put the public check run in the form as well, so judges still see the product working: https://github.com/MRSHAKILS/finhealth-core-platform/runs/124146138632

### 6. Paste the form and submit

Copy from `docs/submission/FORM_NOTES.md`. Fields marked **(you)** there need your own answers:
- the YouTube, live demo and Figma URLs;
- the team;
- the frontend AI tools: tick only tools the team really used.

Then **check the character minimums** on the form: 50+ for token optimization, 80+ for the notes, 100+ for AI-DLC. All the drafts are longer.

## Check before you submit

- [ ] The YouTube link plays in a private window.
- [ ] The Figma link opens in a private window.
- [ ] The live demo link opens in a private window, if you give one.
- [ ] `https://github.com/MRSHAKILS/LexCompiler` is public and its README shows the diagram.
- [ ] The tick boxes match `FORM_NOTES.md`. **Don't tick anything we don't use.** The older draft guide from PR #15 ticks all 8 data sources, including IoT, which isn't true.
- [ ] AI-DLC: only Cursor Rules has files in the repo. BMAD, Spec-Kit and Kiro are named in `AGENTS.md`, but no such files exist, so don't claim them.
- [ ] Automation: LangGraph only, unless you add a real n8n workflow.
- [ ] Agent frameworks: Hermes, LangGraph, CrewAI, OpenAI Agents SDK. "OpenAI Swarm" is named in `AGENTS.md`, but the code uses the Agents SDK.
- [ ] Fine-tuning: say no weights were fine-tuned, as the notes do.

## Optional, only if there's time

| Item | Points | Note |
|---|---|---|
| A small real n8n workflow | +3 | For example, a webhook that posts regulation-watch results. `mcp-servers.example.json` has an n8n bridge entry, but n8n has never been run |
| A fifth agent framework | +1 | Only if it is really added |

## Run the live demo (on Shakil's laptop)

The live workspace lives in `data/live/`, which is **not on GitHub**. Keycloak is the Docker container `lexc-keycloak`.

```bash
docker start lexc-keycloak
```

```bash
LEXCOMPILER_DATA_DIR=data/live PORT=3002 LEXCOMPILER_OIDC_REDIRECT_URI=http://localhost:3002/api/auth/callback LEXCOMPILER_ALLOWED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002 LEXCOMPILER_GITHUB_WEBHOOK_URL=https://<tunnel>/api/github/webhooks LEXCOMPILER_TRUST_PROXY=loopback node --env-file=data/live/keycloak/oidc.env --env-file=data/live/agents.env --import tsx server/index.ts
```

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:3002
```

- After the tunnel starts, set the GitHub App's webhook URL to `https://<tunnel>/api/github/webhooks`.
- Over the tunnel, sign-in also needs the tunnel URL in `LEXCOMPILER_OIDC_REDIRECT_URI`, in `LEXCOMPILER_ALLOWED_ORIGINS`, and in the Keycloak client's redirect URIs. Test sign-in in a private window before you share the link.
- The dashboard takes up to a few minutes to load after a restart, because it computes its Z3 state. Open it once before judges do.
- The dashboard's demo buttons patch the tracked `target-repo/` files. Run `git checkout -- target-repo` before running tests.

**Without Shakil's laptop:** run `npm install`, `npm run setup:keycloak`, then `npm run seed:demo -- --activate-builtins`. You get a working demo workspace, but no GitHub App until you add credentials.

## Things that are private and not in Git

Get these from Shakil directly. Never paste them into an issue, PR or chat log.

- `.env`, `data/live/agents.env`: the DeepSeek key and agent settings.
- `.env.local`: the ElevenLabs key.
- `data/live/github-app.json`: the GitHub App's private key.
- `data/live/keycloak/credentials.json`: the test accounts' passwords. The form's access note offers these to judges on request.
- The CloudCamp knowledge-base MCP URL: it contains an access code.

## Limits to be honest about

- The built-in rules are illustrative paraphrases of the laws, labelled as such in the product. The product is not legal advice.
- The fix agent's suggestions pass the checks but can still be wrong: in the live run, two called encryption helpers that don't exist. They're never committed.
- The 1.5B DeepSeek-R1 model is unreliable; it's labelled advisory, and Z3 decides.
- The category guesser can misfile an item: GDPR Article 17 was classed as consent.
