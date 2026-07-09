// Round-trip test of the local voice pipeline: say → wav → whisper transcript.
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { transcribe } from '../orchestrator/voice/stt.js';
import { synthesize } from '../orchestrator/voice/tts.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = '/tmp/jarvis-voice-test.wav';

// 1. TTS: synthesize a phrase
const wav = await synthesize('Good evening. All systems are online.', { engine: 'say', rate: 190 }, ROOT);
console.log('TTS ok:', wav.length, 'bytes,', wav.slice(0, 4).toString(), 'header');

// 2. STT: speak a phrase to a wav file with `say`, then transcribe it
await new Promise((res, rej) => {
  const child = spawn('say', ['-o', tmp, '--data-format=LEI16@22050', 'hello jarvis open the vault']);
  child.on('close', (code) => code === 0 ? res() : rej(new Error('say failed')));
});
const audio = await readFile(tmp);
const text = await transcribe(audio, { binary: 'whisper-cli', model: 'bin/whisper/models/ggml-base.en.bin' }, ROOT);
console.log('STT ok:', JSON.stringify(text));
await rm(tmp, { force: true });

if (!/jarvis/i.test(text)) throw new Error('transcript did not contain expected words');
console.log('VOICE LOOP PASS');
