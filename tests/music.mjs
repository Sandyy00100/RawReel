// Tests the music library flow end to end without the real Openverse:
// the page's /api/* requests are answered by the real serverless handlers,
// whose upstream fetches are served from a local audio file.
// Usage: node tests/music.mjs <song.wav> <clip> [--url http://localhost:8765/index.html]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;
const here = path.dirname(new URL(import.meta.url).pathname);
const music = require(path.join(here, '../api/music.js'));
const audio = require(path.join(here, '../api/audio.js'));

const [song, clip] = process.argv.slice(2);
const urlArg = process.argv.indexOf('--url');
const appUrl = urlArg > 0 ? process.argv[urlArg + 1] : 'http://localhost:8765/index.html';
const songBuf = fs.readFileSync(song);
const ID = '0b1e7c2a-1111-4c2d-9e3f-123456789abc';
const counts = { search: 0, meta: 0, ranges: [] };

globalThis.fetch = async (input, init = {}) => {
  const u = String(input);
  if (u.startsWith('https://api.openverse.org/v1/audio/?')) {
    counts.search++;
    const q = new URL(u).searchParams;
    if (q.get('license_type') !== 'commercial,modification' || q.get('category') !== 'music') throw new Error('wrong filters');
    return new Response(JSON.stringify({ results: [
      { id: ID, title: 'Test Drop', creator: 'Unit Tester', duration: 60000, license: 'by', license_version: '4.0', attribution: '"Test Drop" by Unit Tester is licensed under CC BY 4.0.', url: 'https://cdn.example/song.wav', source: 'jamendo' },
      { id: 'x', title: 'Too short', creator: 'a', duration: 5000, license: 'cc0', url: 'https://cdn.example/s.wav' },
      { id: 'y', title: 'Mature', creator: 'b', duration: 90000, mature: true, license: 'cc0', url: 'https://cdn.example/m.wav' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u === `https://api.openverse.org/v1/audio/${ID}/`) { counts.meta++; return new Response(JSON.stringify({ url: 'https://cdn.example/song.wav' }), { status: 200 }); }
  if (u === 'https://cdn.example/song.wav') {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const a = +m[1], b = Math.min(+m[2], songBuf.length - 1);
    counts.ranges.push([a, b]);
    if (a >= songBuf.length) return new Response(null, { status: 416 });
    return new Response(songBuf.subarray(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${songBuf.length}`, 'content-type': 'audio/wav' } });
  }
  throw new Error('unexpected fetch ' + u);
};

async function callHandler(handler, query) {
  return new Promise((resolve) => {
    const out = { status: 200, headers: {}, body: Buffer.alloc(0) };
    const res = {
      setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
      status(c) { out.status = c; return res; },
      json(o) { out.headers['content-type'] = 'application/json'; out.body = Buffer.from(JSON.stringify(o)); resolve(out); },
      send(b) { out.body = Buffer.from(b); resolve(out); },
    };
    handler({ query }, res);
  });
}

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// direct handler checks
const bad = await callHandler(audio, { id: '../../etc/passwd' });
check(bad.status === 400, 'audio rejects malformed id');
const big = await callHandler(audio, { id: ID, start: '0', end: String(50e6) });
check(big.body.length <= 4 * 1024 * 1024, `audio caps chunk size (${big.body.length} bytes)`);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.route('**/api/**', async (route) => {
  const u = new URL(route.request().url());
  const handler = u.pathname === '/api/music' ? music : audio;
  const out = await callHandler(handler, Object.fromEntries(u.searchParams));
  if (out.body.length > 4.5 * 1024 * 1024) failures++, console.log('FAIL response over Vercel 4.5MB limit');
  await route.fulfill({ status: out.status, headers: out.headers, body: out.body });
});
await page.route('https://cdn.example/**', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: songBuf }));
try {
  await page.goto(appUrl);
  // duration parsing
  const d = await page.evaluate(() => {
    const p = (t) => window.__rawreel.parsePrompt(t).duration;
    return [
      p('Make it cinematic, keep each slow-mo shot about 0.5 seconds or 1 second, use 2-3 seconds of each clip. 20 seconds duration'),
      p('15 sec reel'), p('30 सेकंड की रील'), p('1 minute video'), p('reel with fast cuts'), p('16:9 4K 60fps footage'),
    ];
  });
  check(JSON.stringify(d) === JSON.stringify([20, 15, 30, 60, null, null]), `duration parsing ${JSON.stringify(d)}`);
  check(await page.$('#examples') === null, 'example prompt chips removed');
  const chips = await page.$$eval('#durChips button', (b) => b.map((x) => x.textContent));
  check(chips.length === 7 && chips[0].startsWith('Auto') && chips[6] === '60s', `duration chips ${JSON.stringify(chips)}`);
  await page.fill('#prompt', 'travel reel, 20 seconds duration');
  await page.waitForFunction(() => document.querySelector('#durChips button').textContent === 'Auto · 20s');
  check(true, 'Auto chip follows prompt (20s)');
  await page.click('#durChips button:nth-child(4)');
  check(await page.$eval('#durSel', (s) => s.value) === '20', 'tapping 20s chip selects 20');

  await page.setInputFiles('#clipInput', path.resolve(clip));
  await page.waitForFunction(() => document.querySelectorAll('#clipList .clip').length === 1, null, { timeout: 60000 });
  await page.click('#openMusic');
  await page.waitForSelector('#musicSheet:not(.hidden) .track', { timeout: 20000 });
  const rows = await page.$$eval('.track .t', (t) => t.map((x) => x.textContent));
  check(rows.length === 1 && rows[0] === 'Test Drop', `library lists usable tracks only ${JSON.stringify(rows)}`);
  await page.screenshot({ path: path.join(path.dirname(path.resolve(song)), 'sheet.png') });
  await page.click('.track .use');
  await page.waitForFunction(() => /BPM/.test(document.querySelector('#musicInfo').textContent), null, { timeout: 60000 });
  const info = (await page.textContent('#musicInfo')).trim();
  check(/Test Drop/.test(info) && /Unit Tester/.test(info) && /CC BY 4\.0/.test(info), `music card shows title, artist, credit: ${info.slice(0, 160)}`);
  check(/~120 BPM/.test(info) && /drop @ 0:(19|20|21)/.test(info), 'downloaded song analysed (120 BPM, drop ~20s)');
  check(counts.ranges.length >= 3, `song fetched in ${counts.ranges.length} chunks for ${songBuf.length} bytes`);
  await page.click('#planBtn');
  await page.waitForSelector('#plan:not(.hidden)', { timeout: 180000 });
  const head = (await page.textContent('#planHead')).trim();
  check(/20s/.test(head) && /drop @/.test(head), `plan uses 20s + library song: ${head}`);
  // auto score option clears music
  await page.click('#openMusic');
  await page.click('#noMusic');
  check((await page.textContent('#musicInfo')).trim() === '', 'Auto score removes the song');
} catch (e) {
  failures++; console.log('FAIL', e.message);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
