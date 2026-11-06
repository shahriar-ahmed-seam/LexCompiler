/**
 * npm run setup:keycloak: a local Keycloak for sign-in, ready to use. Safe to run more than once.
 *
 * Starts Keycloak in Docker (container lexc-keycloak, http://localhost:8080) unless it's running,
 * then creates the `lexcompiler` realm, the confidential client `lexcompiler-web` (redirects to
 * localhost:3001 and :3002, S256 PKCE, a `roles` claim), the `lexcompiler-admin` role, and two
 * people: arif@finhealth.test (admin) and nusrat@finhealth.test.
 *
 * Generated passwords and the client secret go to <data dir>/keycloak/ (git-ignored):
 *   credentials.json  the Keycloak admin and both people's passwords
 *   oidc.env          the LEXCOMPILER_OIDC_* settings, for `node --env-file`
 * Nothing secret is printed.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db/index.js';
import { restrictToOwner } from '../enterprise/signingKey.js';

const IMAGE = 'quay.io/keycloak/keycloak:26.4.0';
const CONTAINER = 'lexc-keycloak';
const BASE = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const REALM = 'lexcompiler';
const CLIENT_ID = 'lexcompiler-web';
const ADMIN_ROLE = 'lexcompiler-admin';
const PORTS = [3001, 3002];
const PEOPLE = [
  { username: 'arif', email: 'arif@finhealth.test', firstName: 'Arif', lastName: 'Rahman', admin: true },
  { username: 'nusrat', email: 'nusrat@finhealth.test', firstName: 'Nusrat', lastName: 'Jahan', admin: false },
];

interface Credentials {
  admin: { username: string; password: string };
  clientSecret: string;
  people: Record<string, string>;
}

const folder = path.join(dataDir(), 'keycloak');
const credentialsFile = path.join(folder, 'credentials.json');
const secret = () => crypto.randomBytes(18).toString('base64url');

function loadCredentials(): Credentials {
  if (fs.existsSync(credentialsFile)) return JSON.parse(fs.readFileSync(credentialsFile, 'utf8')) as Credentials;
  const created: Credentials = {
    admin: { username: 'admin', password: secret() },
    clientSecret: secret(),
    people: Object.fromEntries(PEOPLE.map((p) => [p.username, secret()])),
  };
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(credentialsFile, JSON.stringify(created, null, 2) + '\n', { mode: 0o600 });
  restrictToOwner(credentialsFile);
  return created;
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function ensureContainer(creds: Credentials) {
  const state = (() => {
    try {
      return docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
    } catch {
      return null;
    }
  })();
  if (state === 'true') return;
  if (state === 'false') {
    console.log(`Starting the existing ${CONTAINER} container.`);
    docker('start', CONTAINER);
    return;
  }
  console.log(`Creating ${CONTAINER} from ${IMAGE} on ${BASE}.`);
  docker(
    'run', '-d', '--name', CONTAINER, '-p', '127.0.0.1:8080:8080',
    '-e', `KC_BOOTSTRAP_ADMIN_USERNAME=${creds.admin.username}`,
    '-e', `KC_BOOTSTRAP_ADMIN_PASSWORD=${creds.admin.password}`,
    IMAGE, 'start-dev'
  );
}

async function waitForKeycloak() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/realms/master`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Keycloak didn't answer on ${BASE} within 3 minutes (docker logs ${CONTAINER}).`);
}

async function adminToken(creds: Credentials): Promise<string> {
  const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: creds.admin.username, password: creds.admin.password }),
  });
  if (!res.ok) {
    throw new Error(`Keycloak refused the saved admin password (${res.status}). If ${CONTAINER} was created by hand, remove it (docker rm -f ${CONTAINER}) and run this again.`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

function adminApi(token: string) {
  return async <T = unknown>(method: string, route: string, body?: unknown, okStatuses: number[] = []): Promise<T> => {
    const res = await fetch(`${BASE}/admin/realms${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

function clientRepresentation(clientSecret: string) {
  return {
    clientId: CLIENT_ID,
    name: 'LexCompiler',
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    secret: clientSecret,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: PORTS.map((p) => `http://localhost:${p}/api/auth/callback`),
    webOrigins: PORTS.map((p) => `http://localhost:${p}`),
    attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': PORTS.map((p) => `http://localhost:${p}/*`).join('##') },
    protocolMappers: [
      {
        name: 'realm roles',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-realm-role-mapper',
        config: { 'claim.name': 'roles', multivalued: 'true', 'jsonType.label': 'String', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true' },
      },
      {
        // Bearer tokens for the API carry the client id as their audience.
        name: 'lexcompiler audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': CLIENT_ID, 'id.token.claim': 'false', 'access.token.claim': 'true' },
      },
    ],
  };
}

async function main() {
  const creds = loadCredentials();
  if (!process.env.KEYCLOAK_URL) ensureContainer(creds);
  await waitForKeycloak();
  const api = adminApi(await adminToken(creds));

  await api('POST', '', { realm: REALM, enabled: true, displayName: 'LexCompiler (local)' }, [409]);
  await api('POST', `/${REALM}/roles`, { name: ADMIN_ROLE, description: 'LexCompiler global admin' }, [409]);

  const client = clientRepresentation(creds.clientSecret);
  const existing = await api<Array<{ id: string }>>('GET', `/${REALM}/clients?clientId=${CLIENT_ID}`);
  if (existing[0]) {
    // Mappers aren't updated by PUT; recreate the client so they match.
    await api('DELETE', `/${REALM}/clients/${existing[0].id}`);
  }
  await api('POST', `/${REALM}/clients`, client);

  const adminRole = await api<{ id: string; name: string }>('GET', `/${REALM}/roles/${ADMIN_ROLE}`);
  for (const person of PEOPLE) {
    const user = {
      username: person.username,
      email: person.email,
      emailVerified: true,
      enabled: true,
      firstName: person.firstName,
      lastName: person.lastName,
      requiredActions: [],
    };
    let [found] = await api<Array<{ id: string }>>('GET', `/${REALM}/users?username=${person.username}&exact=true`);
    if (found) await api('PUT', `/${REALM}/users/${found.id}`, user);
    else {
      await api('POST', `/${REALM}/users`, user);
      [found] = await api<Array<{ id: string }>>('GET', `/${REALM}/users?username=${person.username}&exact=true`);
    }
    await api('PUT', `/${REALM}/users/${found.id}/reset-password`, { type: 'password', value: creds.people[person.username], temporary: false });
    if (person.admin) await api('POST', `/${REALM}/users/${found.id}/role-mappings/realm`, [adminRole]);
  }

  const envFile = path.join(folder, 'oidc.env');
  fs.writeFileSync(
    envFile,
    [
      '# Written by npm run setup:keycloak. Holds the client secret: keep it out of the repo.',
      `LEXCOMPILER_OIDC_ISSUER=${BASE}/realms/${REALM}`,
      `LEXCOMPILER_OIDC_CLIENT_ID=${CLIENT_ID}`,
      `LEXCOMPILER_OIDC_CLIENT_SECRET=${creds.clientSecret}`,
      `LEXCOMPILER_OIDC_ADMIN_ROLE=${ADMIN_ROLE}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  restrictToOwner(envFile);

  console.log(`Keycloak is ready: realm "${REALM}" at ${BASE}/realms/${REALM}.`);
  console.log(`People: ${PEOPLE.map((p) => `${p.username} (${p.email}${p.admin ? ', admin' : ''})`).join(', ')}.`);
  console.log(`Passwords: ${credentialsFile}`);
  console.log(`Settings:  ${envFile}`);
  console.log('Start the server with them, for example:');
  console.log(`  node --env-file=${path.relative(process.cwd(), envFile)} --import tsx server/index.ts`);
  console.log('Set LEXCOMPILER_OIDC_REDIRECT_URI too when the server runs on a port other than 3001.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
