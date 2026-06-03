# ANN Demo Video Production Guide

This folder contains a video-ready HTML deck and English voiceover.

## Files

- `ann-demo.html` - animated full-page presentation deck
- `voiceover-en.md` - timed English narration script
- `voiceover-en.txt` - plain text used by text-to-speech
- `render-video.mjs` - creates screenshots, voiceover audio, and a 1080p MP4

## Live Recording

Open the deck in a browser:

```bash
open docs/demo/ann-demo.html
```

Controls:

- Mouse wheel or arrow keys: change slides
- `P`: autoplay through the deck
- `?autoplay=1`: start autoplay from slide one

## Generate MP4 Locally

Requirements:

- Chromium at `/opt/homebrew/bin/chromium`, or set `CHROMIUM_PATH`
- macOS `say`
- `ffmpeg`

Run:

```bash
node docs/demo/render-video.mjs
```

Output:

```bash
docs/demo/out/ann-demo.mp4
```

The generated MP4 uses the HTML deck as the visual source and the English voiceover text as the narration source. For a production upload, replace the synthetic voice with a recorded human voice or a licensed commercial voiceover, then mux it with the same visual track.
