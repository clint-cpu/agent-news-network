#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, 'ann-demo.html');
const voiceoverPath = join(__dirname, 'voiceover-en.txt');
const outDir = join(__dirname, 'out');
const framesDir = join(outDir, 'frames');
const audioPath = join(outDir, 'ann-demo-voiceover.aiff');
const videoSilentPath = join(outDir, 'ann-demo-silent.mp4');
const videoPath = join(outDir, 'ann-demo.mp4');
const browserCandidates = [
  process.env.CHROMIUM_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/opt/homebrew/bin/chromium',
  '/usr/bin/chromium'
].filter(Boolean);
const chromium = browserCandidates.find(candidate => existsSync(candidate));

if (!chromium) {
  throw new Error('No Chromium-compatible browser found. Set CHROMIUM_PATH to Chrome or Chromium.');
}

const slideDurations = [11, 12, 13, 14, 15, 14, 14, 16];
const width = 1920;
const height = 1080;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

for (let i = 0; i < slideDurations.length; i += 1) {
  const url = `${pathToFileURL(resolve(htmlPath)).href}?capture=1&slide=${i}`;
  const screenshot = join(framesDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
  execFileSync(chromium, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--screenshot=${screenshot}`,
    url
  ], { stdio: 'inherit' });
}

const concatPath = join(outDir, 'slides.ffconcat');
const concatLines = ['ffconcat version 1.0'];
for (let i = 0; i < slideDurations.length; i += 1) {
  concatLines.push(`file '${join(framesDir, `slide-${String(i + 1).padStart(2, '0')}.png`).replaceAll("'", "'\\''")}'`);
  concatLines.push(`duration ${slideDurations[i]}`);
}
concatLines.push(`file '${join(framesDir, `slide-${String(slideDurations.length).padStart(2, '0')}.png`).replaceAll("'", "'\\''")}'`);
writeFileSync(concatPath, concatLines.join('\n'));

execFileSync('say', ['-v', 'Samantha', '-r', '168', '-o', audioPath, '-f', voiceoverPath], { stdio: 'inherit' });

execFileSync('ffmpeg', [
  '-y',
  '-f', 'concat',
  '-safe', '0',
  '-i', concatPath,
  '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`,
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '18',
  videoSilentPath
], { stdio: 'inherit' });

execFileSync('ffmpeg', [
  '-y',
  '-i', videoSilentPath,
  '-i', audioPath,
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-shortest',
  videoPath
], { stdio: 'inherit' });

console.log(`Created ${videoPath}`);
