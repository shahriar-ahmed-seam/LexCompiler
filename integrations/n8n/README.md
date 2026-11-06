# LexCompiler events in n8n

LexCompiler can send a signed JSON event to one URL per workspace. This folder has an n8n workflow
that receives those events, checks their signature, turns each into a short plain-English message
and answers `200`. Slack and email nodes are in the workflow but switched off, so it runs without
any credentials; enable them when a team wants the messages.

The workflow file is `lexcompiler-events.workflow.json` (also served by `GET /api/workflows/n8n-export`).

## Events

| Event | Sent when | Main fields in `data` |
| :--- | :--- | :--- |
| `scan.completed` | A scan finishes (GitHub check run or local repository) | `repository`, `commit`, `prNumber`, `conclusion`, `counts` (new, existing, waived), `rules`, `findings` (rule, path, line, state, message; at most 20), `url` |
| `regulation.watch` | The regulation watch finds a feed item that may affect rules | `title`, `link`, `source`, `matchedRules`, `summary` |
| `exception.requested` | Someone asks for an exception | `id`, `rule`, `repository`, `path`, `line`, `prNumber`, `status`, `requester`, `url` |
| `exception.decided` | Legal approves or rejects an exception | the same, plus `expiresAt` and `decisionNote` |
| `webhook.test` | You send a test event | `message`, `url` |

Every request is a `POST` of `{ "id", "type", "workspaceId", "createdAt", "data" }` with these headers:

- `X-LexCompiler-Event`: the event type
- `X-LexCompiler-Delivery`: the event id
- `X-LexCompiler-Signature`: `sha256=` and the hex HMAC-SHA256 of the raw body, keyed with the webhook secret
- `User-Agent: LexCompiler-Webhooks/1`

Events never contain source code, snippets or secrets. A receiver that answers anything but 2xx gets
the event again (the job queue retries with backoff); after the last attempt the delivery shows as
`failed` in `GET /api/workspaces/<id>/webhook/deliveries`.

In the workflow, a `scan.completed` event is passed on only when it has new findings or the check
failed; clean scans are acknowledged and dropped.

## Run n8n locally with Docker

```bash
docker run -d --name n8n -p 5678:5678 \
  -e LEXCOMPILER_WEBHOOK_SECRET='<the secret from the PUT below>' \
  -e NODE_FUNCTION_ALLOW_BUILTIN=crypto \
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

The signature check is a Code node, so n8n needs two settings:

- `NODE_FUNCTION_ALLOW_BUILTIN=crypto` lets the node `require('crypto')`.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` lets it read `$env.LEXCOMPILER_WEBHOOK_SECRET`.

In n8n 2.x the Code node runs in a task runner. With the default (internal) runner these variables
on the n8n container are normally enough. If you run an external runner (`N8N_RUNNERS_MODE=external`),
set `NODE_FUNCTION_ALLOW_BUILTIN=crypto` on the runner container as well. If the node reports that
`crypto` is disallowed, or that access to env vars is denied, this is the cause.

The secret is only known after step 1 below, so either start the container after it, or recreate it
(`docker rm -f n8n`, then the same `docker run`; the volume keeps your workflows).

## Import and activate

Copy the file into the container and import it:

```bash
docker cp integrations/n8n/lexcompiler-events.workflow.json n8n:/tmp/
docker exec n8n n8n import:workflow --input=/tmp/lexcompiler-events.workflow.json
```

Or in the n8n editor (http://localhost:5678): Workflows, the menu next to "Create workflow",
"Import from file". Then open the workflow and switch it to **Active**. Only an active workflow
listens on the production URL `/webhook/lexcompiler`; the editor's "Listen for test event" uses
`/webhook-test/lexcompiler` instead.

## Point a workspace at it

Only a workspace owner can set the webhook. By default LexCompiler refuses to send events to
loopback and private addresses and to plain `http`, so a local n8n needs this on the LexCompiler server:

```bash
LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS=1
```

1. Set the webhook (the response contains the secret once; copy it into `LEXCOMPILER_WEBHOOK_SECRET` above):

   ```bash
   curl -X PUT http://127.0.0.1:3001/api/workspaces/<workspaceId>/webhook \
     -H 'Content-Type: application/json' -H 'X-LexCompiler-Client: cli' \
     -d '{ "url": "http://localhost:5678/webhook/lexcompiler" }'
   ```

   When LexCompiler itself runs in Docker, use `http://host.docker.internal:5678/webhook/lexcompiler`
   (or the Docker host's address). Add `"events": ["scan.completed", "exception.requested"]` to
   subscribe to some events only, and `"rotateSecret": true` to get a new secret.
   Add a session cookie or `Authorization` header as your sign-in requires.

2. Send a test event:

   ```bash
   curl -X POST http://127.0.0.1:3001/api/workspaces/<workspaceId>/webhook/test -H 'X-LexCompiler-Client: cli'
   ```

   The answer shows `status: delivered` and the receiver's status code. The execution appears in
   n8n under Executions, with the formatted message from the "Format webhook.test" node.

3. See recent deliveries: `GET /api/workspaces/<workspaceId>/webhook/deliveries`.
   Remove the webhook: `DELETE /api/workspaces/<workspaceId>/webhook`.

## How the signature is checked

The signature covers the exact bytes LexCompiler sent, so the workflow must see the raw body, not
the parsed JSON. The Webhook node has the option **Raw Body** on. With it, n8n keeps the unparsed body
as binary data in the property `data` (next to the parsed `body` in `json`). The "Verify signature"
Code node reads those bytes (`this.helpers.getBinaryDataBuffer(0, 'data')`, falling back to the
base64 text in `binary.data.data`), recomputes the HMAC-SHA256 with the secret and compares it to the
`x-lexcompiler-signature` header (n8n lowercases header names) with `crypto.timingSafeEqual`. A
wrong signature, or a body that is not available, goes to the "Respond 401" node.

If every request gets `401`, check, in this order: the secret in `LEXCOMPILER_WEBHOOK_SECRET` is the
one LexCompiler returned (rotate and copy again if unsure); Raw Body is on; the Code node's output
(`reason`) in the failed execution.

## Slack and email

The nodes "Slack (disabled)" and "Email (disabled)" take the `title`, `text` and `url` the format nodes
produce. To use one: open it, add your credential (Slack account, or SMTP), pick the channel or set the
addresses, and enable the node (right-click, Activate, or `D`). They run after "Respond OK" has the
message, so a Slack or SMTP error does not make LexCompiler retry the event.
