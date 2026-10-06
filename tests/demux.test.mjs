// Unit test for the MP4/MOV sample-table reader (demux.js), checked against
// ffprobe. Usage: node tests/demux.test.mjs <dir with test files>
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { parseMP4 } = require('../demux.js');
const dir = process.argv[2];
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const probe = (f, args) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...args, f], { encoding: 'utf8' });

const cases = [
  { f: 'h264_bf.mp4', codec: /^avc1\.6400(1F|28)$/, rot: 0 },
  { f: 'h264_fast.mp4', codec: /^avc1\.4D[0-9A-F]{2}1F$/, rot: 0 },
  { f: 'hevc.mp4', codec: /^hvc1\.1\.6\.L93(\.[0-9A-F]{1,2})*$/, rot: 0 },
  { f: 'iphone_style.mov', codec: /^avc1\./, rot: 0 },
  { f: 'rot_ccw90.mp4', codec: /^avc1\./, rot: 270 },
  { f: 'vp9.mp4', codec: /^vp09\.00\.\d\d\.08$/, rot: 0 },
  { f: 'vp9_rot.mp4', codec: /^vp09\./, rot: 270 },
];
for (const c of cases) {
  const file = path.join(dir, c.f);
  const info = await parseMP4(new File([fs.readFileSync(file)], c.f));
  const pk = probe(file, ['-show_entries', 'packet=pts_time,size,pos,flags', '-of', 'csv=p=0']).trim().split('\n').map((l) => l.split(','));
  const sizesOk = pk.every(([, size, pos], i) => +size === info.size[i] && +pos === info.offset[i]);
  const keys = pk.filter((p) => p[3].includes('K')).length;
  const ptsF = pk.map((p) => +p[0]); const minP = Math.min(...ptsF);
  const ptsOk = ptsF.every((p, i) => Math.abs(p - minP - info.pts[i]) < 0.002);
  check(info.n === pk.length && sizesOk, `${c.f}: ${info.n} samples, offsets+sizes match ffprobe`);
  check(c.codec.test(info.codec), `${c.f}: codec string ${info.codec}`);
  check(info.syncIdx.length === keys, `${c.f}: ${keys} keyframes`);
  check(ptsOk, `${c.f}: presentation times match (B-frame reordering handled)`);
  check(info.rotation === c.rot, `${c.f}: rotation ${info.rotation}°`);
  check(info.fps === 30 && Math.abs(info.duration - (ptsF.length / 30)) < 0.05, `${c.f}: ${info.fps}fps, ${info.duration.toFixed(2)}s`);
}
// a WebM is not MP4 → must throw so the app falls back to <video>
let threw = false;
try { await parseMP4(new File([fs.readFileSync(path.join(dir, 'vertical.webm'))], 'v.webm')); } catch (e) { threw = true; }
check(threw, 'webm rejected (falls back to <video>)');
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
