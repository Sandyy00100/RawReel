// End-to-end smoke test: drives the real UI in headless Chromium, renders a reel
// and saves it so it can be checked with ffprobe.
//
// Usage:
//   npx http-server . -p 8765 &
//   node tests/smoke.mjs <clip1> [clip2 ...] [--music file] [--prompt "..."] [--quality 720] [--aspect 9:16] [--out out.mp4]
//
// Needs Playwright. Set PLAYWRIGHT_PATH if it is installed globally.
import fs from 'node:fs';
import path from 'node:path';

const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const { chromium } = pw.default || pw;

const args = process.argv.slice(2);
const opt = { clips: [], music: null, prompt: 'Epic cinematic travel reel, slow motion at the peak, close-ups, "GOA DIARIES" "THE END"', quality: '720', aspect: '9:16', out: 'smoke-out.mp4', url: 'http://localhost:8765/index.html', shot: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--music') opt.music = args[++i];
  else if (a === '--prompt') opt.prompt = args[++i];
  else if (a === '--quality') opt.quality = args[++i];
  else if (a === '--aspect') opt.aspect = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--url') opt.url = args[++i];
  else if (a === '--screenshot') opt.shot = args[++i];
  else opt.clips.push(a);
}
if (!opt.clips.length) { console.error('give at least one clip'); process.exit(2); }

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
try {
  await page.goto(opt.url);
  await page.setInputFiles('#clipInput', opt.clips.map((c) => path.resolve(c)));
  await page.waitForFunction((n) => document.querySelectorAll('#clipList .clip').length === n, opt.clips.length, { timeout: 60000 });
  if (opt.music) {
    await page.setInputFiles('#musicInput', path.resolve(opt.music));
    await page.waitForFunction(() => /BPM/.test(document.querySelector('#musicInfo').textContent), null, { timeout: 60000 });
    console.log('music:', (await page.textContent('#musicInfo')).trim());
  }
  await page.fill('#prompt', opt.prompt);
  await page.click('details.adv summary');
  await page.selectOption('#qualSel', opt.quality);
  await page.selectOption('#aspectSel', opt.aspect);
  await page.click('#planBtn');
  await page.waitForSelector('#plan:not(.hidden)', { timeout: 180000 });
  console.log('plan:', (await page.textContent('#planHead')).trim());
  console.log('intent:', (await page.textContent('#intent')).trim());
  const shots = await page.$$eval('#shots li', (ls) => ls.map((l) => l.textContent.trim()));
  console.log(shots.join('\n'));
  const warns = await page.$$eval('#warnList li', (ls) => ls.map((l) => l.textContent.trim()));
  if (warns.length) console.log('warnings:', warns);
  const t0 = Date.now();
  await page.click('#renderBtn');
  await page.waitForFunction(() => !document.querySelector('#resultActions').classList.contains('hidden') || !document.querySelector('#errBox').classList.contains('hidden'), null, { timeout: 600000 });
  const err = await page.$eval('#errBox', (e) => (e.classList.contains('hidden') ? '' : e.textContent));
  if (err) throw new Error('app error: ' + err);
  console.log('render:', (await page.textContent('#renderProgress .ptext')).trim(), `(${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);
  const b64 = await page.evaluate(async () => {
    const buf = await (await fetch(window.__rawreel.state.resultUrl)).arrayBuffer();
    let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(opt.out, Buffer.from(b64, 'base64'));
  console.log('saved', opt.out);
  if (opt.shot) await page.screenshot({ path: opt.shot, fullPage: true });
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(logs.slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
