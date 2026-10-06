// Tests api/direct.js (Claude prompt reading) against a fake Anthropic API,
// then checks in the browser that the app follows the returned direction.
// Usage: node tests/direct.mjs <clip> [--url http://localhost:8765/index.html]
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;
const clip = process.argv[2];
const ui = process.argv.indexOf('--url');
const appUrl = ui > 0 ? process.argv[ui + 1] : 'http://localhost:8765/index.html';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const DIRECTION = {
  style: 'moody', duration_seconds: 12, pace: 'slow', slow_motion: 'none', close_ups: 'many', camera_shake: false,
  cinema_bars: 'off', story_order: true, sound_effects: false, original_sound: 'off',
  prefer_transitions: ['dip'], avoid_transitions: ['flash', 'rgb', 'whip'],
  warmth: 'warmer', saturation: 'muted', contrast: 'soft', film_grain: 'heavy',
  titles: [{ text: 'मेरी कहानी', when: 'opening' }, { text: 'THE END', when: 'ending' }],
  summary: 'धीमी, गर्म रंगों वाली इमोशनल रील',
  not_possible: ['AI से नए visuals बनाना'],
};
// ---- fake Anthropic API
let lastReq = null; let mode = 'ok';
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastReq = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
    if (mode === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } })); return; }
    const refusal = mode === 'refusal';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      content: refusal ? [] : [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(DIRECTION) }],
      stop_reason: refusal ? 'refusal' : 'end_turn', stop_sequence: null, usage: { input_tokens: 900, output_tokens: 300 } }));
  });
}).listen(0);
await new Promise((r) => fake.on('listening', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.ANTHROPIC_API_KEY = 'test-key';
const direct = require(path.join(path.dirname(new URL(import.meta.url).pathname), '../api/direct.js'));

async function call(body, headers = {}, method = 'POST') {
  return new Promise((resolve) => {
    const out = { status: 200, headers: {}, json: null };
    const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, status(c) { out.status = c; return res; }, json(o) { out.json = o; resolve(out); } };
    direct({ method, headers, body }, res);
  });
}
// ---- server function checks
let r = await call({ prompt: 'MASTER VIDEO EDIT PROMPT: emotional slow reel, no flashy effects, 12 seconds, title "मेरी कहानी"', context: { clips: [{ duration: 8.2, width: 1080, height: 1920 }], hasMusic: true } });
check(r.status === 200 && r.json.direction.style === 'moody', 'returns the parsed direction');
const b = lastReq.body;
check(lastReq.url.startsWith('/v1/messages') && b.model === 'claude-opus-5-5', `calls ${lastReq.url} with ${b.model}`);
check(b.output_config && b.output_config.format && b.output_config.format.type === 'json_schema' && b.output_config.effort === 'low', 'structured JSON output at low effort');
check(b.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(lastReq.headers['anthropic-beta'] || ''), 'refusal fallback enabled');
check(!('thinking' in b) && !('temperature' in b), 'no disabled-thinking or sampling params (would 400 on Opus 5.5)');
const sch = b.output_config.format.schema;
const allObjsClosed = (o) => typeof o !== 'object' || o === null || ((o.type !== 'object' || o.additionalProperties === false) && Object.values(o).every(allObjsClosed));
check(allObjsClosed(sch) && sch.required.length === Object.keys(sch.properties).length, 'schema: every object closed, all fields required');
check(/<user_prompt>[\s\S]*MASTER VIDEO EDIT PROMPT[\s\S]*<\/user_prompt>/.test(b.messages[0].content) && /8\.2s portrait/.test(b.messages[0].content), 'prompt + clip facts sent');
mode = 'refusal'; r = await call({ prompt: 'x' }); check(r.status === 422 && r.json.error === 'refused', 'refusal → 422');
mode = 'auth'; r = await call({ prompt: 'x' }); check(r.status === 503 && r.json.error === 'bad_key', 'bad key → bad_key');
mode = 'ok';
r = await call({ prompt: '' }); check(r.status === 400, 'empty prompt → 400');
r = await call({}, {}, 'GET'); check(r.status === 405, 'GET → 405');
process.env.RAWREEL_ACCESS_CODE = 'secret';
r = await call({ prompt: 'x' }); check(r.status === 401 && r.json.error === 'code', 'access code required when set');
r = await call({ prompt: 'x' }, { 'x-rawreel-code': 'secret' }); check(r.status === 200, 'correct access code accepted');
delete process.env.RAWREEL_ACCESS_CODE;
const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
r = await call({ prompt: 'x' }); check(r.status === 503 && r.json.error === 'no_key', 'missing key → no_key');
process.env.ANTHROPIC_API_KEY = saved;

// ---- browser: the app follows the direction
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
async function session(apiMode) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  let calls = 0;
  await page.route('**/api/direct', async (route) => {
    calls++;
    if (apiMode === 'nokey') { process.env.ANTHROPIC_API_KEY = ''; }
    const req = route.request();
    const out = await call(JSON.parse(req.postData() || '{}'), req.headers());
    process.env.ANTHROPIC_API_KEY = saved;
    await route.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify(out.json) });
  });
  await page.goto(appUrl);
  await page.setInputFiles('#clipInput', path.resolve(clip));
  await page.waitForFunction(() => document.querySelectorAll('#clipList .clip').length === 1, null, { timeout: 60000 });
  await page.fill('#prompt', 'MASTER VIDEO EDIT PROMPT: emotional slow reel, no flashy effects, 12 seconds. Title "मेरी कहानी", end with "THE END". Add AI generated visuals.');
  await page.click('#planBtn');
  await page.waitForSelector('#plan:not(.hidden)', { timeout: 180000 });
  const info = await page.evaluate(() => {
    const p = window.__rawreel.state.plan;
    return { label: p.style.label, D: p.D, ai: p.cfg.ai, bars: p.barsFrac, sfx: p.cfg.sfx, orig: p.cfg.orig,
      heroProfile: p.slots.find((s) => s.section === 'hero').profile, trans: p.slots.slice(1).map((s) => s.tr.type),
      grain: p.style.grade.grain, temp: p.style.grade.temp, baseTemp: window.__rawreel.state && 0,
      texts: p.texts.map((t) => [t.text, +t.t0.toFixed(2), +t.t1.toFixed(2), t.kind]), outroStart: p.outroStart,
      head: document.querySelector('#planHead').textContent, pills: [...document.querySelectorAll('#intent .pill')].map((x) => x.textContent),
      auto: document.querySelector('#durChips button').textContent };
  });
  // re-roll must not call the API again
  await page.click('#rerollBtn');
  const callsAfterReroll = calls;
  await page.close();
  return { info, calls, callsAfterReroll };
}
const s = await session('ok');
const i = s.info;
console.log(JSON.stringify(i));
check(i.ai && /^🧠/.test(i.head) && /Moody/.test(i.label), 'plan uses AI style (moody) and is marked 🧠');
check(i.D === 12 && i.auto === 'Auto · 12s', 'AI duration 12s used by Auto');
check(i.heroProfile.type === 'const' && i.heroProfile.v >= 1, 'slow_motion none → no slow-mo ramp');
check(i.bars === 0 && i.sfx === false && i.orig === false, 'bars off, no SFX, original sound off');
check(!i.trans.some((t) => ['flash', 'rgb', 'whip'].includes(t)), `avoided transitions never used: ${i.trans.join(',')}`);
check(i.grain >= 0.09 && i.temp > -0.25, 'colour tweaks applied (heavy grain, warmer)');
check(i.texts.length === 2 && i.texts[0][0] === 'मेरी कहानी' && i.texts[0][1] < 1 && i.texts[1][0] === 'THE END' && i.texts[1][1] >= i.outroStart, 'titles placed at opening and ending');
check(i.pills.some((p) => p.includes('धीमी')) && i.pills.some((p) => p.startsWith('✖') && p.includes('visuals')), 'summary and not-possible items shown');
check(s.calls === 1 && s.callsAfterReroll === 1, 'one API call per Analyze; re-roll is free');
const n = await session('nokey');
check(!n.info.ai && !n.info.pills.some((p) => p.includes('AI')), 'no key (free mode) → keyword mode, no AI warning shown');
await browser.close(); fake.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
