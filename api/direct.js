// POST /api/direct  { prompt, context }  ->  { direction }
// Reads the user's free-text prompt with Claude and returns a structured edit
// direction that the in-browser editor follows (style, pacing, slow motion,
// transitions, colour, titles...). The video itself never leaves the device:
// only the prompt text and a few clip facts (durations, orientation) are sent.
//
// Env: ANTHROPIC_API_KEY (required), RAWREEL_ACCESS_CODE (optional but
// recommended: without it anyone who finds the site can spend your API credit).
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;

const STYLES = ['blockbuster', 'moody', 'energetic', 'dreamy', 'vintage', 'noir', 'neon', 'nature'];
const TRANSITIONS = ['cut', 'whip', 'zoom', 'flash', 'dip', 'rgb'];

const SCHEMA = {
  type: 'object',
  properties: {
    style: { type: 'string', enum: STYLES },
    duration_seconds: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    pace: { type: 'string', enum: ['slow', 'normal', 'fast'] },
    slow_motion: { type: 'string', enum: ['none', 'subtle', 'strong'] },
    close_ups: { type: 'string', enum: ['few', 'normal', 'many'] },
    camera_shake: { type: 'boolean' },
    cinema_bars: { type: 'string', enum: ['auto', 'on', 'off'] },
    story_order: { type: 'boolean' },
    sound_effects: { type: 'boolean' },
    original_sound: { type: 'string', enum: ['auto', 'on', 'off'] },
    prefer_transitions: { type: 'array', items: { type: 'string', enum: TRANSITIONS } },
    avoid_transitions: { type: 'array', items: { type: 'string', enum: TRANSITIONS } },
    warmth: { type: 'string', enum: ['cooler', 'neutral', 'warmer'] },
    saturation: { type: 'string', enum: ['muted', 'normal', 'vivid'] },
    contrast: { type: 'string', enum: ['soft', 'normal', 'punchy'] },
    film_grain: { type: 'string', enum: ['none', 'light', 'heavy'] },
    titles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, when: { type: 'string', enum: ['opening', 'middle', 'ending'] } },
        required: ['text', 'when'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
    not_possible: { type: 'array', items: { type: 'string' } },
  },
  required: ['style', 'duration_seconds', 'pace', 'slow_motion', 'close_ups', 'camera_shake', 'cinema_bars', 'story_order', 'sound_effects', 'original_sound', 'prefer_transitions', 'avoid_transitions', 'warmth', 'saturation', 'contrast', 'film_grain', 'titles', 'summary', 'not_possible'],
  additionalProperties: false,
};

const SYSTEM = `You are the director inside RawReel, a phone app that automatically edits a user's own camera clips into a short vertical reel for Instagram Reels / YouTube Shorts. The user writes a free-text prompt (often Hindi, English or Hinglish, sometimes a long "master prompt" copied from elsewhere). Your job is to turn it into settings for the app's automatic editor. You do not edit video yourself.

What the editor can do, and nothing more:
- Pick the best moments from the clips (sharp, well exposed, with motion), reframe them to 9:16 around the subject, and cut on the music beat.
- Structure: a hook (best moment first), a build, a hero shot with a speed ramp (fast, then slow motion, then fast) on the music drop, a faster climax, and a slow outro that fades to black.
- Camera moves made by digitally zooming into the footage: wide, medium, close-up punch-ins, push-in, pull-out, pan, slight dutch tilt. Close-ups are limited by the clip's resolution.
- Transitions: cut, whip pan, zoom punch, white flash, dip to black, RGB glitch.
- Looks (style): blockbuster (teal & orange), moody (dark, desaturated, emotional), energetic (hype, fast), dreamy (romantic, soft glow), vintage (film grain, faded), noir (black & white), neon (night city), nature (vivid travel). Plus warmth, saturation, contrast and film grain adjustments on top of the look.
- Cinema letterbox bars, impact camera shake, generated whoosh/boom sound effects, the user's chosen song or a generated score, optional original clip sound.
- Text titles at the opening, middle or ending of the reel.

It cannot: generate new footage or AI visuals, remove or replace backgrounds or objects, track or blur faces, add stickers or emojis, do voice-over or speech-to-text captions, change the music itself, stabilise shaky footage, or follow per-second instructions about which exact clip goes where.

How to fill the settings:
- Choose the style that best matches the overall mood the user describes. If they ask for a look in words ("warm golden", "moody blue", "high contrast"), express it with style plus warmth/saturation/contrast/film_grain.
- duration_seconds: the reel length the user asks for, 6 to 60; null if they don't say.
- slow_motion "none" only if the user rejects slow motion; "strong" if they emphasise it.
- Titles: only text the user explicitly wants on screen (quoted text, a name, a caption they spell out). Keep the user's wording and language. Do not invent titles. At most 4.
- prefer/avoid transitions only when the prompt implies it (e.g. "smooth" -> prefer dip/cut and avoid glitch/whip; "no flashy effects" -> avoid flash/rgb/whip). Otherwise leave both empty.
- original_sound "on" only if they want to keep real sounds/dialogue; "off" if they want music only.
- If the user conditions something on their footage ("only if it exists in my footage"), the editor only ever uses their footage, so treat it as satisfied.
- summary: one short sentence, in the same language and script the user wrote in, telling them what the reel will be like.
- not_possible: each requested thing the editor cannot do, as a short phrase in the user's language. Empty if everything is covered.`;

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); } }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(503).json({ error: 'no_key' }); return; }
  const code = process.env.RAWREEL_ACCESS_CODE;
  if (code && req.headers['x-rawreel-code'] !== code) { res.status(401).json({ error: 'code' }); return; }

  const body = await readBody(req);
  const prompt = String(body.prompt || '').trim().slice(0, 6000);
  if (!prompt) { res.status(400).json({ error: 'empty prompt' }); return; }
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const clips = Array.isArray(ctx.clips) ? ctx.clips.slice(0, 20).map((c) => `${Number(c.duration || 0).toFixed(1)}s ${Number(c.width) > Number(c.height) ? 'landscape' : 'portrait'} ${Number(c.width) || '?'}x${Number(c.height) || '?'}`) : [];
  const facts = [
    clips.length ? `Clips: ${clips.join('; ')}` : 'Clips: not loaded yet',
    `Music: ${ctx.hasMusic ? 'the user picked a song' : 'none (the app generates a score)'}`,
    ctx.durationLocked ? `The user already chose a ${Number(ctx.durationLocked)}s length with a button; use that.` : 'Length: not chosen with a button.',
  ].join('\n');

  const client = new Anthropic({ timeout: 55 * 1000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `${facts}\n\n<user_prompt>\n${prompt}\n</user_prompt>` }],
    });
    if (response.stop_reason === 'refusal') { res.status(422).json({ error: 'refused' }); return; }
    if (response.stop_reason === 'max_tokens') { res.status(502).json({ error: 'truncated' }); return; }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let direction;
    try { direction = JSON.parse(text); } catch (e) { res.status(502).json({ error: 'bad json' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ direction, model: response.model });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) res.status(503).json({ error: 'bad_key' });
    else if (e instanceof Anthropic.RateLimitError) res.status(429).json({ error: 'rate_limited' });
    else if (e instanceof Anthropic.APIConnectionTimeoutError) res.status(504).json({ error: 'timeout' });
    else if (e instanceof Anthropic.APIError) res.status(502).json({ error: `api ${e.status || ''}`.trim() });
    else res.status(500).json({ error: 'failed' });
  }
};
