// Simulates Chrome on Android marking <video> frames as cross-origin
// "tainted" (SecurityError on getImageData). Checks that the app rebuilds the
// <video> and continues, and that a permanent block shows a clear message.
// Usage: node tests/taint.mjs <webm clip> [--url ...]
import path from 'node:path';
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;
const clip = process.argv[2];
const ui = process.argv.indexOf('--url');
const appUrl = ui > 0 ? process.argv[ui + 1] : 'http://localhost:8765/index.html';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };
function taint(mode) {
  const real = CanvasRenderingContext2D.prototype.getImageData;
  let calls = 0; window.__taints = 0;
  CanvasRenderingContext2D.prototype.getImageData = function (...a) {
    calls++;
    if ((mode === 'once' && calls === 12) || (mode === 'always' && calls > 3)) { window.__taints++; throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError'); }
    return real.apply(this, a);
  };
}
async function run(mode) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.addInitScript(taint, mode);
  await page.goto(appUrl);
  await page.setInputFiles('#clipInput', path.resolve(clip));
  await page.waitForFunction(() => document.querySelectorAll('#clipList .clip').length === 1, null, { timeout: 60000 });
  await page.click('#planBtn');
  await page.waitForFunction(() => !document.querySelector('#plan').classList.contains('hidden') || !document.querySelector('#errBox').classList.contains('hidden'), null, { timeout: 180000 });
  const r = { planned: !(await page.$eval('#plan', (e) => e.classList.contains('hidden'))), err: await page.$eval('#errBox', (e) => (e.classList.contains('hidden') ? '' : e.textContent)), taints: await page.evaluate(() => window.__taints) };
  await browser.close();
  return r;
}
const a = await run('once');
check(a.planned && a.taints === 1 && !a.err, `one-off taint during analysis → video rebuilt, plan made ${JSON.stringify(a)}`);
const b = await run('always');
check(!b.planned && /security block/.test(b.err), `permanent taint → clear message: ${b.err.slice(0, 80)}`);
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
