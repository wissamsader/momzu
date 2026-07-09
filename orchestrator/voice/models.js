// Whisper model registry + first-run downloader. Models are NOT bundled in
// the app (they were 2 GB of the old DMG) — the orchestrator downloads the
// configured one into ~/.momzu/whisper-models on first launch and falls back
// to any model already on disk while the download runs.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WHISPER_MODELS = {
  'large-v3-turbo-q8_0': { file: 'ggml-large-v3-turbo-q8_0.bin', mb: 874 },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', mb: 1620 },
  'medium': { file: 'ggml-medium.bin', mb: 1530 },
  'small': { file: 'ggml-small.bin', mb: 488 },
  'base.en': { file: 'ggml-base.en.bin', mb: 148 },
};
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
export const MODELS_DIR = path.join(os.homedir(), '.momzu', 'whisper-models');

// Best-first order used when the preferred model isn't on disk yet.
const FALLBACK_ORDER = ['large-v3-turbo-q8_0', 'large-v3-turbo', 'medium', 'small', 'base.en'];

const stripName = (m) => String(m).replace(/^.*\//, '').replace(/^ggml-/, '').replace(/\.bin$/, '');

// Resolve the configured model to an existing file. Accepts a model NAME
// ("large-v3-turbo-q8_0") or a legacy PATH ("bin/whisper/models/ggml-….bin").
// Returns { path, name, fallback } or null when nothing usable exists yet.
export function resolveModelPath(sttConfig, resourcesDir) {
  const conf = sttConfig?.model || 'large-v3-turbo-q8_0';
  if (conf.includes('/') || conf.endsWith('.bin')) {
    const p = path.isAbsolute(conf) ? conf : path.join(resourcesDir, conf);
    if (existsSync(p)) return { path: p, name: stripName(conf), fallback: false };
  }
  const name = stripName(conf);
  const dirs = [MODELS_DIR, path.join(resourcesDir, 'bin', 'whisper', 'models')];
  const entry = WHISPER_MODELS[name];
  if (entry) {
    for (const dir of dirs) {
      const p = path.join(dir, entry.file);
      if (existsSync(p)) return { path: p, name, fallback: false };
    }
  }
  for (const fb of FALLBACK_ORDER) {
    for (const dir of dirs) {
      const p = path.join(dir, WHISPER_MODELS[fb].file);
      if (existsSync(p)) return { path: p, name: fb, fallback: fb !== name };
    }
  }
  return null;
}

let downloading = null; // model name while a download is in flight
let lastPct = -1;
export const downloadProgress = () => ({ downloading, pct: lastPct });

// Download a model into MODELS_DIR. onProgress(pct) fires on whole-percent
// steps. Concurrent calls for the same model coalesce into one download.
export async function downloadModel(name, onProgress) {
  const entry = WHISPER_MODELS[stripName(name)];
  if (!entry) throw new Error(`Unknown whisper model "${name}"`);
  const dest = path.join(MODELS_DIR, entry.file);
  if (existsSync(dest)) return dest;
  if (downloading) throw new Error(`Already downloading ${downloading}`);
  const tmp = `${dest}.part`;
  mkdirSync(MODELS_DIR, { recursive: true });
  // A .part that is actively GROWING belongs to another live downloader —
  // don't fight over it. A .part that isn't growing is a corpse from an
  // interrupted run (app killed mid-download): take over immediately.
  if (existsSync(tmp)) {
    const size = () => { try { return statSync(tmp).size; } catch { return -1; } };
    const before = size();
    await new Promise((r) => setTimeout(r, 8000));
    if (size() !== before) throw new Error('another download of this model is already running');
    try { unlinkSync(tmp); } catch { /* gone already */ }
  }
  downloading = stripName(name);
  lastPct = 0;
  try {
    const res = await fetch(HF_BASE + entry.file, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length')) || entry.mb * 1024 * 1024;
    const out = createWriteStream(tmp);
    let got = 0;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress?.(pct); }
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    renameSync(tmp, dest);
    return dest;
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing partial to clean */ }
    throw err;
  } finally {
    downloading = null;
  }
}
