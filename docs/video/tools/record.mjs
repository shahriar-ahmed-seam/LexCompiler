// Records the demo: two tabs (dashboard; legal workspace and GitHub), Chrome screencast frames
// with wall-clock times, each scene starting when its voiceover clip starts.
//   node record.mjs <outDir> <offsetsJson>   offsets: [{ id, start, dur }] in seconds
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const APP = 'http://localhost:3002';
const [OUT, OFFSETS] = process.argv.slice(2);
const scenes = JSON.parse(fs.readFileSync(OFFSETS, 'utf8'));
const creds = JSON.parse(fs.readFileSync('D:/Web Dev/LexCompiler/data/live/keycloak/credentials.json', 'utf8'));
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const dash = await ctx.newPage();
const work = await ctx.newPage();
const gh = await ctx.newPage();

await work.goto(`${APP}/api/auth/login`);
await work.fill('#username', 'arif');
await work.fill('#password', creds.people.arif);
await work.click('#kc-login');
await work.waitForURL((u) => u.toString().startsWith(APP));
await dash.goto(`${APP}/`);
await dash.getByText('Law-to-AST Split Studio').first().waitFor({ timeout: 240000 });
await work.goto(`${APP}/legal`);
await work.getByText('Agent crew', { exact: false }).first().waitFor({ timeout: 30000 });
await gh.goto('https://github.com/MRSHAKILS/finhealth-core-platform/runs/124146138632');
await gh.getByText('AI explanations').first().waitFor({ timeout: 60000 });
await dash.bringToFront();
await dash.waitForTimeout(3000);

// Screencast: one CDP session per page; restarted after navigations and tab switches.
const frames = [];
let n = 0;
let cast = null;
async function castOn(page) {
  if (cast) await cast.send('Page.stopScreencast').catch(() => {});
  if (cast) await cast.detach().catch(() => {});
  cast = await ctx.newCDPSession(page);
  cast.on('Page.screencastFrame', async (f) => {
    const file = path.join(OUT, 'frames', `${String(n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: Date.now() });
    await cast.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cast.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
}
const show = async (page) => { await page.bringToFront(); await castOn(page); };
const go = async (page, url) => { await page.goto(url); await castOn(page); };

/** Smoothly scrolls the window so the first element containing `text` sits near the top. */
const scrollTo = (page, text, offset = 120) =>
  page.evaluate(([t, off]) => {
    const el = [...document.querySelectorAll('h1,h2,h3,h4,p,summary,li,a,button,span,div')].find((e) => e.children.length === 0 && e.textContent.trim().startsWith(t));
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth' });
    return Boolean(el);
  }, [text, offset]);
const scrollBy = (page, dy) => page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy);
/** Smooth wheel scrolling inside whatever scrolls under (x, y). */
async function wheel(page, x, y, dy, steps = 12) {
  await page.mouse.move(x, y);
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await page.waitForTimeout(40); }
}
const tab = (re) => dash.getByRole('button', { name: re }).first().click();

const t0 = Date.now();
await castOn(dash);
const at = async (s) => { const wait = t0 + s * 1000 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); };
const S = Object.fromEntries(scenes.map((s) => [s.id, s]));

// 1. The problem: the dashboard's statute compiler and blast-radius graph.
await at(S.problem.start + 7); await wheel(dash, 1400, 600, 300);
await at(S.problem.start + 14); await wheel(dash, 1400, 600, -300);

// 2. Compile: clause → deontic logic, SMT-LIB, Rego; Z3's verdict.
await at(S.compile.start + 0.5);
await dash.getByRole('button', { name: /Compile Prose/ }).first().click().catch(() => {});
await at(S.compile.start + 5); await wheel(dash, 600, 700, 700, 20);
await at(S.compile.start + 12); await wheel(dash, 600, 700, -700, 12);

// 3. Legal workspace: rule cards, R-3 v2 effective 2027, "Coming up".
await at(S.legal.start); await show(work); await work.evaluate(() => window.scrollTo(0, 0));
await at(S.legal.start + 9); await scrollTo(work, 'Coming up');

// 4. The pull request's check run on GitHub.
await at(S['pull-request'].start); await show(gh);
await at(S['pull-request'].start + 7); await scrollTo(gh, 'Coming up', 200);
await at(S['pull-request'].start + 13); await scrollTo(gh, 'AI explanations', 140);

// 5. The agent crew: a stored run on main, step by step.
await at(S.agents.start); await show(work); await scrollTo(work, 'Agent crew', 80);
await at(S.agents.start + 4);
await work.getByRole('button', { name: /Show the steps of the run on MRSHAKILS\/finhealth-core-platform at 858dc92/ }).first().click().catch(() => {});
await at(S.agents.start + 7); await scrollBy(work, 450);
await at(S.agents.start + 13); await scrollBy(work, 450);
await at(S.agents.start + 19); await scrollBy(work, 450);

// 6. Under the hood: RAG, the local models, the MCP servers.
await at(S.stack.start); await show(dash); await tab(/Contextual \+ Graph R/);
await at(S.stack.start + 10); await tab(/Live Multi-LLM/);
await at(S.stack.start + 19); await tab(/12-MCP/);

// 7. Bangla: the compiler's Bangla mode.
await at(S.bangla.start); await tab(/Law-to-AST/); await dash.getByText('বাংলা', { exact: false }).first().click().catch(() => {});

// 8. Close: signed attestations.
await at(S.close.start); await tab(/Enterprise BYOC/);
const end = scenes.at(-1).start + scenes.at(-1).dur + 1.5;
await at(end);
await cast.send('Page.stopScreencast').catch(() => {});
fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify({ t0, end, frames }));
console.log(`${frames.length} frames, ${(Date.now() - t0) / 1000}s`);
await browser.close();
