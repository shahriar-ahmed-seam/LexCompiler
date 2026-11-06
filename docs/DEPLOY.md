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

## Before anyone else uses it

- [ ] HTTPS only: `LEXCOMPILER_PUBLIC_URL` starts with `https://` and `LEXCOMPILER_TRUST_PROXY` is set. `curl -I http://<domain>/` redirects (Caddy, 308); responses carry `Strict-Transport-Security`.
- [ ] Sign-in cookies are `Secure`: they are, whenever the OIDC redirect URI is `https://`.
- [ ] Without a token, `curl https://<domain>/api/state` answers 401. A signed-in browser still loads `/legal`.
- [ ] Outside the guard: `curl https://<domain>/api/share/x` answers 404 (not 401), and GitHub's webhook deliveries succeed.
- [ ] The runtime sandbox is off (the server refuses to start otherwise on a public host).
- [ ] No secrets in the repository: `deploy/.env.production` and `data/` are git-ignored.
- [ ] Backups: a folder appears in the backups volume within a day (or run `npm run backup`), and its `lexcompiler.db` opens.
- [ ] Rate limits: the 121st request to a share link within a minute from one address gets 429.
