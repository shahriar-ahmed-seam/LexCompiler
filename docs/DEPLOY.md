# Putting LexCompiler online

Phase 7 of `docs/PRODUCT_GUIDE.md`: a public HTTPS address for outside testers. There are two ways:

- **Quick:** a Cloudflare tunnel to the server on your machine. The URL changes each time.
- **Stable:** a small VPS running the Docker image behind Caddy.

Whichever you use, go through the checklist at the end before anyone else signs in.

## Settings that matter online

| Variable | Why |
|---|---|
| `LEXCOMPILER_PUBLIC_URL` | The `https://` address people use. Links in check runs, share links and the MCP URL are built from it. With `https://`, plain HTTP is redirected and HSTS is sent. |
| `LEXCOMPILER_TRUST_PROXY` | Trust the proxy's `X-Forwarded-*` headers, so the app sees the client's address (rate limits, share view log) and that the request came over HTTPS. `loopback` for a tunnel on the same machine; `1` for Caddy in the compose file. Without it set explicitly, HTTPS redirects stay off and a warning is logged (the default loopback trust only serves client addresses; a proxy that is not on loopback needs an explicit value). |
| `HOST` | `0.0.0.0` (or the interface) to listen beyond this machine. The server then refuses to start without `LEXCOMPILER_API_TOKEN` or OIDC, and refuses the runtime sandbox. |
| `LEXCOMPILER_API_TOKEN`, `LEXCOMPILER_OIDC_*` | A public server needs sign-in or a token. OIDC sessions and the token both pass the `/api` guard. |
| `LEXCOMPILER_ALLOWED_ORIGINS`, `LEXCOMPILER_ALLOWED_HOSTS` | The public origin and host name. |
| `LEXCOMPILER_RATE_LIMITS` | Requests per minute per client: `webhooks=600,share=120,signin=30` (the defaults). `/mcp` has its own limit per token (60 a minute). |
| `LEXCOMPILER_BACKUP_DIR` | Turns on the daily backup: a `VACUUM INTO` copy of the database plus the signing keys (the server's and each workspace's, `workspace-keys/`), trusted keys, revocations and GitHub App credentials, in a dated folder; the newest 14 are kept. `npm run backup` makes one now. |
| `LEXCOMPILER_SCHEDULER` | `off` stops the daily jobs (regulation feed, scans of every default branch, backup, timestamps). |
| `LEXCOMPILER_TSA_URL` | An RFC 3161 Time-Stamp Authority (for example `https://freetsa.org/tsr`). Once a day it vouches for each workspace's newest evidence header; share pages show it, and evidence packs carry the token and the header for `openssl ts -verify`. |

Routes outside the `/api` guard, by design:
- `/api/github/webhooks` (signed by GitHub);
- `/api/share/*` and `/.well-known/lexcompiler/*` (share links need no account);
- `/mcp` (its own tokens);
- `/api/health`.

## Quick: Cloudflare tunnel

1. Start the server as usual, then the tunnel:

   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```

2. Note the `https://….trycloudflare.com` URL it prints, and restart the server with:

   ```bash
   LEXCOMPILER_PUBLIC_URL=https://<name>.trycloudflare.com
   LEXCOMPILER_TRUST_PROXY=loopback
   LEXCOMPILER_ALLOWED_ORIGINS=https://<name>.trycloudflare.com
   LEXCOMPILER_ALLOWED_HOSTS=<name>.trycloudflare.com
   LEXCOMPILER_OIDC_REDIRECT_URI=https://<name>.trycloudflare.com/api/auth/callback
   ```

3. Point the GitHub App's webhook URL at `https://<name>.trycloudflare.com/api/github/webhooks` (smee is no longer needed), and add the redirect URI to Keycloak.

The tunnel URL changes when `cloudflared` restarts, so all three places need updating each time. Use the VPS for anything longer than a session.

## Stable: a VPS with Caddy

Requirements: a VPS with Docker, and a DNS name pointing at it (ports 80 and 443 open).

```bash
git clone https://github.com/MRSHAKILS/LexCompiler.git && cd LexCompiler
cp deploy/env.production.example deploy/.env.production   # fill it in; never commit it
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
```

- **Caddy** gets the certificate for `LEXCOMPILER_DOMAIN` and forwards to the app. Only Caddy publishes ports.
- **Data:** the database, signing key and GitHub App credentials live on the `lexcompiler-data` volume. Backups go to `lexcompiler-backups`; copy that volume off the machine as well, for example nightly with `docker run --rm -v deploy_lexcompiler-backups:/b alpine tar c /b > backups.tar` (Compose names the volume after the `deploy` folder; `docker volume ls` shows it).
- **GitHub App:** register it from the server (`https://<domain>/github/register`) or set its values in the env file. Then install it on the test repository.
- **Coding assistants:** update the MCP URL to `https://<domain>/mcp` in each one (guide, section 5.9).

### First deploy, step by step

Never put a server on the internet before? The whole thing is: rent a small Linux machine, point a name at it, run a few commands, walk the checklist below. Budget about an hour, most of it waiting for the image to build.

1. **Rent a VPS.** Any provider works — Hetzner (CX22, ~€4/month) or DigitalOcean ($6 droplet) are the cheap common picks. Choose **Ubuntu 24.04**. When it asks for an SSH key, paste the public half of a key made with `ssh-keygen -t ed25519` (creates `~/.ssh/id_ed25519`; the `.pub` file is the public half). Note the machine's IP address.
2. **Point a name at it.** Caddy cannot get a certificate for a bare IP, so a real DNS name is required. In the domain's DNS page, add an `A` record: `lexc` → the IP, giving `lexc.example.com`. No domain? A free DuckDNS subdomain works for a trial.
3. **Connect:** `ssh root@<ip>` (or the user the provider gave). Everything below runs on the VPS.
4. **Install Docker and a firewall:**

   ```bash
   apt update && apt install -y docker.io docker-compose-v2 git ufw
   ufw allow 22,80,443/tcp && ufw --force enable
   ```

5. **Clone and configure** (the commands from the section header). In `deploy/.env.production`: set the four domain lines, and generate the token on the VPS with `openssl rand -base64 32`.
6. **Pick a sign-in mode.** The compose stack has no OIDC provider, so a first deploy uses the built-in password sign-in: `LEXCOMPILER_SIGN_IN=password`. Keycloak or another OIDC provider can be added later. Then start the stack (the first build takes several minutes; `docker compose -f deploy/docker-compose.prod.yml logs -f` watches it — the app is up once Caddy gets the certificate, which retries until the DNS record resolves).
7. **Create the sign-in accounts** (once, still on the VPS):

   ```bash
   docker compose -f deploy/docker-compose.prod.yml exec lexcompiler \
     node dist-server/server/cli/seed-demo.js --accounts
   ```

   Passwords are written to `demo-accounts.txt` in the data volume (mode 0600). Read them with `docker compose -f deploy/docker-compose.prod.yml exec lexcompiler cat /app/data/demo-accounts.txt`, hand each person their own, and treat that file like a secret.
8. **Walk the checklist below** — every line of it — before sharing the URL.
9. **Extras, when wanted:** the GitHub App (`https://<domain>/github/register` from a signed-in browser, then install it on the test repository); `LEXCOMPILER_LLM_*` for cloud models; OIDC to replace password sign-in.
10. **Local models:** the polyglot-AST agent expects a local Ollama, which the compose file does not include. To add one, run it on the app's own network — never publish port 11434, Ollama has no sign-in:

    ```bash
    docker run -d --name ollama --network deploy_default ollama/ollama
    docker exec ollama ollama pull qwen2.5-coder:7b
    ```

    then set `OLLAMA_HOST=http://ollama:11434` in `deploy/.env.production` and restart. The other agents and all deterministic features run without it.
11. **Updating later:** `cd LexCompiler && git pull`, then the same `docker compose … up -d --build` line. Data survives in the volumes; a dated backup appears in the backups volume once a day.

## Before anyone else uses it

- [ ] HTTPS only: `LEXCOMPILER_PUBLIC_URL` starts with `https://` and `LEXCOMPILER_TRUST_PROXY` is set. `curl -I http://<domain>/` redirects (Caddy, 308); responses carry `Strict-Transport-Security`.
- [ ] Sign-in cookies are `Secure`: they are, whenever the OIDC redirect URI is `https://`.
- [ ] Without a token, `curl https://<domain>/api/state` answers 401. A signed-in browser still loads `/legal`.
- [ ] Outside the guard: `curl https://<domain>/api/share/x` answers 404 (not 401), and GitHub's webhook deliveries succeed.
- [ ] The runtime sandbox is off (the server refuses to start otherwise on a public host).
- [ ] No secrets in the repository: `deploy/.env.production` and `data/` are git-ignored.
- [ ] Backups: a folder appears in the backups volume within a day (or run `npm run backup`), and its `lexcompiler.db` opens.
- [ ] Rate limits: the 121st request to a share link within a minute from one address gets 429.
