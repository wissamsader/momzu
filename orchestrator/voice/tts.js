// Local text-to-speech. Default engine is macOS `say` (built in, offline).
// Drop a piper binary + voice model into bin/piper/ and set
// voice.tts.engine = "piper" in the config to upgrade voice quality.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Strip markdown/code so spoken output sounds natural. Also prevents macOS
// `say` from interpreting bullet dashes or other chars as command flags.
export function speakableText(text) {
  return text
    // Arabic script is unspeakable by every installed voice (kokoro + say) —
    // it made TTS choke when the model or transcriber produced it. The
    // prompts forbid Arabic replies; this guarantees none is ever voiced.
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g, ' ')
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/^-\s+/gm, '')           // strip leading bullet dashes (say interprets as flag)
    .replace(/[*_#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Heuristic: does this text look like code/markup rather than prose?
// Belt-and-braces on top of the prompts and the streaming gate below.
export function looksLikeCode(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/```/.test(t)) return true;
  if (/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?>/.test(t)) return true; // HTML/JSX tags
  if (/^\s*(const|let|var|function|import|export|return|async|await|def|class|#include|<!DOCTYPE|@media|@import|if\s*\(|for\s*\(|while\s*\()\b/mi.test(t)) return true;
  if (/[{};]\s*$/.test(t)) return true;
  if (/[=!<>]==?|=>|&&|\|\||\+=|::|->/.test(t)) return true;                    // operators
  if (/^\s*[.#]?[\w-]+\s*\{/m.test(t)) return true;                            // CSS selector {
  if (/[\w-]+\s*:\s*[^;\n]{1,60};/.test(t)) return true;                       // CSS property;
  if (/\$\(|\bdocument\.|\bwindow\.|\bconsole\.|\bfunction\s*\(/.test(t)) return true;
  if (/^\s*(\$|>|#!)\s?\S/m.test(t) && /\b(cd|ls|mkdir|npm|git|curl|python|node|cat|echo|touch|open)\b/.test(t)) return true;
  // Symbol density: prose rarely exceeds ~5% of these characters.
  const symbols = (t.match(/[{}<>;=`~^|\\]/g) || []).length;
  if (t.length > 20 && symbols / t.length > 0.05) return true;
  return false;
}

// Streaming speech gate — feeds on raw model tokens and returns only the
// text that is safe to SPEAK. Stateful across chunks, which per-chunk
// regexes can never be: an ACTION directive or code fence that spans many
// sentence-chunks stays suppressed from start to finish.
// Suppresses: ``` fenced blocks, ACTION {...} JSON (brace-matched, string-
// aware, multi-line), and any full line that looks like code.
export function createSpeechGate() {
  let mode = 'text';        // 'text' | 'fence' | 'action'
  let depth = 0;            // brace depth while in 'action'
  let inStr = false;        // inside a JSON string while in 'action'
  let esc = false;          // escape char inside that string
  let buf = '';             // unconsumed stream tail (waiting for more input)
  let line = '';            // speakable text of the current line so far

  const gate = {
    feed(token) {
      buf += String(token ?? '');
      let out = '';
      while (buf.length > 0) {
        if (mode === 'fence') {
          const end = buf.indexOf('```');
          if (end === -1) { buf = buf.length > 2 ? buf.slice(-2) : buf; return out; }
          buf = buf.slice(end + 3);
          mode = 'text';
          continue;
        }
        if (mode === 'action') {
          let i = 0;
          for (; i < buf.length; i++) {
            const c = buf[i];
            if (inStr) {
              if (esc) esc = false;
              else if (c === '\\') esc = true;
              else if (c === '"') inStr = false;
            } else if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) { i++; mode = 'text'; break; }
          }
          buf = buf.slice(i);
          if (mode === 'action') return out;
          continue;
        }
        // text mode — find the earliest suppressor in the visible buffer
        const fence = buf.indexOf('```');
        const action = buf.search(/ACTION\s*\{/);
        let cut = buf.length;
        let next = null;
        if (fence !== -1 && fence < cut) { cut = fence; next = 'fence'; }
        if (action !== -1 && action < cut) { cut = action; next = 'action'; }
        // Hold back a small tail that could be the start of "```" or "ACTION {"
        let safe = cut;
        if (next === null) {
          const tail = /(`{1,2}|A(C(T(I(O(N(\s*\{?)?)?)?)?)?)?)$/.exec(buf);
          if (tail) safe = Math.min(safe, buf.length - tail[0].length);
        }
        out += this._text(buf.slice(0, safe));
        if (next === 'fence') { buf = buf.slice(cut + 3); mode = 'fence'; }
        else if (next === 'action') {
          buf = buf.slice(cut);
          buf = buf.slice(buf.indexOf('{'));
          mode = 'action'; depth = 0; inStr = false; esc = false;
          // Consume the opening brace through the action scanner next loop.
        } else {
          buf = buf.slice(safe);
          return out;
        }
      }
      return out;
    },

    // Line-level code suppression: emit text, but when a completed line
    // looks like code, retract it (it was never emitted — we buffer by line).
    _text(chunk) {
      let out = '';
      let rest = chunk;
      let nl;
      while ((nl = rest.indexOf('\n')) !== -1) {
        const full = line + rest.slice(0, nl);
        out += looksLikeCode(full) ? ' ' : `${full}\n`;
        line = '';
        rest = rest.slice(nl + 1);
      }
      line += rest;
      // Emit mid-line only once the line so far is clearly prose; if it
      // starts looking like code, hold everything until the newline verdict.
      // The punctuation must follow a word char — "<!" of "<!DOCTYPE" is
      // NOT a sentence end.
      if (line && !looksLikeCode(line)) {
        const m = /^[\s\S]*[\w"')\]][.!?](?=[\s"')\]]|$)/.exec(line);
        if (m) { out += m[0]; line = line.slice(m[0].length); }
      }
      return out;
    },

    flush() {
      let out = '';
      if (mode === 'text' && buf) { out += this._text(buf); buf = ''; }
      if (line) { out += looksLikeCode(line) ? '' : line; line = ''; }
      buf = '';
      return out;
    },
  };
  return gate;
}

// Cheap French detection — accented chars plus common French function words.
export function looksFrench(text) {
  const sample = ` ${text.toLowerCase().slice(0, 300)} `;
  let score = 0;
  if (/[àâçéèêëîïôùûœ]/.test(sample)) score += 2;
  for (const w of [' je ', ' tu ', ' vous ', ' est ', ' les ', ' des ', ' une ', ' c’est ', " c'est ", ' voilà ', ' oui ', ' bonjour ', ' merci ', ' pas ', ' sur ', ' dans ', ' avec ']) {
    if (sample.includes(w)) score++;
  }
  return score >= 2;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// Kokoro neural TTS via the local sidecar (kokoro_server.py, port 8791).
// Returns null on ANY problem so the caller falls back to `say` seamlessly.
async function synthesizeKokoro(clean, { voice, lang, speed }) {
  try {
    const res = await fetch('http://127.0.0.1:8791/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean, voice, lang, speed }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 44 ? buf : null;
  } catch {
    return null;
  }
}

export async function synthesize(text, ttsConfig = {}, rootDir = '') {
  let clean = speakableText(text);
  if (!clean) return null;
  // Prevent `say` from interpreting leading dashes as flags
  if (clean.startsWith('-')) clean = clean.replace(/^-+/, '').trim();
  if (!clean) return null;

  // Kokoro neural voice — faster than realtime on Apple Silicon, native
  // English AND French voices. Falls back to `say` if the sidecar is down.
  if (ttsConfig.engine === 'kokoro') {
    const fr = looksFrench(clean);
    const wav = await synthesizeKokoro(clean, {
      voice: fr ? (ttsConfig.kokoroVoiceFr || 'ff_siwis') : (ttsConfig.kokoroVoice || 'af_heart'),
      lang: fr ? 'fr-fr' : 'en-us',
      speed: ttsConfig.kokoroSpeed || 1.0,
    });
    if (wav) return wav;
    // fall through to `say` below
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'jarvis-tts-'));
  const outFile = path.join(dir, 'out.wav');
  try {
    if (ttsConfig.engine === 'piper') {
      const piperBin = path.join(rootDir, 'bin/piper/piper');
      const model = path.join(rootDir, 'bin/piper', ttsConfig.voice || 'voice.onnx');
      if (!existsSync(piperBin)) throw new Error('piper binary not found in bin/piper/');
      await run('sh', ['-c',
        `printf %s ${JSON.stringify(clean)} | ${JSON.stringify(piperBin)} --model ${JSON.stringify(model)} --output_file ${JSON.stringify(outFile)}`]);
    } else {
      const args = ['-o', outFile, '--data-format=LEI16@22050'];
      // Per-language voice: French replies get a French voice so `say`
      // doesn't read them with English pronunciation.
      const voice = looksFrench(clean) ? (ttsConfig.voiceFr || 'Amélie') : ttsConfig.voice;
      if (voice) args.push('-v', voice);
      if (ttsConfig.rate) args.push('-r', String(ttsConfig.rate));
      args.push(clean);
      await run('say', args);
    }
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
