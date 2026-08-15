// Generates the tour narration MP3s from src/tour.json using Microsoft's
// neural voices via edge-tts (runs through pipx, no install/API key needed).
// Run: node scripts/generate-narration.mjs
// Output: public/audio/tour-<i>.mp3

import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const VOICE = 'en-US-AndrewMultilingualNeural'; // deep, documentary style
const RATE = '-4%';

const stops = JSON.parse(
  await readFile(new URL('../src/tour.json', import.meta.url), 'utf8')
);
const outDir = new URL('../public/audio/', import.meta.url);
await mkdir(outDir, { recursive: true });

stops.forEach((s, i) => {
  const out = new URL(`tour-${i}.mp3`, outDir).pathname;
  console.log(`  ${i}: ${s.title}`);
  execFileSync('pipx', [
    'run', 'edge-tts',
    '--voice', VOICE,
    '--rate', RATE,
    '--text', `${s.title}. ${s.text}`,
    '--write-media', out,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
});
console.log(`Done — ${stops.length} narration files.`);
