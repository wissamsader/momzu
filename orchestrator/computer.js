// Computer control — lets the assistant act on the Mac: open apps/URLs, run
// AppleScript (controls any app: menus, typing, windows, Music, System Events)
// and shell commands. Personal single-user tool; runs on your own machine.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browser } from './browser.js';

// Minimal safety net against catastrophic, irreversible commands. Not a
// sandbox — just blocks the obvious footguns before they run.
const BLOCKED = [
  /\brm\s+-rf?\s+(\/|~\/?\s|\/System|\/Users(\s|$))/i,
  /\bdiskutil\s+(erase|reformat)/i,
  /\bmkfs\b/i,
  /\bdd\b[^|]*of=\/dev\/(disk|rdisk)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bshutdown\b|\breboot\b/i,
];

function guard(cmd) {
  for (const re of BLOCKED) {
    if (re.test(cmd)) throw new Error('Blocked for safety — that command could damage the system. Run it manually in Terminal if you really intend it.');
  }
}

function exec(cmd, args, { input, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = (out + (err ? `\n${err}` : '')).trim();
      resolve({ ok: code === 0, output: text.slice(0, 4000) || `(exit ${code})` });
    });
  });
}

// Accept natural synonyms the model may use for tool names.
const TOOL_ALIASES = {
  bash: 'shell', sh: 'shell', zsh: 'shell', command: 'shell', cmd: 'shell', run: 'shell', exec: 'shell', terminal: 'shell',
  app: 'open', launch: 'open', openapp: 'open',
  website: 'url', web: 'url', link: 'url', openurl: 'url',
  google: 'search', websearch: 'search',
  osascript: 'applescript', apple: 'applescript', script: 'applescript',
  chrome: 'browser',
  write_file: 'write', create_file: 'write', savefile: 'write', file: 'write',
};

export async function runAction(action, skills) {
  const input = String(action.input ?? '').trim();
  const tool = TOOL_ALIASES[action.tool] || action.tool;
  switch (tool) {
    case 'open':
      try { return { ok: true, output: await skills.openApp(input) }; }
      catch (e) { return { ok: false, output: e.message }; }
    case 'url': {
      const url = /^https?:\/\//.test(input) ? input : `https://${input}`;
      return exec('open', [url]);
    }
    case 'search': {
      const url = `https://www.google.com/search?q=${encodeURIComponent(input)}`;
      return exec('open', [url]);
    }
    case 'browser':
      return browser(input);
    case 'applescript':
      return exec('osascript', ['-e', input]);
    case 'write': {
      // ACTION {"tool":"write","path":"~/Desktop/site/index.html","content":"..."}
      // The clean way for API models to create files (websites, scripts):
      // no shell quoting, and the code never appears outside the JSON.
      const obj = (action.input && typeof action.input === 'object') ? action.input : action;
      const rawPath = obj.path || obj.file || obj.filename || (typeof action.input === 'string' ? action.input : '');
      const content = obj.content ?? obj.text ?? obj.body;
      if (!rawPath || content == null) {
        return { ok: false, output: 'write needs {"tool":"write","path":"~/...","content":"..."}' };
      }
      try {
        const p = path.resolve(String(rawPath).replace(/^~(?=\/|$)/, os.homedir()));
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, String(content));
        return { ok: true, output: `Wrote ${String(content).length} chars to ${p}` };
      } catch (e) { return { ok: false, output: e.message }; }
    }
    case 'shell':
      try { guard(input); } catch (e) { return { ok: false, output: e.message }; }
      return exec('/bin/zsh', ['-lc', input]);
    default:
      return { ok: false, output: `Unknown tool: ${action.tool}` };
  }
}

export { TOOL_ALIASES };

// Find each ACTION directive and return its balanced JSON span. A simple
// [^}]* regex breaks the moment the payload contains a "}" — which ALL
// website/CSS/JS content does — so this walks the braces string-aware.
function actionSpans(text) {
  const spans = [];
  const re = /ACTION\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const jsonStart = m.index + m[0].length - 1;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = jsonStart; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end === -1) break; // unbalanced — ignore the rest
    spans.push({ start, end, json: text.slice(jsonStart, end) });
    re.lastIndex = end;
  }
  return spans;
}

// Pull ACTION directives out of a model response.
// Format: ACTION {"tool":"open","input":"Google Chrome"} — the JSON may
// contain nested braces or span lines (e.g. file contents in "input").
export function parseActions(text) {
  const actions = [];
  for (const span of actionSpans(text)) {
    try { actions.push(JSON.parse(span.json)); } catch { /* skip malformed */ }
  }
  return actions;
}

// Strip ACTION directives (balanced spans, however many lines they cover)
// so they are never shown or spoken.
export function stripActions(text) {
  let out = '';
  let pos = 0;
  for (const span of actionSpans(text)) {
    out += text.slice(pos, span.start);
    pos = span.end;
  }
  out += text.slice(pos);
  return out.replace(/^[ \t]*ACTION\s*\{[^\n]*$/gm, '') // unbalanced leftovers
    .replace(/\n{3,}/g, '\n\n').trim();
}
