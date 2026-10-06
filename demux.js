/*
 * RawReel frame source: reads MP4/MOV camera files and decodes frames with
 * WebCodecs VideoDecoder instead of an HTML <video> element.
 *
 * Why: on some Android phones Chrome marks <video> frames as "cross-origin
 * tainted" partway through, which blocks reading pixels. Frames we decode
 * ourselves can never be tainted. Decoding forward is also much faster than
 * seeking a <video> for every frame.
 *
 * parseMP4(file) works in Node too (used by tests). DecodedSource is browser-only.
 */
(function (root) {
  'use strict';

  const type4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

  async function readDV(file, start, end) {
    const buf = await file.slice(start, end).arrayBuffer();
    return new DataView(buf);
  }

  function boxesIn(dv, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let len = dv.getUint32(p);
      const type = type4(dv, p + 4);
      let hdr = 8;
      if (len === 1) { len = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (len === 0) len = end - p;
      if (len < hdr || p + len > end) break;
      out.push({ type, start: p + hdr, end: p + len });
      p += len;
    }
    return out;
  }
  const child = (dv, box, type) => (box ? boxesIn(dv, box.start, box.end).find((b) => b.type === type) : undefined);
  const path = (dv, box, ...types) => { let b = box; for (const t of types) { b = child(dv, b, t); if (!b) return undefined; } return b; };

  function hevcCodec(prefix, b) {
    const space = b[1] >> 6, tier = (b[1] >> 5) & 1, idc = b[1] & 31;
    let compat = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
    let rev = 0;
    for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = [b[6], b[7], b[8], b[9], b[10], b[11]];
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    let s = `${prefix}.${['', 'A', 'B', 'C'][space]}${idc}.${rev.toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${b[12]}`;
    for (const c of cons) s += '.' + c.toString(16).toUpperCase();
    return s;
  }

  // Reads the sample table of the first video track. Throws for files it
  // cannot handle (fragmented MP4, no video, unknown codec).
  async function parseMP4(file) {
    const size = file.size;
    let pos = 0, moov = null, guard = 0, fragmented = false;
    while (pos + 8 <= size && guard++ < 100000) {
      const h = await readDV(file, pos, Math.min(size, pos + 16));
      let len = h.getUint32(0); const type = type4(h, 4); let hdr = 8;
      if (len === 1) { len = Number(h.getBigUint64(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr) break;
      if (type === 'moov') moov = { start: pos + hdr, end: pos + len };
      if (type === 'moof') fragmented = true;
      pos += len;
    }
    if (!moov) throw new Error('no moov box');
    if (fragmented) throw new Error('fragmented mp4 not supported');
    if (moov.end - moov.start > 64 * 1024 * 1024) throw new Error('moov too large');
    const base = moov.start;
    const dv = await readDV(file, moov.start, moov.end);
    const root0 = { start: 0, end: dv.byteLength };
    const trak = boxesIn(dv, 0, dv.byteLength).filter((b) => b.type === 'trak').find((t) => {
      const hdlr = path(dv, t, 'mdia', 'hdlr');
      return hdlr && type4(dv, hdlr.start + 8) === 'vide';
    });
    void root0; void base;
    if (!trak) throw new Error('no video track');

    // rotation from the track header matrix (clockwise, in display coordinates)
    const tkhd = child(dv, trak, 'tkhd');
    let rotation = 0;
    if (tkhd) {
      const v = dv.getUint8(tkhd.start);
      const m = tkhd.start + 4 + (v === 1 ? 32 : 20) + 16;
      const a = dv.getInt32(m) / 65536, b = dv.getInt32(m + 4) / 65536;
      const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
      rotation = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
    }
    const mdhd = path(dv, trak, 'mdia', 'mdhd');
    const mv = dv.getUint8(mdhd.start);
    const timescale = dv.getUint32(mdhd.start + 4 + (mv === 1 ? 16 : 8));
    const stbl = path(dv, trak, 'mdia', 'minf', 'stbl');
    if (!stbl) throw new Error('no sample table');
    const sub = {}; for (const b of boxesIn(dv, stbl.start, stbl.end)) sub[b.type] = b;

    // sample description → codec string + decoder description
    const stsd = sub.stsd;
    const entry = boxesIn(dv, stsd.start + 8, stsd.end)[0];
    let etype = type4(dv, entry.start - 4);
    const codedWidth = dv.getUint16(entry.start + 24), codedHeight = dv.getUint16(entry.start + 26);
    const cfgBoxes = boxesIn(dv, entry.start + 78, entry.end);
    const bytes = (b) => new Uint8Array(dv.buffer, dv.byteOffset + b.start, b.end - b.start).slice();
    let codec, description = null;
    // Dolby Vision profile 8/9 (common on Android "HDR" recordings) carries a
    // normal HEVC/AVC base layer: decode it as plain HEVC/AVC.
    const DV = { dvh1: 'hvc1', dvhe: 'hev1', dva1: 'avc1', dvav: 'avc3' };
    if (DV[etype]) etype = DV[etype];
    if (etype === 'avc1' || etype === 'avc3') {
      const c = cfgBoxes.find((b) => b.type === 'avcC'); if (!c) throw new Error('no avcC');
      description = bytes(c);
      codec = `${etype}.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
    } else if (etype === 'hvc1' || etype === 'hev1') {
      const c = cfgBoxes.find((b) => b.type === 'hvcC'); if (!c) throw new Error('no hvcC');
      description = bytes(c);
      codec = hevcCodec(etype, description);
    } else if (etype === 'vp09') {
      const c = cfgBoxes.find((b) => b.type === 'vpcC'); if (!c) throw new Error('no vpcC');
      const p = c.start + 4;
      codec = `vp09.${String(dv.getUint8(p)).padStart(2, '0')}.${String(dv.getUint8(p + 1)).padStart(2, '0')}.${String(dv.getUint8(p + 2) >> 4).padStart(2, '0')}`;
    } else if (etype === 'av01') {
      const c = cfgBoxes.find((b) => b.type === 'av1C'); if (!c) throw new Error('no av1C');
      description = bytes(c);
      const b1 = description[1], b2 = description[2];
      const bd = (b2 & 0x20) ? 12 : (b2 & 0x40) ? 10 : 8;
      codec = `av01.${b1 >> 5}.${String(b1 & 31).padStart(2, '0')}${(b2 & 0x80) ? 'H' : 'M'}.${String(bd).padStart(2, '0')}`;
    } else {
      throw new Error(`unsupported codec ${etype}`);
    }

    // sizes
    const stsz = sub.stsz; if (!stsz) throw new Error('no stsz');
    const fixed = dv.getUint32(stsz.start + 4), n = dv.getUint32(stsz.start + 8);
    if (!n) throw new Error('no samples');
    const sizeA = new Uint32Array(n);
    for (let i = 0; i < n; i++) sizeA[i] = fixed || dv.getUint32(stsz.start + 12 + i * 4);
    // decode times
    const dts = new Float64Array(n);
    { const s = sub.stts; const cnt = dv.getUint32(s.start + 4); let i = 0, t = 0;
      for (let e = 0; e < cnt && i < n; e++) { const c = dv.getUint32(s.start + 8 + e * 8), d = dv.getUint32(s.start + 12 + e * 8); for (let k = 0; k < c && i < n; k++) { dts[i++] = t; t += d; } }
      while (i < n) dts[i++] = t; }
    // composition offsets
    const cts = Float64Array.from(dts);
    if (sub.ctts) { const s = sub.ctts; const ver = dv.getUint8(s.start); const cnt = dv.getUint32(s.start + 4); let i = 0;
      for (let e = 0; e < cnt && i < n; e++) { const c = dv.getUint32(s.start + 8 + e * 8); const o = ver === 1 ? dv.getInt32(s.start + 12 + e * 8) : dv.getUint32(s.start + 12 + e * 8); for (let k = 0; k < c && i < n; k++) cts[i] += o, i++; } }
    // sync samples
    const sync = new Uint8Array(n);
    if (sub.stss) { const s = sub.stss; const cnt = dv.getUint32(s.start + 4); for (let e = 0; e < cnt; e++) { const k = dv.getUint32(s.start + 8 + e * 4) - 1; if (k >= 0 && k < n) sync[k] = 1; } } else sync.fill(1);
    // chunk offsets → sample offsets
    let chunkOff;
    if (sub.stco) { const s = sub.stco; const cnt = dv.getUint32(s.start + 4); chunkOff = new Float64Array(cnt); for (let i = 0; i < cnt; i++) chunkOff[i] = dv.getUint32(s.start + 8 + i * 4); }
    else if (sub.co64) { const s = sub.co64; const cnt = dv.getUint32(s.start + 4); chunkOff = new Float64Array(cnt); for (let i = 0; i < cnt; i++) chunkOff[i] = Number(dv.getBigUint64(s.start + 8 + i * 8)); }
    else throw new Error('no chunk offsets');
    const stsc = sub.stsc; const runs = [];
    { const cnt = dv.getUint32(stsc.start + 4); for (let e = 0; e < cnt; e++) runs.push([dv.getUint32(stsc.start + 8 + e * 12), dv.getUint32(stsc.start + 12 + e * 12)]); }
    const offset = new Float64Array(n);
    { let si = 0;
      for (let ci = 0; ci < chunkOff.length && si < n; ci++) {
        let per = 0; for (const [first, spc] of runs) if (ci + 1 >= first) per = spc;
        let o = chunkOff[ci];
        for (let k = 0; k < per && si < n; k++) { offset[si] = o; o += sizeA[si]; si++; }
      } }
    // presentation times in seconds, starting at 0
    let minC = Infinity, maxC = 0; for (let i = 0; i < n; i++) { if (cts[i] < minC) minC = cts[i]; if (cts[i] > maxC) maxC = cts[i]; }
    const pts = new Float64Array(n); for (let i = 0; i < n; i++) pts[i] = (cts[i] - minC) / timescale;
    const sorted = Array.from(pts).sort((a, b) => a - b);
    const deltas = []; for (let i = 1; i < sorted.length; i++) { const d = sorted[i] - sorted[i - 1]; if (d > 1e-5) deltas.push(d); }
    deltas.sort((a, b) => a - b);
    const frameDur = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 1 / 30;
    const duration = (maxC - minC) / timescale + frameDur;
    const syncIdx = []; for (let i = 0; i < n; i++) if (sync[i]) syncIdx.push(i);
    if (!syncIdx.length) throw new Error('no sync samples');
    return { codec, description, codedWidth, codedHeight, rotation, timescale, n, offset, size: sizeA, pts, sync, syncIdx, duration, fps: Math.round(1 / frameDur) };
  }

  /* ---------------- browser-only decoder ---------------- */
  const ACTIVE = []; // sources with a live decoder, most recent last
  const MAX_ACTIVE = 2; // phones have few hardware decoders
  const MAX_HELD = 6;

  class DecodedSource {
    constructor(file, info, config) {
      this.file = file; this.info = info; this.config = config;
      this.rotation = info.rotation; this.duration = info.duration; this.fps = info.fps;
      this.dec = null; this.held = []; this.next = 0; this.ended = false; this.err = null;
      this.wakers = []; this.lastOutputAt = 0;
    }
    static async open(file) {
      if (!('VideoDecoder' in root) || !('EncodedVideoChunk' in root)) return null;
      const info = await parseMP4(file);
      const config = { codec: info.codec, codedWidth: info.codedWidth, codedHeight: info.codedHeight, optimizeForLatency: true };
      if (info.description) config.description = info.description;
      let sup;
      try { sup = await root.VideoDecoder.isConfigSupported(config); } catch (e) { sup = { supported: false }; }
      if (!sup.supported) throw new Error(`${info.codec} not supported by this device's decoder`);
      const s = new DecodedSource(file, info, config);
      try {
        const f = await s.frameAt(Math.min(0.1, info.duration / 2));
        const w = f.displayWidth, h = f.displayHeight;
        s.width = s.rotation % 180 ? h : w; s.height = s.rotation % 180 ? w : h;
      } catch (e) {
        s.close(); // give the hardware decoder back, or Chrome's own player can't open the file either
        throw new Error(`${info.codec}: ${(e && e.message) || e}`);
      }
      s.release(); // free the hardware until analysis/render needs it
      return s;
    }
    _wake() { const w = this.wakers; this.wakers = []; for (const r of w) r(); }
    _wait(ms) { return new Promise((r) => { this.wakers.push(r); setTimeout(r, ms); }); }
    _ensureDecoder() {
      if (this.dec && this.dec.state !== 'closed') { const i = ACTIVE.indexOf(this); if (i >= 0) ACTIVE.splice(i, 1); ACTIVE.push(this); return false; }
      while (ACTIVE.length >= MAX_ACTIVE) ACTIVE.shift().release();
      this.dec = new root.VideoDecoder({
        output: (f) => {
          this.lastOutputAt = performance.now();
          let i = this.held.length; while (i > 0 && this.held[i - 1].timestamp > f.timestamp) i--;
          this.held.splice(i, 0, f);
          while (this.held.length > MAX_HELD) this.held.shift().close();
          this._wake();
        },
        error: (e) => { this.err = e; this._wake(); },
      });
      ACTIVE.push(this);
      return true;
    }
    release() { // frees the hardware decoder; it is recreated on next use
      for (const f of this.held) f.close();
      this.held = [];
      if (this.dec && this.dec.state !== 'closed') { try { this.dec.close(); } catch (e) { /* ignore */ } }
      this.dec = null;
      const i = ACTIVE.indexOf(this); if (i >= 0) ACTIVE.splice(i, 1);
    }
    close() { this.release(); }
    _reset(k) {
      for (const f of this.held) f.close();
      this.held = [];
      if (!this._ensureDecoder()) { try { this.dec.reset(); } catch (e) { /* ignore */ } }
      this.dec.configure(this.config);
      this.next = k; this.ended = false; this.err = null;
    }
    _keyFor(t) {
      const { syncIdx, pts } = this.info; let k = syncIdx[0];
      for (const i of syncIdx) if (pts[i] <= t + 1e-4) k = i;
      return k;
    }
    async _feed(maxCount) {
      const I = this.info; const start = this.next; let end = start;
      let lo = Infinity, hi = 0;
      while (end < I.n && end - start < maxCount) {
        const nlo = Math.min(lo, I.offset[end]), nhi = Math.max(hi, I.offset[end] + I.size[end]);
        if (end > start && nhi - nlo > 16 * 1024 * 1024) break;
        lo = nlo; hi = nhi; end++;
      }
      if (end === start) return;
      const buf = new Uint8Array(await this.file.slice(lo, hi).arrayBuffer());
      if (!this.dec || this.dec.state !== 'configured' || this.next !== start) return; // reset meanwhile
      for (let i = start; i < end; i++) {
        const o = I.offset[i] - lo;
        this.dec.decode(new root.EncodedVideoChunk({ type: I.sync[i] ? 'key' : 'delta', timestamp: Math.round(I.pts[i] * 1e6), data: buf.subarray(o, o + I.size[i]) }));
      }
      this.next = end;
    }
    _answer(t) {
      const h = this.held; if (!h.length) return null;
      const tu = t * 1e6 + 100;
      let idx = -1; for (let i = 0; i < h.length; i++) if (h[i].timestamp <= tu) idx = i;
      if (h[h.length - 1].timestamp > tu || this.ended) return h[Math.max(0, idx)];
      return null;
    }
    // Returns a VideoFrame for time t (seconds). The frame stays owned by this
    // source and is valid until the next frameAt() call.
    async frameAt(t) {
      if (this.err) throw this.err;
      const I = this.info;
      t = Math.max(0, Math.min(t, I.duration));
      const k = this._keyFor(t);
      const h = this.held;
      const behind = h.length && t * 1e6 + 100 < h[0].timestamp;
      const fresh = this._ensureDecoder();
      if (fresh || this.dec.state !== 'configured' || behind || (this.ended && !this._answer(t)) || k - this.next > 15 || (this.next === 0 && !h.length && k > 0)) this._reset(k);
      else if (!h.length && this.next > k + 600) this._reset(k);
      let stallSince = performance.now();
      for (let guard = 0; guard < 100000; guard++) {
        if (this.err) throw this.err;
        const ans = this._answer(t);
        if (ans) {
          while (this.held.length && this.held[0] !== ans) this.held.shift().close();
          return ans;
        }
        if (this.next < I.n) {
          if (this.dec.decodeQueueSize < 4) { await this._feed(8); stallSince = performance.now(); continue; }
          await this._wait(40);
        } else if (!this.ended) {
          try { await this.dec.flush(); } catch (e) { if (!this.err) this.err = e; }
          this.ended = true;
          if (!this.held.length && !this.err) throw new Error('decoder produced no frames');
          continue;
        } else {
          throw this.err || new Error('frame not found');
        }
        if (performance.now() - Math.max(stallSince, this.lastOutputAt) > 5000) throw new Error('decoder stalled');
      }
      throw new Error('decoder loop guard');
    }
  }

  const api = { parseMP4, DecodedSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RawDemux = api;
})(typeof window !== 'undefined' ? window : globalThis);
