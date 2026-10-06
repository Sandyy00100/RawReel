// Simulates a phone hardware encoder that accepts a config and then fails
// mid-render (seen on Android). Checks that the render retries with the next
// encoder and finishes, and that when every encoder fails the error is shown
// on the render screen with details.
// Usage: node tests/encoder-fallback.mjs <clip> [--url http://localhost:8765/index.html]
import path from 'node:path';
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;
const clip = process.argv[2];
const ui = process.argv.indexOf('--url');
const appUrl = ui > 0 ? process.argv[ui + 1] : 'http://localhost:8765/index.html';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// failCodecs: codec prefixes whose encoder "dies" after 30 frames
function sabotage(failCodecs) {
  const Real = window.VideoEncoder;
  window.__configs = [];
  window.VideoEncoder = class extends Real {
    constructor(init) {
      let n = 0; let doomed = false; let onErr = init.error;
      super({ output: init.output, error: (e) => onErr(e) });
      this.__count = () => { n++; if (doomed && n === 30) setTimeout(() => onErr(new DOMException('Encoder failure (simulated)', 'EncodingError')), 0); };
      this.__doom = (c) => { doomed = failCodecs.some((p) => c.startsWith(p)); };
    }
    configure(c) { window.__configs.push(c.codec); this.__doom(c.codec); return super.configure(c); }
    encode(f, o) { this.__count(); return super.encode(f, o); }
  };
  window.VideoEncoder.isConfigSupported = Real.isConfigSupported.bind(Real);
}

async function run(failCodecs) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.addInitScript(sabotage, failCodecs);
  await page.goto(appUrl);
  await page.setInputFiles('#clipInput', path.resolve(clip));
  await page.waitForFunction(() => document.querySelectorAll('#clipList .clip').length === 1, null, { timeout: 60000 });
  await page.click('#durChips button:nth-child(2)'); // 10s
  await page.click('details.adv summary');
  await page.selectOption('#qualSel', '720');
  await page.click('#planBtn');
  await page.waitForSelector('#plan:not(.hidden)', { timeout: 120000 });
  await page.click('#renderBtn');
  await page.waitForFunction(() => !document.querySelector('#resultActions').classList.contains('hidden') || !document.querySelector('#renderErr').classList.contains('hidden'), null, { timeout: 900000 });
  const result = {
    ok: !(await page.$eval('#resultActions', (e) => e.classList.contains('hidden'))),
    err: await page.$eval('#renderErr', (e) => (e.classList.contains('hidden') ? '' : e.textContent)),
    progress: (await page.textContent('#renderProgress .ptext')).trim(),
    note: (await page.textContent('#renderNote')).trim(),
    configs: await page.evaluate(() => window.__configs),
  };
  await browser.close();
  return result;
}

const a = await run(['vp09']);
console.log(JSON.stringify(a));
check(a.ok && /av01/.test(a.progress), 'VP9 dies at frame 30 → retried with AV1 and finished');
check(a.configs[0].startsWith('vp09') && a.configs.some((c) => c.startsWith('av01')), `encoders tried in order: ${a.configs.join(', ')}`);

const b = await run(['vp09', 'av01', 'avc1']);
console.log(JSON.stringify(b));
check(!b.ok && /EncodingError/.test(b.err) && /frame/.test(b.err) && /Tried:/.test(b.err), 'all encoders fail → detailed error shown on render screen');
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
