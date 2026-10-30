// Builds the LexCompiler overview diagram as plain SVG (text + rects + paths), so Figma
// imports it as editable layers.   node build.mjs <out.svg>
import fs from 'node:fs';

const W = 1920, H = 1600;
const C = {
  bg: '#F7F8FB', ink: '#0F172A', sub: '#475569', faint: '#94A3B8', line: '#CBD5E1', white: '#FFFFFF',
  navy: '#1E293B', amber: '#B45309', amberBg: '#FEF3C7', sky: '#0369A1', skyBg: '#E0F2FE',
  green: '#047857', greenBg: '#D1FAE5', violet: '#6D28D9', violetBg: '#EDE9FE', red: '#B91C1C', redBg: '#FEE2E2',
  slateBg: '#EEF2F7',
};
const FONT = "Inter, 'Segoe UI', Arial, sans-serif";
const MONO = "'JetBrains Mono', Consolas, monospace";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
const add = (s) => out.push(s);

function text(x, y, lines, { size = 14, weight = 400, color = C.ink, font = FONT, lh = 1.35, anchor = 'start' } = {}) {
  const arr = Array.isArray(lines) ? lines : [lines];
  add(`<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">` +
    arr.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size * lh}">${esc(l)}</tspan>`).join('') + '</text>');
  return y + (arr.length - 1) * size * lh;
}
const rect = (x, y, w, h, { fill = C.white, stroke = C.line, r = 12, sw = 1.5, dash } = {}) =>
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
const pill = (x, y, label, { fill = C.slateBg, color = C.sub, size = 12 } = {}) => {
  const w = Math.round(label.length * size * 0.6) + 16;
  rect(x, y, w, size + 10, { fill, stroke: 'none', r: (size + 10) / 2, sw: 0 });
  text(x + 8, y + size + 1, label, { size, color, font: MONO });
  return x + w + 6;
};
const arrow = (d, { color = C.faint, w = 2, dash } = {}) =>
  add(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#ah-${color.slice(1)})"/>`);
const circleNum = (cx, cy, n, color) => {
  add(`<circle cx="${cx}" cy="${cy}" r="15" fill="${color}"/>`);
  text(cx, cy + 5, String(n), { size: 14, weight: 700, color: C.white, anchor: 'middle' });
};

add(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
add('<defs>' + [C.faint, C.sky, C.green, C.amber, C.violet, C.red, C.navy].map((c) =>
  `<marker id="ah-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('') + '</defs>');
rect(0, 0, W, H, { fill: C.bg, stroke: 'none', r: 0, sw: 0 });

// ── Header ─────────────────────────────────────────────────────────────
text(60, 78, 'LexCompiler', { size: 44, weight: 800 });
text(60, 116, 'Turns laws and contracts into machine-checkable rules, and proves on every pull request that the code still obeys them.', { size: 20, color: C.sub });
text(W - 60, 70, 'International AI Builders Congress 2026', { size: 15, color: C.sub, anchor: 'end' });
text(W - 60, 94, 'Shahriar Ahmed Seam · Shakil Ahmed', { size: 15, weight: 600, anchor: 'end' });

// ── Band 1: problem / what / impact ───────────────────────────────────
const band = [
  { t: 'THE PROBLEM', c: C.red, bg: C.redBg, lines: [
    'Laws change: GDPR, the EU AI Act, HIPAA, Bangladesh Bank rules.',
    'Code changes every day. Compliance is checked by hand,',
    'often months later, after the violation has shipped.',
    'Fines reach 4% of global turnover (GDPR), 7% (EU AI Act).'] },
  { t: 'WHAT LEXCOMPILER DOES', c: C.sky, bg: C.skyBg, lines: [
    'Legal approves each rule as a plain-language card.',
    'LexCompiler compiles it into formal logic and checks every',
    'code change with the Z3 theorem prover, before merge,',
    'in English and বাংলা.'] },
  { t: 'WHY IT MATTERS', c: C.green, bg: C.greenBg, lines: [
    'Proof, not opinion: every failure has a counterexample.',
    'Seconds, not months: a pull request check took 5 s;',
    'a rescan after Legal approved a rule took 4 s.',
    'Audit-ready: every decision is signed and hash-chained.'] },
];
band.forEach((b, i) => {
  const x = 60 + i * 607, y = 150, w = 587, h = 170;
  rect(x, y, w, h, { fill: C.white, stroke: C.line });
  rect(x, y, 8, h, { fill: b.c, stroke: 'none', r: 4, sw: 0 });
  text(x + 30, y + 38, b.t, { size: 15, weight: 800, color: b.c });
  text(x + 30, y + 70, b.lines, { size: 16, color: C.ink, lh: 1.45 });
});

// ── Band 2: the workflow (swimlanes) ──────────────────────────────────
const wfY = 360;
text(60, wfY, 'HOW IT WORKS: FROM A NEW LAW TO SIGNED EVIDENCE', { size: 15, weight: 800, color: C.navy });
const lanes = [
  { name: 'Regulators', sub: 'and contracts', bg: '#FFFBEB', c: C.amber },
  { name: 'Legal team', sub: 'lawyers, compliance', bg: '#F5F3FF', c: C.violet },
  { name: 'LexCompiler', sub: 'agents + Z3 prover', bg: '#F0F9FF', c: C.sky },
  { name: 'Engineers', sub: 'on GitHub', bg: '#ECFDF5', c: C.green },
];
const laneX = 60, laneW = W - 120, laneH = 118, laneTop = wfY + 20, labelW = 170;
lanes.forEach((l, i) => {
  const y = laneTop + i * (laneH + 8);
  rect(laneX, y, laneW, laneH, { fill: l.bg, stroke: 'none', r: 12, sw: 0 });
  text(laneX + 20, y + laneH / 2 - 2, l.name, { size: 18, weight: 800, color: l.c });
  text(laneX + 20, y + laneH / 2 + 20, l.sub, { size: 13, color: C.sub });
});
const laneMid = (i) => laneTop + i * (laneH + 8) + laneH / 2;
const steps = [
  { lane: 0, t: 'A law changes', d: ['EUR-Lex, U.S. Federal', 'Register, contracts (PDF)'] },
  { lane: 2, t: 'Spot what it affects', d: ['Horizon scanner matches', 'it to the rules in force'] },
  { lane: 1, t: 'Approve a rule card', d: ['Plain-language card,', 'values and effective date'] },
  { lane: 2, t: 'Compile to logic', d: ['Obligation / prohibition', '→ SMT-LIB2 + Rego'] },
  { lane: 3, t: 'Open a pull request', d: ['GitHub sends a signed', 'webhook to LexCompiler'] },
  { lane: 2, t: 'Prove it', d: ['Code → AST facts → Z3:', 'proof, or counterexample'] },
  { lane: 3, t: 'Fix before merge', d: ['Failing check, exact fix,', 'AI explanation, fix PR'] },
  { lane: 1, t: 'Evidence for audit', d: ['Signed, hash-chained log;', 'read-only auditor link'] },
];
const sx0 = laneX + labelW + 10, sw = 188, gap = (laneW - labelW - 20 - steps.length * sw) / (steps.length - 1), sh = 92;
const centers = steps.map((s, i) => ({ x: sx0 + i * (sw + gap), y: laneMid(s.lane) - sh / 2 }));
// connectors first, under the boxes
for (let i = 0; i < steps.length - 1; i++) {
  const a = centers[i], b = centers[i + 1];
  const x1 = a.x + sw, y1 = a.y + sh / 2, x2 = b.x, y2 = b.y + sh / 2, mx = (x1 + x2) / 2;
  arrow(`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 3},${y2}`, { color: C.navy, w: 2 });
}
// "approval rescans main" loop note from step 3/4
steps.forEach((s, i) => {
  const { x, y } = centers[i];
  rect(x, y, sw, sh, { fill: C.white, stroke: lanes[s.lane].c, sw: 2 });
  circleNum(x + 22, y + 24, i + 1, lanes[s.lane].c);
  text(x + 44, y + 30, s.t, { size: 15, weight: 700 });
  text(x + 14, y + 56, s.d, { size: 12.5, color: C.sub, lh: 1.35 });
});
const wfBottom = laneTop + 4 * (laneH + 8);
text(sx0, wfBottom + 18, 'Step 3 also rescans the main branch at once. A version approved for a later date shows as "Coming up" on pull requests before it fails anything. If a patch can\'t be proven, nothing is merged: the fix agent only suggests.', { size: 13.5, color: C.sub });

// ── Band 3: architecture ──────────────────────────────────────────────
const arY = wfBottom + 60;
text(60, arY, 'ARCHITECTURE: WHAT RUNS WHERE, AND HOW THE PARTS TALK', { size: 15, weight: 800, color: C.navy });
const zoneY = arY + 18, zoneH = H - zoneY - 90;
// On-premise zone
const zx = 60, zw = 1250;
rect(zx, zoneY, zw, zoneH, { fill: C.white, stroke: C.navy, sw: 2, dash: '8 6' });
text(zx + 20, zoneY + 30, 'Runs on your own machine or VPS  ·  code and keys stay inside', { size: 15, weight: 700, color: C.navy });
text(zx + zw - 20, zoneY + 30, 'tested on a laptop: Windows 11, RTX 4050 6 GB', { size: 13, color: C.sub, anchor: 'end' });
// server box
const sx = zx + 20, sy = zoneY + 48, swd = zw - 40, shh = 238;
rect(sx, sy, swd, shh, { fill: '#F8FAFC', stroke: C.sky, sw: 2 });
text(sx + 18, sy + 28, 'LexCompiler server', { size: 17, weight: 800, color: C.sky });
text(sx + 196, sy + 28, 'Node 24 · Express · TypeScript · :3002', { size: 13, color: C.sub, font: MONO });
const comps = [
  ['Legal workspace', '/legal · rule cards, approvals', 'OIDC roles: owner, legal, engineer'],
  ['GitHub App receiver', '/api/github/webhooks', 'HMAC-SHA256 check · dedupe'],
  ['Job queue', 'scans, nightly feed, retries', 'one scan per commit + rules'],
  ['Rule compiler', 'deontic O / F / P', '→ SMT-LIB2 (QF_LIA) + Rego'],
  ['Scanner + Z3 prover', 'SQL · Python · TypeScript AST', 'proof, unsat core, counterexample'],
  ['AI gateway', 'off / local / cloud per workspace', 'daily budgets · every call logged'],
  ['Contextual graph RAG', 'contextual chunks · BM25 + vectors', 'rank fusion · 2-hop graph'],
  ['MCP endpoint', '/mcp · stdio + streamable HTTP', 'OAuth for coding assistants'],
  ['Evidence log', 'append-only, hash-chained', 'Ed25519-signed, verifiable'],
];
const cw = (swd - 36 - 2 * 12) / 3, ch = 58;
comps.forEach(([t, a, b], i) => {
  const cx = sx + 18 + (i % 3) * (cw + 12), cy = sy + 44 + Math.floor(i / 3) * (ch + 10);
  rect(cx, cy, cw, ch, { fill: C.white, stroke: C.line, r: 8 });
  text(cx + 12, cy + 21, t, { size: 14, weight: 700 });
  text(cx + 12, cy + 38, a, { size: 11.5, color: C.sub, font: MONO });
  text(cx + 12, cy + 52, b, { size: 11.5, color: C.sub });
});
// agent crew row
const ay = sy + shh + 14, ah = 112;
rect(sx, ay, swd, ah, { fill: '#FAF5FF', stroke: C.violet, sw: 2 });
text(sx + 18, ay + 26, 'Six-agent crew', { size: 16, weight: 800, color: C.violet });
text(sx + 160, ay + 26, 'each agent calls only its own MCP server; what passes between them comes from tool results, never a model', { size: 12.5, color: C.sub });
const agents = [
  ['1 Horizon scanner', 'CrewAI', 'statute-ingest'],
  ['2 Deontic extractor', 'DSPy', 'deontic-compiler'],
  ['3 AST mapper', 'Hermes · Ollama', 'polyglot-ast'],
  ['4 Graph RAG', 'LangGraph', 'hybrid-rag'],
  ['5 Z3 critic', 'Pydantic-AI', 'z3-prover'],
  ['6 Remediation', 'OpenAI Agents SDK', 'remediation-pr'],
];
const aw = (swd - 36 - 5 * 10) / 6;
agents.forEach(([t, f, m], i) => {
  const x = sx + 18 + i * (aw + 10), y = ay + 40;
  rect(x, y, aw, 60, { fill: C.white, stroke: i === 5 ? C.green : C.line, r: 8, sw: i === 5 ? 2 : 1.5 });
  text(x + 10, y + 20, t, { size: 13.5, weight: 700 });
  text(x + 10, y + 37, f, { size: 12, color: C.violet });
  text(x + 10, y + 52, `lex-${m}-mcp`, { size: 10.5, color: C.sub, font: MONO });
  if (i < 5) arrow(`M${x + aw + 1},${y + 30} L${x + aw + 9},${y + 30}`, { color: C.violet, w: 1.5 });
});
// local services row
const ly = ay + ah + 14, lh2 = zoneY + zoneH - ly - 18;
const locals = [
  ['Ollama :11434', ['llama3.2 · qwen2.5-coder', 'dolphin3 · deepseek-r1', 'all-minilm embeddings'], C.amber],
  ['Keycloak :8080', ['OIDC sign-in (PKCE S256)', 'realm lexcompiler', 'roles → workspace access'], C.violet],
  ['Data stores', ['SQLite (migrated schema)', 'pgvector · Neo4j (optional)', 'per-workspace isolation'], C.sky],
  ['Python agent adapters', ['run the six frameworks', '→ /api/agents/llm/v1', 'operator token, token cap'], C.green],
];
const lw = (swd - 3 * 12) / 4;
locals.forEach(([t, ls, c], i) => {
  const x = sx + i * (lw + 12);
  rect(x, ly, lw, lh2, { fill: C.white, stroke: c, sw: 2 });
  text(x + 14, ly + 24, t, { size: 14.5, weight: 800, color: c });
  text(x + 14, ly + 46, ls, { size: 12.5, color: C.sub, lh: 1.4 });
});

// Internet zone
const ix = zx + zw + 44, iw = W - 60 - ix;
rect(ix, zoneY, iw, zoneH, { fill: C.white, stroke: C.line, sw: 2 });
text(ix + 20, zoneY + 30, 'Outside services', { size: 15, weight: 700, color: C.navy });
const outside = [
  ['GitHub', C.green, ['App webhooks: pull_request, push, check_run', 'Checks API: result, annotations, warnings', 'review comments with suggested fixes', 'fix pull requests, only after Z3 proves them']],
  ['Cloudflare Tunnel', C.amber, ['publishes the local server to GitHub', 'proxy headers trusted from loopback only']],
  ['DeepSeek API', C.sky, ['cloud model through the AI gateway', 'explanations, fixes, summaries; budgeted']],
  ['EUR-Lex · U.S. Federal Register', C.amber, ['regulation feeds, refreshed daily', 'regulation watch: affected rules + summary']],
  ['Coding assistants', C.violet, ['Claude Code, Cursor: workspace tools', 'over MCP with OAuth']],
];
let oy = zoneY + 48;
outside.forEach(([t, c, ls]) => {
  const hh = 30 + ls.length * 17 + 10;
  rect(ix + 20, oy, iw - 40, hh, { fill: '#FCFCFD', stroke: c, sw: 2 });
  text(ix + 36, oy + 24, t, { size: 14.5, weight: 800, color: c });
  text(ix + 36, oy + 44, ls, { size: 12.5, color: C.sub, lh: 1.36 });
  oy += hh + 10;
});
// boundary arrows between the zones
const bx1 = zx + zw + 2, bx2 = ix - 2;
arrow(`M${bx2},${zoneY + 110} L${bx1 + 4},${zoneY + 110}`, { color: C.green, w: 2.5 });
text((bx1 + bx2) / 2, zoneY + 100, 'signed', { size: 11, color: C.green, anchor: 'middle' });
arrow(`M${bx1},${zoneY + 140} L${bx2 - 4},${zoneY + 140}`, { color: C.green, w: 2.5 });
text((bx1 + bx2) / 2, zoneY + 158, 'checks', { size: 11, color: C.green, anchor: 'middle' });

// ── Footer: numbers ───────────────────────────────────────────────────
const fy = H - 62;
let px = 60;
for (const p of ['6 agents', '6 MCP servers built', '4 local models + embeddings', 'PR check: 5 s', 'rescan after approval: 4 s', 'prompt tokens −59%', '309 automated tests', 'English + বাংলা']) {
  px = pill(px, fy, p, { size: 14, fill: '#E2E8F0', color: C.navy }) + 4;
}
text(W - 60, fy + 18, 'github.com/MRSHAKILS/LexCompiler', { size: 14, color: C.sub, anchor: 'end', font: MONO });

add('</svg>');
fs.writeFileSync(process.argv[2], out.join('\n'));
console.log('wrote', process.argv[2]);
