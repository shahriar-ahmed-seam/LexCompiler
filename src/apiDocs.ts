/**
 * Data behind the /lab "API Reference" tab: every HTTP surface this server exposes,
 * grouped the way docs.modelflare.dev groups them. Kept in code (not markdown) so the
 * view can render method badges, permission chips and copyable curl examples without a
 * docs pipeline. When a route changes, change it here too — the page is the contract.
 */

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Who may call an endpoint. The role map lives in server/product/store.ts (PERMISSIONS). */
export type ApiAccess =
  | 'signed-in' // any authenticated principal
  | 'view'
  | 'editRules'
  | 'runScans'
  | 'manageWorkspace'
  | 'decideExceptions'
  | 'requestExceptions'
  | 'createShares'
  | 'bearer' // session cookie or Authorization: Bearer <token>
  | 'public' // outside the sign-in guard by design
  | 'github-hmac' // GitHub signs the raw body
  | 'oauth' // part of the OAuth 2.0 flow
  | 'mcp-token'; // personal access token issued for /mcp

export interface ApiParam {
  name: string;
  in: 'path' | 'query' | 'body';
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiEndpoint {
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  summary: string;
  params?: ApiParam[];
  example?: string;
}

export type ApiBlock =
  | { kind: 'p'; text: string }
  | { kind: 'code'; label?: string; code: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] };

export interface ApiPage {
  id: string;
  title: string;
  intro?: string;
  blocks?: ApiBlock[];
  endpoints?: ApiEndpoint[];
}

export interface ApiSection {
  id: string;
  title: string;
  pages: ApiPage[];
}

export const API_SECTIONS: ApiSection[] = [
  {
    id: 'get-started',
    title: 'Get started',
    pages: [
      {
        id: 'introduction',
        title: 'Introduction',
        intro:
          'One HTTP surface backs the dashboard, the product app, the MCP endpoint and the GitHub App. Everything under /api sits behind the sign-in guard unless a page says otherwise.',
        blocks: [
          { kind: 'p', text: 'The base URL is wherever the server listens — http://localhost:3001 locally, or your public HTTPS domain (LEXCOMPILER_PUBLIC_URL) in production. All examples use http://localhost:3001.' },
          { kind: 'p', text: 'Request and response bodies are JSON. Workspace-scoped routes name the workspace in the path and check the caller\'s role in it — the badge on each endpoint shows the permission the router enforces (the role map is in server/product/store.ts).' },
          { kind: 'list', items: [
            'Session sign-in (password or OIDC) — for people in a browser.',
            'LEXCOMPILER_API_TOKEN or a personal access token — for scripts and the MCP clients.',
            'OAuth 2.0 — for coding assistants that connect to /mcp.',
            'Signed webhooks — GitHub proves deliveries with an HMAC secret.',
          ] },
        ],
      },
      {
        id: 'authentication',
        title: 'Authentication',
        intro: 'Four credentials reach the API. Every guarded route accepts a session cookie or a bearer token; MCP takes its own tokens.',
        blocks: [
          {
            kind: 'code',
            label: 'Bearer token (scripts)',
            code: `curl -H "Authorization: Bearer $LEXCOMPILER_API_TOKEN" \\
  http://localhost:3001/api/workspaces`,
          },
          {
            kind: 'code',
            label: 'Password sign-in (browser session)',
            code: `curl -c cookies.txt -X POST http://localhost:3001/api/auth/password \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"nusrat@finhealth.example","password":"<account password>"}'
# then send cookies.txt with later requests`,
          },
          {
            kind: 'table',
            headers: ['Credential', 'Where it works', 'How it\'s made'],
            rows: [
              ['Session cookie', 'Browser UI + /api', 'POST /api/auth/password or the OIDC flow'],
              ['LEXCOMPILER_API_TOKEN', 'All of /api', 'Set on the server (openssl rand -base64 32)'],
              ['Personal access token', 'All of /api + /mcp', 'POST /api/workspaces/:id/tokens (Settings → Assistants)'],
              ['OAuth access token', '/mcp only', '/oauth/authorize → /oauth/token (one hour, PKCE)'],
            ],
          },
          { kind: 'p', text: 'Rate limits: sign-in endpoints 30/min per client, share pages 120/min, GitHub webhooks 600/min, /mcp 60/min per token.' },
        ],
      },
      {
        id: 'quickstart',
        title: 'Quickstart',
        intro: 'The shortest useful path: prove the server is up, sign in, list your workspaces, and read one workspace.',
        blocks: [
          {
            kind: 'code',
            label: 'End-to-end in four calls',
            code: `# 1. Health (public — outside the guard)
curl http://localhost:3001/api/health

# 2. Sign in (creates a session cookie)
curl -c cookies.txt -X POST http://localhost:3001/api/auth/password \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"<you>","password":"<password>"}'

# 3. Your workspaces
curl -b cookies.txt http://localhost:3001/api/workspaces

# 4. One workspace (role comes back in the body)
curl -b cookies.txt http://localhost:3001/api/workspaces/<workspaceId>`,
          },
          { kind: 'p', text: 'Anything that reads returns the same shapes the UI consumes, so a script can drive the whole workflow: create a rule → scan a repo → open an exception → approve it → share an evidence pack.' },
        ],
      },
    ],
  },
  {
    id: 'workspaces',
    title: 'Workspaces & members',
    pages: [
      {
        id: 'workspaces',
        title: 'Workspaces',
        endpoints: [
          { method: 'GET', path: '/api/workspaces', access: 'signed-in', summary: 'Every workspace the caller belongs to, with their role in each.' },
          {
            method: 'POST', path: '/api/workspaces', access: 'signed-in', summary: 'Create a workspace; the creator becomes its owner.',
            params: [{ name: 'name', in: 'body', type: 'string', required: true, description: 'Display name.' }],
            example: `curl -X POST http://localhost:3001/api/workspaces \\
  -H 'Content-Type: application/json' -b cookies.txt \\
  -d '{"name":"Acme compliance"}'`,
          },
          { method: 'GET', path: '/api/workspaces/:workspaceId', access: 'view', summary: 'Workspace detail plus the caller\'s role.' },
        ],
      },
      {
        id: 'members',
        title: 'Members & roles',
        intro: 'Roles are per workspace. The permission column on every endpoint maps to this table.',
        blocks: [
          {
            kind: 'table',
            headers: ['Permission', 'owner', 'legal', 'engineer', 'viewer'],
            rows: [
              ['view', '✓', '✓', '✓', '✓'],
              ['runScans / requestExceptions', '✓', '✓', '✓', '—'],
              ['editRules / decideExceptions', '—', '✓', '—', '—'],
              ['createShares', '✓', '✓', '—', '—'],
              ['manageWorkspace', '✓', '—', '—', '—'],
            ],
          },
        ],
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/members', access: 'view', summary: 'Members with role, name and email.' },
          {
            method: 'POST', path: '/api/workspaces/:workspaceId/members', access: 'manageWorkspace', summary: 'Invite by email and role (201).',
            params: [
              { name: 'email', in: 'body', type: 'string', required: true, description: 'The person to invite.' },
              { name: 'role', in: 'body', type: 'owner | legal | engineer | viewer', required: true, description: 'Their role.' },
            ],
          },
          { method: 'PUT', path: '/api/workspaces/:workspaceId/members/:userId', access: 'manageWorkspace', summary: 'Change a member\'s role (404 if not a member).' },
          { method: 'DELETE', path: '/api/workspaces/:workspaceId/members/:userId', access: 'manageWorkspace', summary: 'Remove a member.' },
        ],
      },
    ],
  },
  {
    id: 'rules-scans',
    title: 'Rules & scans',
    pages: [
      {
        id: 'rules',
        title: 'Rules',
        intro: 'Rules are the compiled obligations a workspace enforces. Versions move through an approve gate before they take effect.',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/rules', access: 'view', summary: 'All rules in the workspace.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rules', access: 'editRules', summary: 'Draft a rule from a clause or document.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/rule-list', access: 'view', summary: 'Compact list form of the same rules.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rule-card', access: 'editRules', summary: 'Build the analysis card for one rule (Z3-backed).' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/rules-in-effect', access: 'view', summary: 'Only the rules currently enforced.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rule-versions/:versionId/approve', access: 'editRules', summary: 'Approve a rule version.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rule-versions/:versionId/reject', access: 'editRules', summary: 'Reject a rule version.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rule-versions/:versionId/effective', access: 'editRules', summary: 'Mark a version effective.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rules/:ruleId/rescope', access: 'editRules', summary: 'Change a rule\'s file/scope globs.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/rules/:ruleId/retire', access: 'editRules', summary: 'Retire a rule (it stops scanning).' },
          { method: 'GET', path: '/api/rule-categories', access: 'signed-in', summary: 'The rule taxonomy labels.' },
          { method: 'GET', path: '/api/library/templates', access: 'signed-in', summary: 'Built-in rule templates.' },
        ],
      },
      {
        id: 'repos-scans',
        title: 'Repos & scans',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/repos', access: 'view', summary: 'Repositories linked to the workspace.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/repos', access: 'manageWorkspace', summary: 'Link a repository.' },
          {
            method: 'POST', path: '/api/workspaces/:workspaceId/repos/:repoId/scan', access: 'runScans', summary: 'Scan a linked repo — queues one scan.completed webhook event when done.',
            example: `curl -X POST -b cookies.txt \\
  http://localhost:3001/api/workspaces/<id>/repos/<repoId>/scan`,
          },
          { method: 'GET', path: '/api/workspaces/:workspaceId/scans', access: 'view', summary: 'Scan history.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/scans/:scanId', access: 'view', summary: 'One scan with its findings (fingerprints, not code).' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/repos/:repoId/fix-prs', access: 'view', summary: 'Remediation PRs the crew opened for a repo.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/repos/:repoId/fix-pr', access: 'runScans', summary: 'Ask the fix agent for a remediation PR.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/repos/:repoId/crew-runs', access: 'runScans', summary: 'Run the six-agent crew on a repo.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/github', access: 'view', summary: 'GitHub App installations visible to the workspace.' },
        ],
      },
    ],
  },
  {
    id: 'exceptions',
    title: 'Exceptions',
    pages: [
      {
        id: 'exceptions',
        title: 'Exception requests',
        intro: 'An exception waives a finding — requested by engineers, decided by legal, signed into evidence either way.',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/exceptions', access: 'view', summary: 'All exception requests with status and expiry.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/exceptions', access: 'requestExceptions', summary: 'Request a waiver (reason required); emits exception.requested.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/exceptions/:exceptionId/approve', access: 'decideExceptions', summary: 'Approve; emits exception.decided and signs a record.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/exceptions/:exceptionId/reject', access: 'decideExceptions', summary: 'Reject; same event and record.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/exceptions/:exceptionId/expiry', access: 'view', summary: 'Read or refresh an expiry check.' },
        ],
      },
    ],
  },
  {
    id: 'evidence-shares',
    title: 'Evidence & shares',
    pages: [
      {
        id: 'evidence',
        title: 'Evidence',
        intro: 'Signed, hash-linked audit records. Bodies carry identifiers, fingerprints, locations and metadata — never source code.',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/evidence', access: 'view', summary: 'The workspace\'s signed evidence records.' },
        ],
      },
      {
        id: 'shares',
        title: 'Share links',
        intro: 'A share is a deliberate, scoped disclosure: a token-gated page with rules, scans, findings (no code), exceptions and evidence headers. Bodies name who acted — that\'s the point of a signed record.',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/shares', access: 'createShares', summary: 'Shares issued by the workspace.' },
          {
            method: 'POST', path: '/api/workspaces/:workspaceId/shares', access: 'createShares', summary: 'Create a share; the token is shown once.',
            params: [
              { name: 'counterpartyId', in: 'body', type: 'string', description: 'Limit to one counterparty.' },
              { name: 'ruleIds', in: 'body', type: 'string[]', description: 'Limit to rules.' },
              { name: 'days', in: 'body', type: 'number', description: 'Date range covered.' },
            ],
            example: `curl -X POST -b cookies.txt \\
  http://localhost:3001/api/workspaces/<id>/shares \\
  -H 'Content-Type: application/json' \\
  -d '{"days":90,"counterpartyId":"<counterpartyId>"}'`,
          },
          { method: 'POST', path: '/api/workspaces/:workspaceId/shares/:shareId/revoke', access: 'createShares', summary: 'Revoke a share.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/shares/:shareId/views', access: 'createShares', summary: 'Audit log of who viewed the share.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/counterparties', access: 'view', summary: 'Counterparties shares can be scoped to.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/counterparties', access: 'createShares', summary: 'Register a counterparty.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/counterparties/:counterpartyId/scope', access: 'editRules', summary: 'Set the rules a counterparty may see.' },
        ],
      },
      {
        id: 'public-share',
        title: 'Public share routes',
        intro: 'Outside the sign-in guard — the share token itself is the credential. Rate-limited to 120 requests a minute per client.',
        endpoints: [
          { method: 'GET', path: '/api/share/:token', access: 'public', summary: 'The share\'s scoped view (JSON or the web page). Unknown token → 404.' },
          { method: 'GET', path: '/api/share/:token/pack.zip', access: 'public', summary: 'Evidence pack download: records, keys, timestamps, verify.mjs.' },
          { method: 'GET', path: '/api/public/share/:token', access: 'public', summary: 'The share page for the web app shell.' },
          { method: 'GET', path: '/.well-known/lexcompiler/:workspaceId/keys.json', access: 'public', summary: 'The workspace\'s signing keys (only keys that signed records).' },
        ],
      },
    ],
  },
  {
    id: 'feed-inbox',
    title: 'Feed & inbox',
    pages: [
      {
        id: 'feed',
        title: 'Regulatory feed',
        intro: 'The horizon scanner\'s output. EUR-Lex text comes only from official Cellar interfaces; Federal Register text from its API — never scraped.',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/feed', access: 'view', summary: 'Feed items (limit query, default 100).' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/feed/watch', access: 'editRules', summary: 'Watch an item — queues regulation.watch events on change.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/feed/refresh', access: 'editRules', summary: 'Pull the feed now instead of on the schedule.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/feed/:itemId/draft', access: 'editRules', summary: 'Draft a regulation document from the item\'s excerpt.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/feed/:itemId/fetch-text', access: 'editRules', summary: 'Fetch the act\'s full text (Cellar or Federal Register API). Idempotent — reuses an existing fetch.' },
        ],
      },
      {
        id: 'inbox-docs',
        title: 'Inbox & documents',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/inbox', access: 'view', summary: 'The work queue for this workspace.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/coming-up', access: 'view', summary: 'Upcoming obligations computed from the rules.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/coming-up/refresh', access: 'runScans', summary: 'Recompute now.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/documents', access: 'view', summary: 'Regulation and contract documents.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/documents', access: 'editRules', summary: 'Upload a document (split into clauses).' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/documents/:documentId', access: 'view', summary: 'One document with its clauses.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/documents/:documentId/file', access: 'view', summary: 'The original file.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/documents/from-url', access: 'editRules', summary: 'Import a document by URL (Browserbase Fetch when configured).' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/integrations', access: 'view', summary: 'Connected integrations (GitHub, n8n, MCP).' },
        ],
      },
    ],
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    pages: [
      {
        id: 'outbound',
        title: 'Outbound events',
        intro: 'One webhook per workspace. Every event is a signed JSON POST; the secret is shown once, on create or rotate.',
        blocks: [
          {
            kind: 'table',
            headers: ['Event', 'Emitted when'],
            rows: [
              ['scan.completed', 'A repo scan finishes (API, MCP, GitHub job, or nightly)'],
              ['regulation.watch', 'A watched feed item changes'],
              ['exception.requested', 'Someone files an exception'],
              ['exception.decided', 'Legal approves or rejects it'],
              ['webhook.test', 'POST .../webhook/test'],
            ],
          },
          {
            kind: 'p', text: 'Signature: X-LexCompiler-Signature: sha256=<HMAC-SHA256 of the raw body>. Deliveries retry through the job queue with a 10 s deadline each; the log is at GET .../webhook/deliveries. Private addresses and plain http need LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS=1.',
          },
        ],
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/webhook', access: 'manageWorkspace', summary: 'The webhook config (no secret) and available event types.' },
          {
            method: 'PUT', path: '/api/workspaces/:workspaceId/webhook', access: 'manageWorkspace', summary: 'Set URL and subscribed events; rotateSecret returns a new secret once.',
            params: [
              { name: 'url', in: 'body', type: 'string', required: true, description: 'HTTPS endpoint (checked against private-address rules).' },
              { name: 'events', in: 'body', type: 'string[]', description: 'Subset of the five event types; default all.' },
              { name: 'rotateSecret', in: 'body', type: 'boolean', description: 'Issue a new secret.' },
            ],
            example: `curl -X PUT -b cookies.txt \\
  http://localhost:3001/api/workspaces/<id>/webhook \\
  -H 'Content-Type: application/json' \\
  -d '{"url":"https://n8n.example.com/webhook/lexc","events":["scan.completed","exception.decided"]}'`,
          },
          { method: 'DELETE', path: '/api/workspaces/:workspaceId/webhook', access: 'manageWorkspace', summary: 'Remove the webhook.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/webhook/test', access: 'manageWorkspace', summary: 'Send webhook.test (one at a time, ~5 s cooldown).' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/webhook/deliveries', access: 'manageWorkspace', summary: 'Delivery log with status and attempts.' },
        ],
      },
      {
        id: 'inbound-github',
        title: 'Inbound: GitHub',
        intro: 'GitHub proves deliveries with the App\'s webhook secret; the raw body is verified before parsing. Rate-limited to 600/min.',
        endpoints: [
          { method: 'POST', path: '/api/github/webhooks', access: 'github-hmac', summary: 'Check runs, pushes and comment commands. Drives the same scan pipeline as the API.' },
        ],
      },
    ],
  },
  {
    id: 'agents-ai',
    title: 'Agents & AI',
    pages: [
      {
        id: 'ai-settings',
        title: 'AI settings & usage',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/ai', access: 'view', summary: 'Mode, budget, tokens used today, and which models each mode would use.' },
          { method: 'PUT', path: '/api/workspaces/:workspaceId/ai', access: 'manageWorkspace', summary: 'Set mode and daily token budget.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/ai/calls', access: 'view', summary: 'Recent model calls (limit query, default 50).' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/assistant-calls', access: 'view', summary: 'Assistant-initiated calls.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/usage', access: 'view', summary: 'Token/cost usage rollup.' },
        ],
      },
      {
        id: 'crew',
        title: 'Agent crew',
        intro: 'The six-agent neuro-symbolic crew. Workspace runs are scoped to a repo; the global endpoints list every stored run including imported Python-crew runs.',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/crew-runs', access: 'view', summary: 'Runs against this workspace\'s repos.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/crew-runs/:runId', access: 'view', summary: 'One run with every step.' },
          { method: 'GET', path: '/api/agents/crew/runs', access: 'bearer', summary: 'All stored runs (workspace IS NULL: demo + imported Python runs).' },
          { method: 'GET', path: '/api/agents/crew/runs/:id', access: 'bearer', summary: 'One stored run with steps.' },
          { method: 'POST', path: '/api/agents/crew/runs', access: 'bearer', summary: 'Start a demo crew run on the bundled clauses.' },
          { method: 'POST', path: '/api/agents/crew/runs/import', access: 'bearer', summary: 'The Python crew reports a finished run here.' },
        ],
      },
      {
        id: 'llm-gateway',
        title: 'LLM gateway',
        endpoints: [
          { method: 'POST', path: '/api/agents/llm/v1/chat/completions', access: 'bearer', summary: 'OpenAI-compatible chat completions through the server\'s provider gateway — same key, the configured local/cloud model answers.' },
        ],
      },
    ],
  },
  {
    id: 'mcp-oauth',
    title: 'MCP & OAuth',
    pages: [
      {
        id: 'mcp',
        title: 'The /mcp endpoint',
        intro: 'JSON-RPC 2.0 over streamable HTTP for coding assistants. Outside the /api guard — it authenticates with personal access tokens or OAuth and checks Origin itself.',
        blocks: [
          {
            kind: 'code',
            label: 'Handshake + first call',
            code: `curl -X POST http://localhost:3001/mcp \\
  -H 'Authorization: Bearer <personal access token>' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{},
                 "clientInfo":{"name":"my-assistant","version":"1.0"}}}'

# then tools/list and tools/call — 60 requests a minute per token`,
          },
          { kind: 'list', items: [
            'initialize — protocol handshake (or stateless 2026-07-28: no initialize needed).',
            'tools/list — the workspace\'s MCP tools.',
            'tools/call — invoke a tool (scan, rule, evidence).',
            'prompts/get, resources/read — prompt and resource surfaces.',
          ] },
        ],
        endpoints: [
          { method: 'GET', path: '/api/mcp/servers', access: 'bearer', summary: 'The 12 bundled MCP servers with transport and status.' },
          { method: 'POST', path: '/api/mcp/:serverId/rpc', access: 'bearer', summary: 'JSON-RPC to one bundled server (dashboard proxy).' },
          { method: 'POST', path: '/api/mcp/:serverId/invoke', access: 'bearer', summary: 'Invoke one tool on a bundled server.' },
          { method: 'POST', path: '/api/mcp/external/:serverId/call', access: 'bearer', summary: 'Call a user-connected external MCP server.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/mcp/calls', access: 'manageWorkspace', summary: 'Audit log of MCP calls on the workspace.' },
        ],
      },
      {
        id: 'oauth',
        title: 'OAuth 2.0 (for /mcp)',
        intro: 'PKCE (S256) required. One-hour access tokens are personal access tokens; 30-day refresh tokens rotate. A reused code revokes what it issued.',
        endpoints: [
          { method: 'GET', path: '/.well-known/oauth-authorization-server', access: 'public', summary: 'Authorization-server metadata.' },
          { method: 'GET', path: '/.well-known/oauth-protected-resource', access: 'public', summary: 'Resource metadata — /mcp\'s 401 names it.' },
          { method: 'POST', path: '/oauth/register', access: 'public', summary: 'Register a public client (redirect URIs https or localhost, matched exactly).' },
          { method: 'GET', path: '/oauth/authorize', access: 'oauth', summary: 'Consent page — sign in, pick one workspace.' },
          { method: 'POST', path: '/oauth/authorize', access: 'oauth', summary: 'Consent decision.' },
          { method: 'POST', path: '/oauth/token', access: 'public', summary: 'Code → tokens; also refreshes (rotating).' },
        ],
      },
    ],
  },
  {
    id: 'github',
    title: 'GitHub App',
    pages: [
      {
        id: 'app-setup',
        title: 'App setup',
        intro: 'The App\'s credentials live on the server\'s data volume (github-app.json, mode 0600) — never in the repo.',
        endpoints: [
          { method: 'GET', path: '/github/register', access: 'signed-in', summary: 'Start registering a GitHub App (redirects to GitHub).' },
          { method: 'GET', path: '/github/register/callback', access: 'signed-in', summary: 'GitHub returns the App manifest code here.' },
          { method: 'GET', path: '/github/install', access: 'signed-in', summary: 'Install the App on a repository.' },
          { method: 'GET', path: '/github/setup', access: 'signed-in', summary: 'Post-install linking to a workspace.' },
          { method: 'GET', path: '/github/app', access: 'signed-in', summary: 'The App\'s public details.' },
          { method: 'GET', path: '/github/oauth/callback', access: 'signed-in', summary: 'OAuth user-link callback.' },
          { method: 'GET', path: '/api/workspaces/:workspaceId/github', access: 'view', summary: 'Installations linked to the workspace.' },
        ],
      },
    ],
  },
  {
    id: 'ops',
    title: 'Ops',
    pages: [
      {
        id: 'health-state',
        title: 'Health & state',
        endpoints: [
          { method: 'GET', path: '/api/health', access: 'public', summary: 'Liveness — the one route outside every guard by design.' },
          { method: 'GET', path: '/api/state', access: 'bearer', summary: 'Dashboard bootstrap: report, feed, prompt library. 401 without credentials.' },
          { method: 'GET', path: '/api/regulations/live-feed', access: 'bearer', summary: 'The global regulatory feed.' },
        ],
      },
      {
        id: 'tokens',
        title: 'Personal access tokens',
        endpoints: [
          { method: 'GET', path: '/api/workspaces/:workspaceId/tokens', access: 'view', summary: 'Tokens issued for the workspace.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/tokens', access: 'view', summary: 'Issue a token (shown once) — used by /mcp clients.' },
          { method: 'POST', path: '/api/workspaces/:workspaceId/tokens/:tokenId/revoke', access: 'view', summary: 'Revoke a token.' },
        ],
      },
      {
        id: 'errors-limits',
        title: 'Errors & rate limits',
        intro: 'Failures carry a StoreError message with the right status: 400 invalid input, 401 unauthenticated, 403 missing permission, 404 unknown id, 409 conflict, 429 limited.',
        blocks: [
          {
            kind: 'table',
            headers: ['Surface', 'Limit', 'Per'],
            rows: [
              ['GitHub webhooks', '600/min', 'client'],
              ['Share pages + well-known keys', '120/min', 'client'],
              ['Sign-in endpoints', '30/min', 'client'],
              ['/oauth/*', '60/min', 'client'],
              ['/mcp', '60/min', 'token'],
            ],
          },
          {
            kind: 'p', text: 'Outside the /api guard by design: /api/github/webhooks (signed by GitHub), /api/share/* and /.well-known/lexcompiler/* (share token is the credential), /mcp (its own tokens + Origin check), /api/health, and the OAuth pages.',
          },
          { kind: 'p', text: 'LEXCOMPILER_RATE_LIMITS overrides the defaults, e.g. webhooks=600,share=120,signin=30.' },
        ],
      },
    ],
  },
];
