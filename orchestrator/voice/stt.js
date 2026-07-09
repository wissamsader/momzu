// Local speech-to-text: webm/opus from the mic → ffmpeg → 16k wav → whisper.cpp.
// Everything runs as local subprocesses; no audio leaves the machine.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

export async function transcribe(audioBuffer, sttConfig, rootDir) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jarvis-stt-'));
  const inFile = path.join(dir, 'in.webm');
  const wavFile = path.join(dir, 'in.wav');
  try {
    await writeFile(inFile, audioBuffer);
    // Prefer the ffmpeg bundled in bin/ (self-contained app) over PATH —
    // Macs without Homebrew have no ffmpeg at all.
    const bundledFfmpeg = path.join(rootDir, 'bin/ffmpeg/ffmpeg');
    const ffmpeg = existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg';
    await run(ffmpeg, ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', wavFile]);

    const binary = sttConfig.binary || 'whisper-cli';
    const binaryPath = path.isAbsolute(binary) ? binary : path.join(rootDir, binary);

    // Apple SFSpeechRecognizer (same engine as Onit) — much more accurate than whisper small.
    // Takes just the WAV path + optional language code. No model file needed.
    if (binaryPath.includes('speech-recognizer')) {
      const speechArgs = [wavFile];
      const lang = sttConfig.language;
      if (lang && lang !== 'auto') speechArgs.push(lang);
      const out = await run(binaryPath, speechArgs);
      return out.replace(/\s+/g, ' ').trim();
    }

    // whisper.cpp
    const modelPath = path.isAbsolute(sttConfig.model)
      ? sttConfig.model
      : path.join(rootDir, sttConfig.model);
    // Bundled whisper-cli when the config points at one that exists in the
    // bundle; otherwise the bare name resolves via PATH (Homebrew install).
    const bin = existsSync(binaryPath) ? binaryPath : binary;
    const whisper = async (lang) => {
      const jsonBase = path.join(dir, `out-${lang}`);
      const text = await run(bin, [
        '-m', modelPath,
        '-f', wavFile,
        '-l', lang,
        '--no-timestamps',
        '--no-prints',
        '-oj', '-of', jsonBase, // JSON sidecar carries the detected language
      ]);
      let detected = lang;
      try {
        detected = JSON.parse(await readFile(`${jsonBase}.json`, 'utf8'))?.result?.language || lang;
      } catch { /* old whisper-cli without result.language — trust the text */ }
      return { text: text.replace(/\s+/g, ' ').trim(), detected };
    };

    const configured = sttConfig.language || 'auto';
    let { text, detected } = await whisper(configured);
    // Language-detection guardrail: short accented clips make whisper
    // "detect" random languages (Icelandic, Danish…) and transcribe garbage.
    // If auto lands outside the user's languages, redo pinned to the first
    // allowed one (extra pass only on misdetection).
    const allowed = Array.isArray(sttConfig.languages) && sttConfig.languages.length
      ? sttConfig.languages : null;
    if (configured === 'auto' && allowed && !allowed.includes(detected)) {
      console.log(`[stt] whisper detected "${detected}" — outside {${allowed}}, retrying as "${allowed[0]}"`);
      ({ text } = await whisper(allowed[0]));
    }
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
