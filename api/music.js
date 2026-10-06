// GET /api/music?q=<search>
// Searches Openverse for Creative Commons music that may be used commercially
// and modified (CC0, CC BY, CC BY-SA, public domain), i.e. safe to cut into a reel.
const OPENVERSE = 'https://api.openverse.org/v1/audio/';
const UA = 'RawReel/1.0 (+https://github.com/Sandyy00100/RawReel)';

module.exports = async function handler(req, res) {
  const q = String((req.query && req.query.q) || '').trim().slice(0, 80) || 'cinematic';
  const url = new URL(OPENVERSE);
  url.searchParams.set('q', q);
  url.searchParams.set('category', 'music');
  url.searchParams.set('license_type', 'commercial,modification');
  url.searchParams.set('page_size', '20');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) { res.status(502).json({ error: `catalog returned ${r.status}` }); return; }
    const data = await r.json();
    const results = (data.results || [])
      .filter((t) => t.url && !t.mature && (!t.duration || t.duration >= 20000))
      .map((t) => ({
        id: t.id,
        title: t.title,
        creator: t.creator,
        duration: t.duration,
        license: `${t.license || ''}${t.license_version ? ' ' + t.license_version : ''}`.trim(),
        attribution: t.attribution,
        url: t.url,
        source: t.source,
      }));
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ results });
  } catch (e) {
    res.status(502).json({ error: 'catalog unreachable' });
  }
};
