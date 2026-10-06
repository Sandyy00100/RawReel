// Clip loading failure paths: a decoder that stalls must be closed (so Chrome's
// own player can still get the hardware decoder) and the clip must load through
// the fallback; an unreadable file must give a detailed error.
// Usage: node tests/load-errors.mjs <good.mp4> <broken.mp4> [--url ...]
import path from 'node:path';
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;
const [good, broken] = process.argv.slice(2);
const ui = process.argv.indexOf('--url');
const appUrl = ui > 0 ? process.argv[ui + 1] : 'http://localhost:8765/index.html';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

// 1) decoder never outputs frames
let page = await browser.newPage();
await page.addInitScript(() => {
  window.__decoders = { made: 0, closed: 0 };
  const Real = window.VideoDecoder;
  window.VideoDecoder = class extends Real {
    constructor(init) { super(init); window.__decoders.made++; }
    decode() { /* swallow: simulate a stalled hardware decoder */ }
    close() { window.__decoders.closed++; return super.close(); }
  };
  window.VideoDecoder.isConfigSupported = Real.isConfigSupported.bind(Real);
});
await page.goto(appUrl);
await page.setInputFiles('#clipInput', path.resolve(good));
await page.waitForFunction(() => document.querySelectorAll('#clipList .clip').length === 1 || !document.querySelector('#errBox').classList.contains('hidden'), null, { timeout: 60000 });
const r1 = await page.evaluate(() => ({ clips: window.__rawreel.state.clips.map((c) => ({ dec: !!c.dec, video: !!c.video, w: c.w, h: c.h })), d: window.__decoders, err: document.querySelector('#errBox').textContent }));
console.log(JSON.stringify(r1));
check(r1.clips.length === 1 && !r1.clips[0].dec && r1.clips[0].video, 'stalled decoder → clip loaded via Chrome player');
check(r1.d.made >= 1 && r1.d.closed >= r1.d.made, `every decoder created was closed (${r1.d.closed}/${r1.d.made})`);
await page.close();

// 2) unreadable file
page = await browser.newPage();
await page.goto(appUrl);
await page.setInputFiles('#clipInput', path.resolve(broken));
await page.waitForFunction(() => !document.querySelector('#errBox').classList.contains('hidden'), null, { timeout: 60000 });
const err = await page.textContent('#errBox');
console.log(err);
check(/Details: fast decoder: .+; Chrome player: .+/.test(err), 'error explains both decoder and player failures');
await page.close();

// 3) normal file still uses the fast path and releases the decoder after loading
page = await browser.newPage();
await page.addInitScript(() => {
  window.__decoders = { made: 0, closed: 0 };
  const Real = window.VideoDecoder;
  window.VideoDecoder = class extends Real { constructor(i) { super(i); window.__decoders.made++; } close() { window.__decoders.closed++; return super.close(); } };
  window.VideoDecoder.isConfigSupported = Real.isConfigSupported.bind(Real);
});
await page.goto(appUrl);
await page.setInputFiles('#clipInput', path.resolve(good));
await page.waitForFunction(() => document.querySelectorAll('#clipList .clip').length === 1, null, { timeout: 60000 });
const r3 = await page.evaluate(() => ({ dec: !!window.__rawreel.state.clips[0].dec, thumb: !!window.__rawreel.state.clips[0].thumb, d: window.__decoders }));
check(r3.dec && r3.thumb, 'good file → fast decoder (⚡) with thumbnail');
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
