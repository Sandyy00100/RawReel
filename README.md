# RawReel

अपनी कैमरा वीडियो डालो, एक प्रॉम्प्ट लिखो, और Instagram Reels / YouTube Shorts के लिए एक सिनेमैटिक रील पाओ।
Upload your own camera clips, describe the vibe, and get a beat-synced, colour-graded, cinematic reel as an MP4.

यह एक standalone web app है। इसका किसी दूसरे प्रोजेक्ट से कोई कोड-लिंक नहीं है। सारी प्रोसेसिंग यूज़र के डिवाइस पर ब्राउज़र में होती है, कोई सर्वर नहीं है और कोई वीडियो अपलोड नहीं होती।

## कैसे इस्तेमाल करें (How to use)

1. **Clips**: एक या ज़्यादा वीडियो चुनें।
2. **Music** (optional): कोई गाना डालें। ऐप उसकी BPM और "drop" ढूँढता है। Cuts बीट पर लगते हैं और drop ठीक hero slow-mo shot पर आता है। गाना न डालें तो ऐप खुद एक cinematic background score और sound effects बनाता है।
3. **Prompt**: जैसे `Epic cinematic travel reel, slow motion at the peak, close-ups, "GOA DIARIES"`। Quotes में लिखा text रील पर title बनकर आता है।
4. **Analyze & Plan**: ऐप फुटेज analyze करके एक shot-by-shot edit plan दिखाता है। पसंद न आए तो **दूसरा वर्ज़न** दबाएँ।
5. **Render Reel**: MP4 बनती है। फिर Download या Share (Android पर सीधे Instagram/YouTube में) करें।

### Prompt में क्या-क्या समझता है

| लिखें | असर |
|---|---|
| cinematic, epic, movie, सिनेमैटिक | Blockbuster teal & orange look |
| gym, dance, bike, hype, जोश | Fast & energetic: quick cuts, whip pans, shake |
| wedding, romantic, love, शादी, प्यार | Dreamy: soft glow, slow pacing |
| moody, sad, rain, उदास, बारिश | Moody: desaturated, cool, slow |
| vintage, retro, 90s, पुराना | Film look: grain, faded blacks |
| black and white, noir | Noir B&W |
| night, neon, city, रात, शहर | Neon night look |
| travel, mountain, beach, सफ़र, पहाड़ | Travel: vivid & clean, story order |
| slow motion, स्लो | Stronger speed ramp |
| fast cuts, तेज़ | Faster cutting |
| close-up, zoom, क्लोज | More punch-in close-ups |
| bars / no bars | Cinema letterbox on/off |
| 10 sec, 20s, 15 सेकंड | Duration |
| "Your Title" | On-screen text (1 = opening title, 2 = + ending, 3–4 = + middle) |

Settings panel में style, duration, format (9:16, 4:5, 1:1, 16:9), quality, fps, bars, original sound और SFX को manually भी बदल सकते हैं।

## Edit के अंदर क्या होता है (How the edit is built)

1. **Footage analysis**: हर क्लिप को ~4 frames/sec पर sample करके sharpness, motion, colourfulness, exposure और subject position निकाली जाती है। Browser सपोर्ट करे तो face detection भी होता है।
2. **Music analysis**: spectral-flux onset detection, autocorrelation से tempo, beat grid, और सबसे बड़ा energy rise यानी drop।
3. **Director** एक viral-reel structure बनाता है:
   - **Hook** (0–1.3s): सबसे दमदार moment, close-up या push-in।
   - **Build**: beat पर cuts, wide/medium/close/pan/dutch-tilt shots में variety।
   - **Hero**: drop पर speed ramp (1.5× → 0.25–0.35× → 1.3×), impact boom, shake और music पर low-pass "muffle"।
   - **Climax**: तेज़ cuts।
   - **Outro**: slow pull-out, ending title, fade to black।
4. **Renderer** (WebGL): smart reframing to 9:16, digital zoom जो source resolution के हिसाब से सीमित रहता है ताकि shots blurry न हों, colour grade, glow, grain, vignette, letterbox, और transitions (whip pan, zoom punch, flash, dip, RGB glitch)। Slow-mo में दो frames को blend किया जाता है।
5. **Audio**: music या generated score, original clip sound, और synthesized SFX (whoosh, boom, hit, riser) का mix, normalized।
6. **Export**: WebCodecs से H.264 + AAC MP4। जहाँ H.264 नहीं है वहाँ VP9/AV1 + Opus।

## Browser support

- **Best**: Android पर Chrome। Desktop पर Chrome या Edge। इनमें H.264 + AAC मिलता है, जो Instagram के लिए सही है।
- iPhone पर Safari 17+ में काम करना चाहिए, पर यह टेस्ट नहीं हुआ है।
- Firefox में H.264 export नहीं होता, और कुछ versions में WebCodecs ही नहीं है।
- HEVC (iPhone "High Efficiency") वीडियो कुछ Android/desktop browsers में नहीं चलती। iPhone पर Settings → Camera → Formats → **Most Compatible** रखें।

## Hosting

यह plain static files हैं: `index.html` और `vendor/mp4-muxer.js`। कोई build step नहीं है। WebCodecs को HTTPS (या localhost) चाहिए। इसलिए इसे GitHub Pages, Netlify या Cloudflare Pages पर डालें।

Local चलाने के लिए:

```
npx http-server . -p 8765
# फिर खोलें http://localhost:8765
```

## Known limitations

- **Render speed**: हर output frame के लिए वीडियो को seek किया जाता है। Desktop/फ़ोन पर 15s की रील में आमतौर पर कुछ दसियों सेकंड से कुछ मिनट तक लगते हैं। Render के दौरान ऐप खुला और स्क्रीन ऑन रखें।
- **Slow-mo smoothness** source fps पर निर्भर है। 60/120 fps में शूट किया फुटेज बहुत smooth slow-mo देता है। 30 fps में frame-blending होती है, असली optical-flow नहीं।
- **Prompt understanding** keyword-based है (English + Hindi + Hinglish)। यह LLM नहीं है।
- **Titles** Google Fonts (Bebas Neue, Playfair Display, Cinzel, Inter) इस्तेमाल करते हैं। Offline होने पर system font लगता है।
- **Memory**: बहुत बड़ी फ़ाइलें (300 MB से ज़्यादा) की original audio skip होती है।

## Tests

`tests/smoke.mjs` headless Chromium में पूरा UI चलाकर एक रील render करता है और MP4 सेव करता है:

```
npx http-server . -p 8765 &
node tests/smoke.mjs clip1.mp4 clip2.mp4 --music song.mp3 --prompt 'Epic travel reel "GOA"' --out out.mp4
ffprobe out.mp4
```

## Third-party

- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) v5.2.2 (MIT). यह `vendor/` में बिना बदलाव के रखा है ताकि ऐप किसी CDN पर निर्भर न रहे।
