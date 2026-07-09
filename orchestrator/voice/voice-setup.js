// First-run neural-voice setup. The DMG ships no Python environment — this
// builds the Kokoro one on the user's Mac the same way whisper models are
// fetched on first launch: in the background, with ticker progress, while
// tts.js keeps falling back to macOS `say` until the sidecar is READY (or
// forever, if this Mac has no usable Python 3).
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KOKORO_DIR = path.join(os.homedir(), '.momzu', 'kokoro');
const VENV_DIR = path.join(os.homedir(), '.momzu', 'kokoro-env');
const VENV_PY = path.join(VENV_DIR, 'bin', 'python');

// Preferred spec first (the version the app is tested against) — newer
// Pythons that predate its wheels fall back to the latest resolvable one.
const PIP_SPECS = [
  ['kokoro-onnx==0.5.0', 'soundfile'],
  ['kokoro-onnx>=0.4.7', 'soundfile'],
];
const MODEL_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/';
const MODEL_FILES = [
  { file: 'kokoro-v1.0.onnx', mb: 310 },
  { file: 'voices-v1.0.bin', mb: 27 },
];

export const kokoroModelsMissing = () =>
  MODEL_FILES.some((m) => !existsSync(path.join(KOKORO_DIR, m.file)));

const run = (cmd, args, { timeout = 120_000 } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });

// Find a Python 3.10+ without triggering macOS's "install developer tools?"
// dialog: /usr/bin/python3 is only trusted when the Command Line Tools are
// actually present. 3.10–3.13 are preferred over newer ones — the voice
// packages always have prebuilt wheels there.
async function findPython() {
  const candidates = [];
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    for (let min = 13; min >= 10; min--) candidates.push(path.join(dir, `python3.${min}`));
    candidates.push(path.join(dir, 'python3'));
  }
  const fw = '/Library/Frameworks/Python.framework/Versions';
  try {
    for (const v of readdirSync(fw).sort().reverse()) {
      candidates.push(path.join(fw, v, 'bin', 'python3'));
    }
  } catch { /* no python.org installs */ }
  if ((await run('/usr/bin/xcode-select', ['-p'])).code === 0) {
    candidates.push('/usr/bin/python3');
  }
  let fallback = null; // eligible but outside the sweet spot (e.g. 3.14+)
  for (const py of candidates) {
    if (!existsSync(py)) continue;
    const v = await run(py, ['-c', 'import sys; print("%d %d" % sys.version_info[:2])']);
    if (v.code !== 0) continue;
    const [maj, min] = v.stdout.trim().split(' ').map(Number);
    if (maj !== 3 || min < 10) continue;
    if (min <= 13) return py;
    fallback = fallback || py;
  }
  return fallback;
}

async function ensureVenv(py, onStatus) {
  const importOk = async () =>
    (await run(VENV_PY, ['-c', 'import kokoro_onnx, soundfile'], { timeout: 60_000 })).code === 0;
  if (existsSync(VENV_PY) && await importOk()) return;

  onStatus('Setting up the neural voice — one-time, a few minutes…');
  const build = async () => {
    if (!existsSync(VENV_PY)) {
      const venv = await run(py, ['-m', 'venv', VENV_DIR], { timeout: 180_000 });
      if (venv.code !== 0) throw new Error(`venv create failed: ${venv.stderr.slice(-200)}`);
    }
    let lastErr = '';
    for (const spec of PIP_SPECS) {
      const pip = await run(VENV_PY,
        ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...spec],
        { timeout: 20 * 60_000 });
      if (pip.code === 0) return;
      lastErr = pip.stderr.slice(-200);
    }
    throw new Error(`pip install failed: ${lastErr}`);
  };
  try {
    await build();
  } catch {
    // A half-written env from an interrupted first run — rebuild once, clean.
    rmSync(VENV_DIR, { recursive: true, force: true });
    await build();
  }
  if (!await importOk()) throw new Error('voice packages did not import after install');
}

// Same takeover semantics as the whisper downloader: a growing .part belongs
// to a live downloader, a stagnant one is a corpse we replace.
async function downloadFile(url, dest, mb, onPct) {
  if (existsSync(dest)) return;
  const tmp = `${dest}.part`;
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(tmp)) {
    const size = () => { try { return statSync(tmp).size; } catch { return -1; } };
    const before = size();
    await new Promise((r) => setTimeout(r, 8000));
    if (size() !== before) throw new Error('another download of this file is already running');
    try { unlinkSync(tmp); } catch { /* gone already */ }
  }
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length')) || mb * 1024 * 1024;
    const out = createWriteStream(tmp);
    let got = 0;
    let lastPct = -1;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) { lastPct = pct; onPct?.(pct); }
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing partial to clean */ }
    throw err;
  }
}

let running = null; // single-flight: repeat callers share one setup run

// Returns a promise resolving true when the voice is fully installed,
// false when it can't be (no Python) or the attempt failed — the app keeps
// using `say` either way. `onDone` fires only after a successful install.
export function bootstrapKokoro({ onStatus, onDone } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      if (existsSync(VENV_PY) && !kokoroModelsMissing()) return true;
      const py = await findPython();
      if (!py) {
        onStatus?.('Neural voice needs Python 3 — install it from python.org, then reopen Momzu. Using the basic voice for now.');
        return false;
      }
      await ensureVenv(py, (t) => onStatus?.(t));
      for (const [i, m] of MODEL_FILES.entries()) {
        if (existsSync(path.join(KOKORO_DIR, m.file))) continue;
        await downloadFile(MODEL_BASE + m.file, path.join(KOKORO_DIR, m.file), m.mb, (pct) =>
          onStatus?.(`Downloading the neural voice (${i + 1}/${MODEL_FILES.length}) — ${pct}%`, pct));
      }
      onStatus?.('Neural voice installed');
      onDone?.();
      return true;
    } catch (err) {
      console.error('[voice-setup] failed:', err);
      onStatus?.(`Neural voice setup failed — using the basic voice. (${String(err.message).slice(0, 100)})`);
      return false;
    } finally {
      running = null;
    }
  })();
  return running;
}
