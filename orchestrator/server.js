// JARVIS orchestrator — local WebSocket hub connecting the dashboard UI to
// LLM providers, local STT/TTS, and skills. Runs headless; test with wscat.
import { WebSocketServer } from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadProviders } from './providers/index.js';
import { transcribe } from './voice/stt.js';
import { resolveModelPath, downloadModel, downloadProgress } from './voice/models.js';
import { bootstrapKokoro, kokoroModelsMissing } from './voice/voice-setup.js';
import { synthesize, looksFrench, looksLikeCode, createSpeechGate } from './voice/tts.js';
import { Skills } from './skills.js';
import { runAction, parseActions, stripActions, TOOL_ALIASES } from './computer.js';
import { parseRoutineDays } from './tools.js';
import { initKeyStore, keyStore } from './keys.js';
import { redact, loadPatterns } from './redact.js';
import { typeText } from './dictate.js';
import { classify, loadRules } from './intent.js';
import { MemoryStore } from './memory.js';
import { createProfile } from './profile.js';
import { listConversations, getConversation, searchMemories, getMemoryStats } from './memory-viewer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// In the packaged app, extraResources (bin/) land outside the asar.
// The Electron main process passes MOMZU_RESOURCES pointing there.
const RESOURCES = process.env.MOMZU_RESOURCES || ROOT;
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

// Persistent state (memory DB, API keys, settings, lists) lives OUTSIDE the
// app bundle so rebuilds/updates never wipe it. The Electron main process
// passes MOMZU_STATE (→ ~/Library/Application Support/Momzu/
// state) in the packaged app; dev keeps using the repo's config/state.
const BUNDLED_STATE = path.join(ROOT, 'config', 'state');
const STATE_DIR = process.env.MOMZU_STATE || BUNDLED_STATE;
if (STATE_DIR !== BUNDLED_STATE) {
  mkdirSync(STATE_DIR, { recursive: true });
  // One-time migration: adopt any state shipped inside the bundle.
  for (const f of ['keys.json', 'memory.db', 'memory.db-wal', 'memory.db-shm', 'objectives.json', 'reminders.json']) {
    const src = path.join(BUNDLED_STATE, f);
    const dst = path.join(STATE_DIR, f);
    try { if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst); } catch { /* best-effort */ }
  }
  console.log(`[jarvis] state dir: ${STATE_DIR}`);
}

// Settings: the bundle ships the defaults; runtime user choices are saved to
// STATE_DIR as a SMALL overrides object (only keys the user can change in
// the app), so bundled config improvements still land after updates.
const USER_CONFIG = path.join(STATE_DIR, 'jarvis.config.json');
const OVERRIDE_KEYS = ['defaultProvider', 'tts', 'models', 'systemPrompt'];
const config = JSON.parse(readFileSync(path.join(ROOT, 'config/jarvis.config.json'), 'utf8'));
let overrides = {};
try {
  const saved = JSON.parse(readFileSync(USER_CONFIG, 'utf8'));
  for (const k of OVERRIDE_KEYS) if (saved[k] !== undefined) overrides[k] = saved[k];
} catch { /* no user overrides yet */ }
if (overrides.defaultProvider) config.defaultProvider = overrides.defaultProvider;
if (overrides.tts) Object.assign(config.voice.tts, overrides.tts);
if (overrides.systemPrompt) config.systemPrompt = overrides.systemPrompt;
// A catalog entry maps a selection id to the underlying model + optional
// effort level (e.g. "sonnet-xhigh" → model "sonnet", effort "xhigh").
function applyModelChoice(providerId, choiceId) {
  const p = config.providers?.[providerId];
  const entry = p?.models?.find((m) => m.id === choiceId);
  if (!p || !entry) return false; // stale/unknown choice — keep bundle default
  p.choice = entry.id;
  p.model = entry.model || entry.id;
  if (entry.effort) p.effort = entry.effort;
  else delete p.effort;
  return true;
}

// Per-provider model picks (e.g. deepseek-v4-pro instead of v4-flash).
if (overrides.models) {
  for (const [id, choice] of Object.entries(overrides.models)) {
    if (typeof choice === 'string') applyModelChoice(id, choice);
  }
}
const redactPatterns = loadPatterns(config.redaction);
initKeyStore(STATE_DIR);
// Providers (the claude-agent's tools) find state files via this env var.
process.env.MOMZU_STATE_DIR = STATE_DIR;
let providers = loadProviders(config);

// The choices each provider offers in the model dropdown, plus the pick.
function providerModelInfo() {
  const out = {};
  for (const [id, p] of Object.entries(config.providers || {})) {
    out[id] = { current: p.choice || p.model || null, options: p.models || [] };
  }
  return out;
}
const skills = new Skills(STATE_DIR);

// Memory store — gracefully degrades if better-sqlite3 is unavailable.
let memory = null;
try {
  if (config.memory?.enabled !== false) {
    memory = new MemoryStore(path.join(STATE_DIR, 'memory.db'));
    // Retention: drop turns older than the configured window (default 90d).
    const pruned = memory.prune(config.memory?.retentionDays ?? 90);
    if (pruned) console.log(`[jarvis] memory: pruned ${pruned} turn(s) past retention`);
    // One-time cleanup: old heuristic 'fact' rows were regex junk (replaced
    // by profile.json) and polluted FTS recall — drop them.
    memory.db.prepare(`DELETE FROM memories WHERE type = 'fact'`).run();
  }
} catch (err) {
  console.log('[jarvis] memory disabled — better-sqlite3 may not be installed:', err.message.slice(0, 80));
}

// Durable facts about the user, extracted by Haiku in the background and
// injected into every provider's system prompt.
const profile = createProfile(STATE_DIR);
if (profile.count()) console.log(`[jarvis] profile: ${profile.count()} known fact(s)`);

// Momzu controls the Mac through the orchestrator's guarded ACTION
// protocol: the model emits ACTION directives, the orchestrator runs them via
// runAction() (which blocks catastrophic commands) and feeds results back.
const ACTION_FOR_CLI = `
You are the user's desktop assistant on their Mac. Use bash for all computer tasks. Always DO the task, don't just talk about it. Keep responses short.`;

// Appended to the Agent SDK's claude_code PRESET prompt (never replaces it —
// the preset carries the agentic operating instructions that make it capable).
const AGENT_PROMPT = config.systemPrompt + `
You are running as the user's voice assistant on their Mac with full tool access.
Chrome/web tasks (browse, click, fill forms, read pages, search inside sites)
→ use the Claude-in-Chrome browser extension tools (mcp__claude-in-chrome__*:
tabs_context, navigate, computer, read_page, find, form_input, get_page_text)
— they drive the user's real Chrome with their logins, exactly like Claude Code
does. Start with tabs_context, create a tab when needed, then act. If those
extension tools are unavailable or erroring, fall back to the jarvis chrome
tool. Opening apps → open_app. Music/Spotify → the music tool: a SPECIFIC
song/artist by name → action play_song with query (takes a few seconds — do
NOT improvise AppleScript for this); play/pause/skip/what's playing/volume →
the matching action. Other app control → applescript.
"What's on my calendar / am I free" → calendar_events (Google Calendar; if
none is connected it returns the instructions to read out — and when the user
pastes a calendar link, save it with calendar_connect). Weather → weather.
"Remind me…" → add_reminder (it fires a spoken alert at the right time).
"Every morning/day at…" → add_routine (a scheduled prompt Momzu runs and
speaks at that time); list_routines / remove_routine manage them.
Goals/tasks → add_objective; marking things done → complete_item; reading
the lists → list_items. "What's on my screen?" → see_screen, then Read the
screenshot file it returns and describe what you see.
Every word of your text output is spoken aloud through TTS:
- Never narrate what you're about to do; never recap steps. BAD (annoying,
  spoken aloud): "I found fa at the top — I'll open that conversation to
  confirm before sending." / "This matches, I'll type the message now."
  GOOD: work in silence, then just "Sent it to Fah on Instagram."
- Work silently with tools, then state the outcome in one or two short sentences.
- Never open with filler acknowledgments like "Sure." or "On it." — a chime
  already told the user they were heard; go straight to work.
- NEVER speak code, file contents, HTML, commands, or paths. When building a
  website, app, or script: create the files with tools without showing them,
  then say only what you built and where, e.g. "Done — the site is on your
  Desktop, want me to open it?". Reading code aloud is a failure.
- If something fails or you need information, say so briefly and plainly.
- Plain prose only — no markdown, lists, headings, or code blocks in replies.
- Reply in English (or the user's language if the voice can speak it). NEVER in
  Arabic script: the voice engine cannot speak it — an Arabic-script transcript
  may be phonetically-garbled English; interpret it generously, reply in English.`;

const ACTION_FOR_API = `
You control the user's Mac. To perform ANY computer action, you MUST output exactly this on its own line:
ACTION {"tool":"<tool>","input":"<value>"}

Available tools and EXACT examples:
- ACTION {"tool":"open","input":"Spotify"}
- ACTION {"tool":"shell","input":"mkdir ~/Desktop/MyFolder"}
- ACTION {"tool":"shell","input":"ls ~/Documents"}
- ACTION {"tool":"url","input":"instagram.com"}
- ACTION {"tool":"applescript","input":"set volume output volume 50"}
- ACTION {"tool":"write","path":"~/Desktop/site/index.html","content":"<full file content>"}

CRITICAL: Every computer task requires an ACTION line. If the user says "create a folder on my desktop", you MUST output:
ACTION {"tool":"shell","input":"mkdir ~/Desktop/NewFolder"}
Do NOT say "I'll create it" without the ACTION — nothing will happen. The ACTION is the ONLY way to do things. Answer questions normally without ACTION.

VOICE RULES — every word you write outside ACTION lines is SPOKEN ALOUD to the user through text-to-speech:
- NEVER write code, HTML, CSS, JavaScript, commands, file contents, or file paths in your prose. Hearing code read aloud is a failure.
- Code goes ONLY inside the ACTION JSON, nowhere else. Never wrap code in \`\`\` blocks; never "show" or "explain" the code you wrote.
- When asked to build a website, app, or script: emit one ACTION {"tool":"write",...} per file with the COMPLETE file content in "content" (JSON-escaped, \\n for newlines), then finish with ONE short spoken sentence like "Done — your site is on the Desktop, want me to open it?"
- Never open with filler acknowledgments like "Sure." or "On it." — a chime already told the user they were heard; go straight to work.
- No markdown, no lists, no headings — plain short conversational sentences only.
- Reply in English (or the user's language if the voice can speak it). NEVER in
  Arabic script: the voice engine cannot speak it — an Arabic-script transcript
  may be phonetically-garbled English; interpret it generously, reply in English.`;

// DeepSeek/Gemini call REAL tools natively — no ACTION protocol needed.
const ACTION_FOR_TOOLS = `
You control the user's Mac through your TOOLS (function calls). ALWAYS call a tool for any computer task — never claim something is done without calling its tool. Prefer: open_app for apps; music for playback and volume; calendar_events for the calendar; weather for weather; add_reminder / add_objective / add_routine for reminders, goals and schedules; chrome for anything inside a web page; shell for files and system; write_file to create files.
VOICE RULES — every word of your text is SPOKEN ALOUD to the user:
- Work with tools silently, then state the outcome in one or two short sentences.
- Never open with filler acknowledgments like "Sure." or "On it." — a chime already told the user they were heard; go straight to work.
- NEVER write code, HTML, commands, file contents, or file paths in your prose. File content goes ONLY inside write_file arguments.
- Plain short conversational sentences — no markdown, no lists, no headings.
- Reply in English (or the user's language if the voice can speak it). NEVER in
  Arabic script: the voice engine cannot speak it — an Arabic-script transcript
  may be phonetically-garbled English; interpret it generously, reply in English.`;

const ACTION_PROMPT = config.systemPrompt + ACTION_FOR_CLI;
const ACTION_PROMPT_API = config.systemPrompt + ACTION_FOR_API;
const ACTION_PROMPT_TOOLS = config.systemPrompt + ACTION_FOR_TOOLS;
const TOOL_NATIVE = new Set(['deepseek', 'gemini']); // providers with real function calling

// One conversation id per app run so turns group into real conversations
// in the memory viewer instead of one "conversation" per exchange.
const convId = `conv-${Date.now()}`;

let history = [];
// Restore the tail of the last conversation so the assistant remembers what
// was discussed before the app was closed — shared across all providers.
if (memory) {
  try {
    const past = memory.recall('', { recentTurns: config.memory?.recentTurns || 10 });
    for (const r of past) {
      if (r.role === 'user' || r.role === 'assistant') history.push({ role: r.role, content: r.content });
    }
    if (history.length) console.log(`[jarvis] restored ${history.length} turns from previous session`);
  } catch { /* fresh start */ }
}
let speak = config.voice?.autoSpeak ?? true;
let generating = false;
let aborted = false;
let activeProvider = null; // provider currently generating, for interrupt()
let lastTtsTime = 0;     // when a TTS wav was last synthesized (fallback signal)
let speechPlaying = false; // renderer-reported: speakers are playing our voice NOW
let lastSpeechEnd = 0;   // renderer-reported: when playback actually finished
const intentRules = loadRules(config.intent);

// True while our own voice could be coming out of the speakers: actual
// playback (renderer-reported) plus a grace window after it ends — keeps
// the intent path from reacting to our own voice on the speakers.
function ttsEchoActive() {
  const grace = 800;
  return speechPlaying
    || Date.now() - lastSpeechEnd < grace
    || Date.now() - lastTtsTime < Math.min(grace, 500);
}

// ── HTTP + WebSocket server ─────────────────────────────────────────────
// The dashboard is plain HTML/JS — served over the LAN it runs on a phone
// too (same WebSocket, same features; mic needs a secure context so phones
// type instead of talk unless proxied via HTTPS). Non-loopback requests
// must present the access token (?t=… once; a cookie remembers it).
const remoteEnabled = config.remote?.enabled !== false;
const REMOTE_FILE = path.join(STATE_DIR, 'remote.json');
let remoteToken = '';
try { remoteToken = JSON.parse(readFileSync(REMOTE_FILE, 'utf8')).token || ''; } catch { /* first run */ }
if (!remoteToken) {
  remoteToken = randomBytes(9).toString('base64url');
  try { writeFileSync(REMOTE_FILE, JSON.stringify({ token: remoteToken }, null, 2)); } catch { /* stays session-only */ }
}

const RENDERER_DIR = path.join(ROOT, 'dashboard', 'renderer');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript' },
  '/face.js': { file: 'face.js', type: 'text/javascript' },
  '/sphere.js': { file: 'sphere.js', type: 'text/javascript' },
  '/theme.css': { file: 'theme.css', type: 'text/css' },
  '/node_modules/three/build/three.module.js': {
    abs: path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'),
    type: 'text/javascript',
  },
  '/node_modules/qrcode-generator/dist/qrcode.mjs': {
    abs: path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.mjs'),
    type: 'text/javascript',
  },
};

function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function requestToken(req) {
  const u = new URL(req.url || '/', 'http://momzu');
  const q = u.searchParams.get('t');
  if (q) return q;
  const m = /(?:^|;\s*)momzu_t=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
const authorized = (req) => isLoopback(req) || (remoteEnabled && requestToken(req) === remoteToken);

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}
// Phones get the HTTPS port: getUserMedia (the mic) only exists in a secure
// context, so the plain-HTTP page could type but never talk. The cert is
// self-signed — the phone shows one warning, "Advanced → proceed", once.
const HTTPS_PORT = config.remote?.httpsPort || 8766;
const remoteUrl = () => {
  const ip = lanIp();
  return ip ? `https://${ip}:${HTTPS_PORT}/?t=${remoteToken}` : null;
};

const requestHandler = (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (!authorized(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Momzu: wrong or missing token. Open the exact phone link shown on the Mac.');
    return;
  }
  const u = new URL(req.url || '/', 'http://momzu');
  const entry = STATIC_FILES[u.pathname];
  if (!entry) { res.writeHead(404); res.end('not found'); return; }
  try {
    const data = readFileSync(entry.abs || path.join(RENDERER_DIR, entry.file));
    const headers = { 'content-type': entry.type, 'cache-control': 'no-cache' };
    // Remember the token so in-page navigation and the WS keep working.
    if (!isLoopback(req) && u.searchParams.get('t') === remoteToken) {
      headers['set-cookie'] = `momzu_t=${remoteToken}; Path=/; Max-Age=31536000; SameSite=Lax`;
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
};

const httpServer = http.createServer(requestHandler);
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[jarvis] orchestrator already running on this port — exiting quietly');
    process.exit(0);
  }
  console.error('[jarvis] server error:', err.message);
});

const wss = new WebSocketServer({ server: httpServer, verifyClient: (info) => authorized(info.req) });

// HTTPS twin for phones (same handler, same WS hub, same token rules).
if (remoteEnabled) {
  try {
    const certDir = path.join(STATE_DIR, 'certs');
    const keyFile = path.join(certDir, 'key.pem');
    const certFile = path.join(certDir, 'cert.pem');
    if (!existsSync(keyFile) || !existsSync(certFile)) {
      mkdirSync(certDir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', keyFile, '-out', certFile, '-days', '825', '-nodes',
        '-subj', '/CN=momzu.local'], { stdio: 'ignore' });
    }
    const httpsServer = https.createServer(
      { key: readFileSync(keyFile), cert: readFileSync(certFile) }, requestHandler);
    httpsServer.on('upgrade', (req, socket, head) => {
      if (!authorized(req)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    httpsServer.on('error', (err) => console.log('[jarvis] https error:', err.message.slice(0, 80)));
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[jarvis] phone https on :${HTTPS_PORT} (self-signed — accept the warning once)`);
    });
  } catch (err) {
    console.log('[jarvis] https unavailable (phone mic will be typing-only):', err.message.slice(0, 80));
  }
}

httpServer.listen(config.port || 8765, remoteEnabled ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`[jarvis] orchestrator listening on ws://127.0.0.1:${config.port || 8765}`);
  if (remoteEnabled) {
    const url = remoteUrl();
    if (url) console.log(`[jarvis] phone access (same Wi-Fi): ${url}`);
  }
});

// Last-resort safety net: a stray error anywhere (a provider child process,
// a sidecar pipe, a bad tool) must never take the whole brain down — the
// packaged app has no terminal to relaunch it from. Log it, tell the user,
// keep serving. (Electron's main process also respawns us if we do die.)
process.on('uncaughtException', (err) => {
  console.error('[jarvis] uncaught exception (kept alive):', err);
  try { ticker(`ERROR — ${String(err?.message || err).slice(0, 120)}`); } catch { /* boot-time */ }
});
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection (kept alive):', err);
  try { ticker(`ERROR — ${String(err?.message || err).slice(0, 120)}`); } catch { /* boot-time */ }
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function ticker(text) {
  broadcast({ type: 'ticker', text, at: Date.now() });
}

// ── Kokoro neural voice sidecar ─────────────────────────────────────────
// Runs when the Kokoro engine is selected; tts.js silently falls back to
// macOS `say` while the model loads or if it's missing.
//
// Reliability contract (the old code broke all three, which is why Kokoro
// used to die until the Mac was rebooted):
//  1. Stale sidecars from a previous app run are killed before we spawn,
//     so our fresh process can always bind port 8791.
//  2. If the sidecar exits or turns unhealthy, it is respawned automatically
//     (with backoff) — never "gone until restart".
//  3. On SIGTERM/SIGINT (app quit) the sidecar is killed with us, so no
//     orphan is left holding the port for the next launch.
const SIDECARS = {
  kokoro: { py: path.join(os.homedir(), '.momzu', 'kokoro-env', 'bin', 'python'), script: 'orchestrator/voice/kokoro_server.py', port: 8791 },
};
let voiceProc = null;
let voiceProcEngine = null;
let voiceRespawnDelay = 1000; // grows on crash-loop, resets on READY

// Kill anything already listening on the sidecar port — typically an
// orphaned sidecar from a previous run whose parent died without cleanup.
function killPortHolders(port) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null; true`]);
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

let ensuring = false;
async function ensureVoiceSidecar({ cleanPort = false } = {}) {
  if (ensuring) return;
  ensuring = true;
  try {
    const engine = config.voice?.tts?.engine;
    if (voiceProc && voiceProcEngine !== engine) {
      try { voiceProc.kill(); } catch { /* gone */ }
      voiceProc = null;
    }
    const sc = SIDECARS[engine];
    if (!sc || voiceProc) return;
    if (!existsSync(sc.py) || kokoroModelsMissing()) {
      // Public installs ship no Python voice env — build it in the
      // background (one-time); `say` keeps speaking until the sidecar is
      // READY. On Macs without Python 3 this stays on `say` and says so.
      console.log(`[jarvis] ${engine} voice not installed yet — starting background setup, using say meanwhile`);
      bootstrapKokoro({
        onStatus: (text, pct) => {
          console.log('[voice-setup]', text);
          if (pct === undefined || pct % 10 === 0) ticker(text);
        },
        onDone: () => ensureVoiceSidecar({ cleanPort: true }),
      });
      return;
    }
    if (cleanPort) await killPortHolders(sc.port);
    voiceProcEngine = engine;
    const proc = spawn(sc.py, [path.join(ROOT, sc.script)], { stdio: 'pipe' });
    voiceProc = proc;
    proc.stdout.on('data', (d) => {
      const line = String(d).trim();
      if (line) console.log(line);
      if (line.includes('READY')) {
        voiceRespawnDelay = 1000;
        ticker('Neural voice ready');
        broadcast({ type: 'voice-state', tts: config.voice.tts, neuralReady: true });
      }
    });
    proc.stderr.on('data', () => { /* model-load spew */ });
    const respawn = (code) => {
      if (voiceProc === proc) voiceProc = null;
      if (config.voice?.tts?.engine !== voiceProcEngine) return; // engine switched — no respawn
      const delay = voiceRespawnDelay;
      voiceRespawnDelay = Math.min(voiceRespawnDelay * 2, 60000);
      console.log(`[jarvis] ${voiceProcEngine} sidecar exited (${code ?? 'error'}) — respawning in ${delay / 1000}s`);
      // Exit 75 = "couldn't bind the port": a stale sidecar owns it, clear it.
      setTimeout(() => ensureVoiceSidecar({ cleanPort: true }), delay).unref();
    };
    proc.on('error', () => respawn('spawn-error'));
    proc.on('close', respawn);
  } finally {
    ensuring = false;
  }
}
// First spawn always clears the port: an orphan from a previous run may look
// healthy but fail every request (dead log pipe), so it can't be trusted.
ensureVoiceSidecar({ cleanPort: true });

function shutdown(signal) {
  try { voiceProc?.kill('SIGKILL'); } catch { /* gone */ }
  voiceProc = null;
  if (signal) process.exit(0);
}
process.on('exit', () => shutdown(null));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function neuralHealthy(engine) {
  const sc = SIDECARS[engine || config.voice?.tts?.engine];
  if (!sc) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${sc.port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch { return false; }
}

// Watchdog: every 45s, if the neural engine is selected, make sure the
// sidecar process exists and its /health answers; if not, clear the port
// and respawn. This is what makes Kokoro self-heal instead of needing a
// Mac restart.
setInterval(async () => {
  const engine = config.voice?.tts?.engine;
  const sc = SIDECARS[engine];
  if (!sc || !existsSync(sc.py)) return;
  if (voiceProc && await neuralHealthy(engine)) return;
  console.log(`[jarvis] ${engine} watchdog: sidecar ${voiceProc ? 'unhealthy' : 'not running'} — restarting it`);
  try { voiceProc?.kill('SIGKILL'); } catch { /* gone */ }
  voiceProc = null;
  await ensureVoiceSidecar({ cleanPort: true });
}, 45000).unref();

// ── whisper model: resolve on disk, download when missing ──────────────
// Models no longer ship in the app. resolveModelPath finds the configured
// model (or the best fallback already on disk); ensureSttModel fetches the
// preferred one in the background and swaps it in when ready.
let sttModel = resolveModelPath(config.voice?.stt, RESOURCES);
const preferredSttName = String(config.voice?.stt?.model || 'large-v3-turbo-q8_0')
  .replace(/^.*\//, '').replace(/^ggml-/, '').replace(/\.bin$/, '');

// The stt config handed to transcribe(): configured values + the resolved
// absolute model path. Null while nothing usable is on disk yet.
function sttConfigNow() {
  if (!sttModel) return null;
  return { ...config.voice.stt, model: sttModel.path };
}

function sttUnavailableMessage() {
  const { downloading, pct } = downloadProgress();
  return downloading
    ? `The voice model is still downloading (${pct}%) — type for now, or try again in a bit.`
    : 'No voice model on disk yet — check the internet connection and restart Momzu.';
}

async function ensureSttModel() {
  if (sttModel && !sttModel.fallback) return;
  if (sttModel?.fallback) {
    console.log(`[jarvis] using ${sttModel.name} for STT while ${preferredSttName} downloads`);
  }
  let announced = -10;
  try {
    ticker(`Downloading voice model ${preferredSttName}…`);
    const dest = await downloadModel(preferredSttName, (pct) => {
      if (pct - announced >= 10) {
        announced = pct;
        ticker(`Voice model download: ${pct}%`);
        broadcast({ type: 'stt-model', status: 'downloading', pct });
      }
    });
    sttModel = { path: dest, name: preferredSttName, fallback: false };
    ticker('Voice model ready');
    broadcast({ type: 'stt-model', status: 'ready', pct: 100 });
    console.log(`[jarvis] STT model ready: ${dest}`);
  } catch (err) {
    console.log(`[jarvis] voice model download failed: ${String(err.message).slice(0, 120)} — retrying in 10 min`);
    setTimeout(() => { sttModel = resolveModelPath(config.voice?.stt, RESOURCES); ensureSttModel(); }, 600_000).unref();
  }
}
ensureSttModel();

// macOS `say -v ?` voice list → [{ name, lang }]
function listSayVoices() {
  return new Promise((resolve) => {
    const child = spawn('say', ['-v', '?']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const voices = [];
      for (const line of out.split('\n')) {
        const m = /^(.+?)\s{2,}([a-z]{2})[_-]([A-Z]{2})\s+#/.exec(line);
        if (m) voices.push({ name: m[1].trim(), lang: m[2] });
      }
      resolve(voices);
    });
  });
}

let turnSeq = 0; // increments every turn — stale queued TTS is dropped
let pendingChat = null; // latest input that arrived while a turn refused to die

// Instant halt: "stop"-class utterances kill the current turn locally — no
// model round-trip (a runaway agent task otherwise keeps going for the whole
// interrupt-and-replace latency). Repeats collapse: "wait wait wait" → "wait".
const STOP_PHRASES = new Set([
  'stop', 'stop it', 'stop that', 'stop everything', 'stop now', 'wait',
  'hold on', 'cancel', 'cancel that', 'never mind', 'nevermind', 'forget it',
  'enough', "that's enough", 'shut up', 'quiet', 'be quiet',
  'arrête', 'arrete', 'khalas', 'khallas', 'خلص', 'خلاص',
]);
function isStopCommand(text) {
  const norm = String(text).toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!norm || norm.split(' ').length > 4) return false;
  const collapsed = norm.split(' ').filter((w, i, a) => w !== a[i - 1]).join(' ');
  return STOP_PHRASES.has(collapsed);
}

function haltEverything(text) {
  const hadWork = generating || !!pendingChat;
  pendingChat = null;
  if (generating) { aborted = true; activeProvider?.interrupt?.(); }
  turnSeq++; // queued TTS chunks die instantly (myTurn guards go stale)
  broadcast({ type: 'user', text });
  broadcast({ type: 'halt' });
  ticker(hadWork ? 'STOPPED — task cancelled' : 'Stop heard — nothing was running');
}

async function handleChat(text, providerId, opts = {}) {
  if (isStopCommand(text)) { haltEverything(text); return; }
  if (generating) {
    // Barge-in: new input interrupts the current answer instead of bouncing.
    aborted = true;
    activeProvider?.interrupt?.();
    const t0 = Date.now();
    while (generating && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    if (generating) {
      // The turn won't die (agent mid-tool-call). Never discard what the
      // user said — show it and queue it to run the moment the turn ends.
      pendingChat = { text, providerId };
      broadcast({ type: 'user', text: redact(text, redactPatterns).redacted });
      ticker('Busy — your request is queued and runs next');
      // A queued request is GOOD news — 'notice' renders as a calm status
      // line, not the red ERROR bubble that alarmed the user.
      broadcast({ type: 'notice', message: 'Still finishing the last task — I queued this and will do it next.' });
      return;
    }
  }
  const provider = providers.get(providerId || config.defaultProvider);
  if (!provider) { broadcast({ type: 'error', message: `Unknown provider: ${providerId}` }); return; }

  generating = true;
  // Faces must stay awake (thinking) for as long as this turn runs — 'busy'
  // is the server-side truth, immune to dropped-segment 'done' resets.
  broadcast({ type: 'busy', on: true });
  const myTurn = ++turnSeq;
  // Keep the in-RAM transcript bounded — old context lives in the memory DB.
  if (history.length > 60) history = history.slice(-40);
  const { redacted: safeText, count: redactedCount } = redact(text, redactPatterns);
  if (redactedCount) ticker(`Redacted ${redactedCount} sensitive value(s)`);
  broadcast({ type: 'user', text: safeText });
  broadcast({ type: 'thinking', provider: provider.id });
  history.push({ role: 'user', content: safeText });

  // Sentence-streamed TTS: speak each finished sentence while the rest is
  // still generating. The stateful speech gate (created below) already
  // removed ACTION directives, code fences, and code lines from the stream —
  // even when they span many chunks. looksLikeCode here is belt-and-braces.
  let ttsChain = Promise.resolve();
  const speakChunk = (chunk) => {
    if (!speak || !chunk.trim() || /ACTION\s*\{/.test(chunk) || looksLikeCode(chunk)) return;
    ttsChain = ttsChain.then(async () => {
      // Drop queued speech the moment the turn is interrupted or superseded.
      if (aborted || myTurn !== turnSeq) return;
      try {
        // Exactly what is about to be voiced — lets tests (and any client)
        // verify that no code is ever spoken.
        broadcast({ type: 'speaking', text: chunk });
        const wav = await synthesize(chunk, config.voice?.tts, ROOT);
        if (aborted || myTurn !== turnSeq) return;
        if (wav) { broadcast({ type: 'speech', data: wav.toString('base64') }); lastTtsTime = Date.now(); }
      } catch (err) {
        broadcast({ type: 'error', message: `TTS failed: ${err.message}` });
      }
    });
  };

  // Single pass: the model speaks a confirmation and may emit ACTION
  // directives; the orchestrator runs them and reports the result itself.
  try {
    aborted = false;
    let full = '';
    let pendingSpeech = '';
    // claude-agent/claude-cli have native tools; deepseek/gemini call the
    // shared toolkit natively; only ollama still needs the ACTION protocol.
    let memoryPrompt = provider.id === 'claude-agent' ? AGENT_PROMPT
      : provider.id === 'claude-cli' ? ACTION_PROMPT
      : TOOL_NATIVE.has(provider.id) ? ACTION_PROMPT_TOOLS
      : ACTION_PROMPT_API;
    // Tell the model which model it is — the user switches providers mid-
    // conversation and asks "which model are you now?".
    const pconf = config.providers?.[provider.id] || {};
    const modelDesc = pconf.model
      ? ` (${pconf.model}${pconf.effort ? `, ${pconf.effort} effort` : ''})`
      : '';
    memoryPrompt += `\nActive model: you are currently "${provider.label}"${modelDesc}. If asked which model or AI is speaking right now, answer exactly that — the active model can change between turns when the user switches it.`;
    memoryPrompt += `\nCurrent local date and time: ${new Date().toLocaleString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.`;
    // Durable user profile (agent sessions pick it up at session start).
    memoryPrompt += profile.note();
    // Inject recalled memories from PAST conversations only — recent turns are
    // already in history, re-injecting them just duplicates context.
    // The agent's system prompt is fixed for the life of its warm session,
    // so its recall rides along in the message.
    let turnMessages = history;
    if (memory && text) {
      const relevant = memory
        .recall(text, { limit: config.memory?.recallLimit || 5, recentTurns: 0 })
        .filter((r) => r.source === 'past');
      if (relevant.length > 0) {
        const note = `\n\n[Relevant memories from past conversations:\n${relevant.map((r) => `- ${r.content.slice(0, 300)}`).join('\n')}\n]`;
        if (provider.id === 'claude-agent') {
          turnMessages = [...history.slice(0, -1), { role: 'user', content: safeText + note }];
        } else {
          memoryPrompt += note;
        }
      }
    }

    // Acknowledge the request with a soft rising chime (users need to know
    // they were heard, or they repeat themselves louder). Replaces the old
    // spoken "Sure." fallback, which got tiresome on every turn. Routines
    // are self-initiated — nobody spoke, so nothing to acknowledge.
    activeProvider = provider;
    if (speak && !opts.silentAck) broadcast({ type: 'chime', kind: 'wake' });

    // Live tool activity from the agent → dashboard step display
    const onEvent = (ev) => {
      if (ev.kind === 'narration') {
        // Between-tool commentary: visible in the transcript, NEVER spoken.
        full += ev.text;
        broadcast({ type: 'token', text: ev.text });
      } else if (ev.kind === 'outcome-speech') {
        // The turn ended on a silent tool call; the summary composed right
        // before it is the outcome. Already in `full` via narration — speak
        // it without appending again. A task must never finish silent.
        speakChunk(ev.text);
      } else if (ev.kind === 'acting') {
        broadcast({ type: 'acting', tool: ev.tool, input: String(ev.input).slice(0, 80) });
        ticker(`▶ ${ev.tool}: ${String(ev.input).slice(0, 60)}`);
      } else if (ev.kind === 'result') {
        broadcast({ type: 'action-result', ok: ev.ok, tool: '', output: ev.output });
        if (!ev.ok) ticker(`✗ ${String(ev.output).slice(0, 60)}`);
      }
    };

    // The gate strips everything that must never reach the voice: ACTION
    // JSON (brace-matched across chunks), ``` fenced code, and code lines.
    const speechGate = createSpeechGate();
    for await (const token of provider.chat(turnMessages, { systemPrompt: memoryPrompt, onEvent })) {
      if (aborted) break;
      full += token;
      broadcast({ type: 'token', text: token });
      const speakable = speechGate.feed(token);
      pendingSpeech += speakable;
      let m;
      while ((m = pendingSpeech.match(/^[\s\S]*?[.!?\n](?=[\s"')\]]|$)/))) {
        if (!aborted) speakChunk(m[0]);
        pendingSpeech = pendingSpeech.slice(m[0].length);
      }
    }
    if (!aborted) {
      speakChunk(pendingSpeech + speechGate.flush());
    }
    if (aborted) {
      broadcast({ type: 'done', text: stripActions(full), provider: provider.id });
      ticker('Interrupted');
      return;
    }
    const { redacted: safeFull } = redact(full, redactPatterns);
    history.push({ role: 'assistant', content: safeFull });

    // Store turn in memory (best-effort, non-blocking)
    if (memory) {
      try {
        memory.remember({ id: `turn-${Date.now()}-u`, type: 'turn', role: 'user', content: safeText, conversation_id: convId });
        memory.remember({ id: `turn-${Date.now()}-a`, type: 'turn', role: 'assistant', content: safeFull, conversation_id: convId });
      } catch { /* memory ingest is best-effort */ }
    }
    // Queue the exchange for profile fact extraction (batched, async).
    profile.observe(safeText, safeFull);

    // The agent provider runs its own tools with a real feedback loop —
    // nothing to parse or execute here. Its tools may have edited the
    // objectives/reminders lists on disk, so refresh every client.
    if (provider.id === 'claude-agent') {
      broadcast({ type: 'done', text: full, provider: provider.id });
      broadcastLists();
      ticker(`${provider.label} done`);
      return;
    }

    // Tool-native providers already ran their tools inside chat() — their
    // tools may have touched the objectives/reminders/routines lists.
    if (TOOL_NATIVE.has(provider.id)) {
      broadcast({ type: 'done', text: full, provider: provider.id });
      broadcastLists();
      ticker(`${provider.label} done`);
      return;
    }

    // Remaining ACTION providers (Ollama, Claude API): run emitted ACTIONs,
    // then feed the results back so the model can self-correct.
    broadcast({ type: 'done', text: stripActions(full), provider: provider.id });
    let actions = parseActions(full);
    if (actions.length === 0) { ticker(`${provider.label} answered`); return; }

    const MAX_ROUNDS = 4;
    for (let round = 0; round < MAX_ROUNDS && actions.length > 0 && !aborted; round++) {
      const results = [];
      for (const action of actions) {
        broadcast({ type: 'acting', tool: action.tool, input: String(action.input).slice(0, 80) });
        ticker(`▶ ${action.tool}: ${String(action.input).slice(0, 60)}`);
        const res = await runAction(action, skills);
        broadcast({ type: 'action-result', ok: res.ok, tool: action.tool, output: res.output });
        results.push({ action, res });
      }

      const anyFailed = results.some((r) => !r.res.ok);
      const report = results.map(({ action, res }) =>
        `${action.tool}(${String(action.input).slice(0, 80)}) → ${res.ok ? 'OK' : 'FAILED'}: ${res.output.slice(0, 400)}`).join('\n');

      // Only loop back to the model when something failed or produced info
      // worth summarizing; plain successes are just read back.
      const informative = results.some(({ action, res }) => {
        const canonical = TOOL_ALIASES[action.tool] || action.tool;
        return res.ok && ['shell', 'applescript', 'browser'].includes(canonical)
          && res.output && res.output !== '(exit 0)' && res.output !== '(done)';
      });
      if (!anyFailed && !informative) { ticker(`${provider.label} done`); return; }

      history.push({ role: 'user', content: `[ACTION RESULTS]\n${report}\n\nIf a step FAILED, fix it with a corrected ACTION. If these results answer my question, summarize briefly. Do not repeat successful actions.` });
      let followUp = '';
      let pending = '';
      const followGate = createSpeechGate(); // follow-ups can emit corrected ACTIONs with code too
      for await (const token of provider.chat(history, { systemPrompt: memoryPrompt })) {
        if (aborted) break;
        followUp += token;
        broadcast({ type: 'token', text: token });
        pending += followGate.feed(token);
        let mm;
        while ((mm = pending.match(/^[\s\S]*?[.!?\n](?=[\s"')\]]|$)/))) {
          if (!aborted) speakChunk(mm[0]);
          pending = pending.slice(mm[0].length);
        }
      }
      if (!aborted) speakChunk(pending + followGate.flush());
      history.push({ role: 'assistant', content: redact(followUp, redactPatterns).redacted });
      broadcast({ type: 'done', text: stripActions(followUp), provider: provider.id });
      actions = parseActions(followUp);
    }
  } catch (err) {
    broadcast({ type: 'error', message: `${provider.label}: ${err.message}` });
    ticker(`ERROR — ${provider.label}: ${err.message.slice(0, 80)}`);
  } finally {
    generating = false; // queued TTS must not block the next question
    activeProvider = null;
    broadcast({ type: 'busy', on: false });
    if (pendingChat) {
      const p = pendingChat;
      pendingChat = null;
      // The user text was already broadcast when it was queued; the turn
      // itself re-broadcasts it, which doubles as "now working on it".
      setTimeout(() => handleChat(p.text, p.providerId), 100);
    }
  }
}

async function handleAudio(base64, providerId) {
  try {
    const stt = sttConfigNow();
    if (!stt) { broadcast({ type: 'error', message: sttUnavailableMessage() }); return; }
    broadcast({ type: 'transcribing' });
    const text = await transcribe(Buffer.from(base64, 'base64'), stt, RESOURCES);
    if (!text || /^\[.*\]$/.test(text)) {
      broadcast({ type: 'error', message: 'Heard nothing intelligible — try again.' });
      return;
    }
    broadcast({ type: 'transcript', text });
    ticker(`Heard: "${text.slice(0, 60)}"`);
    await handleChat(text, providerId);
  } catch (err) {
    broadcast({ type: 'error', message: `STT failed: ${err.message}` });
  }
}

async function handleSkill(msg) {
  try {
    if (msg.kind === 'open') {
      const result = await skills.openApp(msg.target);
      ticker(result);
    } else if (msg.kind === 'builtin' && msg.target === 'clear') {
      history = [];
      for (const p of providers.values()) p.reset?.();
      broadcast({ type: 'cleared' });
      ticker('Conversation cleared');
    } else if (msg.kind === 'builtin' && msg.target === 'toggle-speak') {
      speak = !speak;
      broadcast({ type: 'speak-state', value: speak });
      ticker(speak ? 'Voice output ON' : 'Voice output OFF');
    }
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'init',
    providers: [...providers.values()].map((p) => ({ id: p.id, label: p.label })),
    providerModels: providerModelInfo(),
    defaultProvider: config.defaultProvider,
    commandDeck: config.commandDeck || [],
    theme: config.theme || {},
    speak,
    busy: generating,
    objectives: skills.loadList('objectives'),
    reminders: skills.loadList('reminders'),
    status: skills.systemStatus(),
    keyStatus: keyStore().status(),
    memoryStats: memory ? getMemoryStats(memory) : null,
    remote: remoteEnabled ? { url: remoteUrl() } : null,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'set-provider':
        if (providers.has(msg.provider)) {
          config.defaultProvider = msg.provider;
          overrides.defaultProvider = msg.provider;
          writeFileSync(USER_CONFIG, JSON.stringify(overrides, null, 2));
          broadcast({ type: 'provider-changed', defaultProvider: msg.provider, label: providers.get(msg.provider).label });
          ticker(`Model switched to ${providers.get(msg.provider).label}`);
        }
        break;
      case 'ui-state':
        // Renderer UI state (e.g. mic recording) → mirrored to every client
        // so the mini widget face reacts while you talk.
        if (['listening', 'idle', 'thinking'].includes(msg.state)) {
          broadcast({ type: 'ui-state', state: msg.state });
        }
        break;
      case 'voices-list':
        ws.send(JSON.stringify({
          type: 'voices',
          say: await listSayVoices(),
          kokoro: {
            installed: existsSync(SIDECARS.kokoro.py),
            ready: await neuralHealthy('kokoro'),
            voices: [
              { id: 'af_heart', label: 'Heart — warm female (US)' },
              { id: 'af_bella', label: 'Bella — bright female (US)' },
              { id: 'af_nicole', label: 'Nicole — soft female (US)' },
              { id: 'am_michael', label: 'Michael — male (US)' },
              { id: 'am_fenrir', label: 'Fenrir — deep male (US)' },
              { id: 'bf_emma', label: 'Emma — female (UK)' },
              { id: 'bm_george', label: 'George — male (UK)' },
            ],
          },
          current: config.voice.tts,
        }));
        break;
      case 'voice-set': {
        // msg.tts: { engine, voice, voiceFr, kokoroVoice } — persisted.
        const allowed = {};
        for (const k of ['engine', 'voice', 'voiceFr', 'kokoroVoice']) {
          if (typeof msg.tts?.[k] === 'string') allowed[k] = msg.tts[k];
        }
        if (!['say', 'kokoro'].includes(allowed.engine)) delete allowed.engine;
        Object.assign(config.voice.tts, allowed);
        overrides.tts = { ...(overrides.tts || {}), ...allowed };
        writeFileSync(USER_CONFIG, JSON.stringify(overrides, null, 2));
        ensureVoiceSidecar();
        broadcast({ type: 'voice-state', tts: config.voice.tts, neuralReady: await neuralHealthy() });
        ticker(`Voice: ${config.voice.tts.engine === 'kokoro' ? `Kokoro (${config.voice.tts.kokoroVoice || 'af_heart'})`
          : config.voice.tts.voice || 'system default'}`);
        if (speak) {
          try {
            const wav = await synthesize(looksFrench(msg.sample || '') ? 'Voici ma nouvelle voix.' : 'Here is my new voice.', config.voice.tts, ROOT);
            if (wav) { broadcast({ type: 'speech', data: wav.toString('base64') }); lastTtsTime = Date.now(); }
          } catch { /* sample is best-effort */ }
        }
        break;
      }
      case 'model-set':
        // Pick a specific model/effort for a provider (e.g. sonnet-xhigh).
        if (typeof msg.model === 'string' && applyModelChoice(msg.provider, msg.model)) {
          overrides.models = { ...(overrides.models || {}), [msg.provider]: msg.model };
          writeFileSync(USER_CONFIG, JSON.stringify(overrides, null, 2));
          // Providers capture their model at creation — rebuild them. The
          // agent's warm session dies, but the seenLen recap restores context.
          for (const p of providers.values()) p.reset?.();
          providers = loadProviders(config);
          broadcast({ type: 'model-changed', provider: msg.provider, model: msg.model, providerModels: providerModelInfo() });
          const pc = config.providers[msg.provider];
          ticker(`${pc.label} → ${pc.model}${pc.effort ? ` (${pc.effort} effort)` : ''}`);
        }
        break;
      case 'chat': await handleChat(msg.text, msg.provider); break;
      case 'audio': await handleAudio(msg.data, msg.provider); break;
      case 'skill': await handleSkill(msg); break;
      case 'list.set':
        if (['objectives', 'reminders'].includes(msg.name)) {
          skills.saveList(msg.name, msg.items);
          broadcast({ type: 'list', name: msg.name, items: msg.items });
        }
        break;
      case 'keys.set':
        if (['deepseek', 'gemini', 'anthropic'].includes(msg.provider)) {
          keyStore().set(msg.provider, msg.keys || []);
          broadcast({ type: 'keys', status: keyStore().status() });
          ticker(`Saved ${keyStore().count(msg.provider)} ${msg.provider} key(s)`);
        }
        break;
      case 'interrupt':
        aborted = true;
        activeProvider?.interrupt?.();
        break;
      case 'memory-query':
        if (!memory) { broadcast({ type: 'error', message: 'Memory is disabled' }); break; }
        broadcast({ type: 'memory-result', query: msg.query, results: searchMemories(memory, msg.query) });
        break;
      case 'memory-conversations':
        if (!memory) break;
        broadcast({ type: 'memory-conversations', conversations: listConversations(memory, msg.limit || 20) });
        break;
      case 'memory-conversation':
        if (!memory) break;
        broadcast({ type: 'memory-conversation', ...getConversation(memory, msg.id) });
        break;
      case 'memory-stats':
        if (!memory) { broadcast({ type: 'memory-stats', stats: { totalMemories: 0, totalConversations: 0 } }); break; }
        broadcast({ type: 'memory-stats', stats: getMemoryStats(memory) });
        break;
      case 'memory-clear':
        if (memory) memory.clear();
        profile.clear();
        broadcast({ type: 'memory-cleared' });
        ticker('Memory cleared');
        break;
      case 'dictate-start':
        broadcast({ type: 'dictate-state', active: true });
        ticker('Dictation mode ON');
        break;
      case 'dictate-stop':
        broadcast({ type: 'dictate-state', active: false });
        ticker('Dictation mode OFF');
        break;
      case 'dictate-audio':
        try {
          const dstt = sttConfigNow();
          if (!dstt) { broadcast({ type: 'error', message: sttUnavailableMessage() }); return; }
          broadcast({ type: 'transcribing' });
          const dtext = await transcribe(Buffer.from(msg.data, 'base64'), dstt, RESOURCES);
          if (!dtext || /^\[.*\]$/.test(dtext)) {
            broadcast({ type: 'error', message: 'Heard nothing — try again.' });
            return;
          }
          broadcast({ type: 'dictate-transcript', text: dtext });
          ticker(`Dictated: "${dtext.slice(0, 60)}"`);
          const tres = await typeText(dtext);
          if (!tres.ok) broadcast({ type: 'error', message: tres.output });
        } catch (err) {
          broadcast({ type: 'error', message: `Dictation failed: ${err.message}` });
        }
        break;
      case 'speech-state':
        // The renderer that is actually playing our voice reports it here —
        // the only reliable echo-suppression signal.
        speechPlaying = !!msg.playing;
        if (!msg.playing) lastSpeechEnd = Date.now();
        break;
      case 'intent-classify': {
        if (ttsEchoActive()) break; // ignore our own voice

        const result = classify(msg.text, intentRules);
        broadcast({ type: 'intent-result', intent: result.intent, confidence: result.confidence, text: msg.text });

        if (result.intent === 'open_app' && result.params?.app) {
          broadcast({ type: 'acting', tool: 'open', input: result.params.app });
          const res = await runAction({ tool: 'open', input: result.params.app }, skills);
          broadcast({ type: 'action-result', ok: res.ok, tool: 'open', output: res.output });
          if (res.ok) ticker(`Opened ${result.params.app}`);
        } else if (result.intent === 'action') {
          // Route to chat for now — the LLM will parse the ACTION directive
          await handleChat(result.params?.command || msg.text, msg.provider);
        } else if (result.intent === 'system_query') {
          const status = skills.systemStatus();
          const answer = `It's ${new Date().toLocaleTimeString()}. CPU at ${status.cpuLoad}%, memory at ${status.memUsedPct}%. Uptime ${status.uptimeHours} hours.`;
          broadcast({ type: 'done', text: answer, provider: 'intent' });
          if (speak) {
            const wav = await synthesize(answer, config.voice?.tts, ROOT);
            if (wav) { broadcast({ type: 'speech', data: wav.toString('base64') }); lastTtsTime = Date.now(); }
          }
        } else if (result.intent === 'search') {
          await handleChat(`Search for: ${result.params?.query || msg.text}`, msg.provider);
        } else {
          // chat fallback
          await handleChat(msg.text, msg.provider);
        }
        break;
      }
    }
  });
});

setInterval(() => broadcast({ type: 'status', ...skills.systemStatus() }), 5000);

function broadcastLists() {
  for (const name of ['objectives', 'reminders']) {
    broadcast({ type: 'list', name, items: skills.loadList(name) });
  }
}

// ── proactive reminders ────────────────────────────────────────────────
// Reminder items may carry a `due` timestamp (set by voice via the agent's
// add_reminder tool, or by typing "text @18:30" / "text +20m" in the panel).
// When one comes due it is spoken, shown as a macOS notification, and
// marked notified so it fires exactly once.
function notifyMac(title, body) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const child = spawn('osascript', ['-e',
    `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`]);
  child.on('error', () => {});
}

setInterval(async () => {
  let reminders;
  try { reminders = skills.loadList('reminders'); } catch { return; }
  const now = Date.now();
  let changed = false;
  for (const r of reminders) {
    if (r.due && !r.done && !r.notified && r.due <= now) {
      r.notified = true;
      changed = true;
      const line = `Reminder: ${r.text}`;
      ticker(`⏰ ${line}`);
      broadcast({ type: 'reminder-due', text: r.text });
      notifyMac('Momzu', r.text);
      if (speak) {
        try {
          const wav = await synthesize(line, config.voice?.tts, ROOT);
          if (wav) { broadcast({ type: 'speech', data: wav.toString('base64') }); lastTtsTime = Date.now(); }
        } catch { /* notification + ticker still shown */ }
      }
    }
  }
  if (changed) {
    skills.saveList('reminders', reminders);
    broadcast({ type: 'list', name: 'reminders', items: reminders });
  }
}, 15000);

// ── routines: scheduled spoken prompts ─────────────────────────────────
// Each routine is { id, time: "HH:MM", days, prompt, enabled, lastRun }.
// When one comes due (with a 60-minute catch-up window, so a routine still
// fires if the app opened a bit late) its prompt runs through the normal
// chat pipeline and the answer is spoken. Managed by voice via the
// add_routine / list_routines / remove_routine tools.
const ROUTINES_FILE = path.join(STATE_DIR, 'routines.json');
if (!existsSync(ROUTINES_FILE)) {
  // First run: seed the morning briefing. Say "remove the morning-briefing
  // routine" to drop it, or "move my briefing to 9" to change it.
  skills.saveList('routines', [{
    id: 'morning-briefing',
    time: '08:30',
    days: 'daily',
    prompt: 'Good-morning briefing: greet me briefly, then give me today\'s date, the weather, my calendar for today (if one is connected), my open objectives and pending reminders. Short and conversational — this is spoken.',
    enabled: true,
    lastRun: '',
  }]);
  console.log('[jarvis] seeded default morning-briefing routine (08:30 daily)');
}

setInterval(async () => {
  let routines;
  try { routines = skills.loadList('routines'); } catch { return; }
  if (!Array.isArray(routines) || routines.length === 0) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  for (const r of routines) {
    if (r.enabled === false || !r.time || !r.prompt) continue;
    if (r.lastRun === today) continue;
    if (!parseRoutineDays(r.days).includes(now.getDay())) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.time).trim());
    if (!m) continue;
    const sched = new Date(now);
    sched.setHours(+m[1], +m[2], 0, 0);
    const late = now.getTime() - sched.getTime();
    if (late < 0 || late > 60 * 60_000) continue; // not due / too old to bother
    if (generating) continue; // busy — retry on the next tick
    r.lastRun = today;
    skills.saveList('routines', routines);
    ticker(`⏱ Routine: ${r.id}`);
    try { await handleChat(r.prompt, config.defaultProvider, { silentAck: true }); }
    catch (err) { console.log(`[jarvis] routine ${r.id} failed:`, String(err.message).slice(0, 100)); }
    break; // one routine per tick — the next fires 30s later
  }
}, 30000);
