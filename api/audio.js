// GET /api/audio?id=<openverse audio id>&start=<byte>&end=<byte>
// Streams one byte range of a Creative Commons track so the browser can decode
// it for beat detection. Song hosts don't send CORS headers, so the app can't
// fetch them directly. Only tracks listed in Openverse can be fetched (looked up
// by id), so this is not an open proxy. Each response stays under Vercel's
// 4.5 MB body limit; the client asks for consecutive ranges.
const OPENVERSE = 'https://api.openverse.org/v1/audio/';
const UA = 'RawReel/1.0 (+https://github.com/Sandyy00100/RawReel)';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_MAX = 4 * 1024 * 1024; // bytes per response
const FILE_MAX = 40 * 1024 * 1024; // refuse very large files

module.exports = async function handler(req, res) {
  const qs = req.query || {};
  const id = String(qs.id || '');
  if (!ID_RE.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
  const start = Math.max(0, parseInt(qs.start, 10) || 0);
  let end = parseInt(qs.end, 10);
  if (!Number.isFinite(end) || end < start) end = start + CHUNK_MAX - 1;
  end = Math.min(end, start + CHUNK_MAX - 1);
  try {
    const meta = await fetch(OPENVERSE + id + '/', { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!meta.ok) { res.status(404).json({ error: 'track not found' }); return; }
    const track = await meta.json();
    let src;
    try { src = new URL(track.url); } catch (e) { src = null; }
    if (!src || (src.protocol !== 'https:' && src.protocol !== 'http:')) { res.status(502).json({ error: 'bad track url' }); return; }
    const up = await fetch(src, { headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` }, redirect: 'follow' });
    let body; let total;
    if (up.status === 206) {
      const m = /\/(\d+)\s*$/.exec(up.headers.get('content-range') || '');
      total = m ? parseInt(m[1], 10) : 0;
      if (total > FILE_MAX) { res.status(413).json({ error: 'file too large' }); return; }
      body = Buffer.from(await up.arrayBuffer());
    } else if (up.status === 200) {
      const len = parseInt(up.headers.get('content-length') || '0', 10);
      if (len > FILE_MAX) { res.status(413).json({ error: 'file too large' }); return; }
      const full = Buffer.from(await up.arrayBuffer());
      if (full.length > FILE_MAX) { res.status(413).json({ error: 'file too large' }); return; }
      total = full.length;
      body = full.subarray(start, end + 1);
    } else if (up.status === 416) {
      body = Buffer.alloc(0); total = start;
    } else {
      res.status(502).json({ error: `source returned ${up.status}` }); return;
    }
    res.setHeader('Content-Type', up.headers.get('content-type') || 'audio/mpeg');
    if (total) res.setHeader('X-Total-Length', String(total));
    res.setHeader('Cache-Control', 'public, s-maxage=604800, immutable');
    res.status(200).send(body);
  } catch (e) {
    res.status(502).json({ error: 'download failed' });
  }
};
