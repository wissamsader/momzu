// Dictation mode — system-wide voice typing. Transcribed text is injected
// into the active macOS app via clipboard paste (Cmd+V), then the original
// clipboard is restored.

import { spawn } from 'node:child_process';

function exec(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: (out || err).trim() });
    });
  });
}

// Type text into the active app via clipboard paste (faster + safer than
// keystroke-by-keystroke for long text). Saves and restores the clipboard.
export async function typeText(text) {
  if (!text?.trim()) return { ok: false, output: 'Nothing to type' };

  // Save current clipboard
  const save = await exec('pbpaste', []);
  const saved = save.ok ? save.output : '';

  try {
    // Set clipboard to our text and paste
    const child = spawn('pbcopy', []);
    child.stdin.write(text);
    child.stdin.end();
    await new Promise((res, rej) => child.on('close', (c) => c === 0 ? res() : rej(new Error('pbcopy failed'))));

    // Cmd+V via System Events
    const paste = await exec('osascript', [
      '-e',
      'tell application "System Events" to keystroke "v" using command down',
    ]);

    return paste;
  } finally {
    // Restore original clipboard (async, best-effort)
    setTimeout(async () => {
      try {
        const restore = spawn('pbcopy', []);
        restore.stdin.write(saved);
        restore.stdin.end();
      } catch {}
    }, 200);
  }
}
