// J.A.R.V.I.S. dashboard renderer — talks to the orchestrator over WebSocket.
import { createFace, mouthFromAudio, silentMouth } from './face.js';

const $ = (id) => document.getElementById(id);
const face = createFace($('face'));

let ws = null;
let providers = [];
let providerModels = {}; // per-provider model options + current pick
let commandDeck = [];
let objectives = [];
let reminders = [];
let currentMsg = null;
let recording = false;
let mediaRecorder = null;
let audioChunks = [];
let audioCtx = null;
let speakOn = true;
let dictating = false;
let busyTurn = false;   // server is mid-turn — face must stay awake/thinking

/* ── clock ─────────────────────────────── */
setInterval(() => {
  const now = new Date();
  $('clock-time').textContent =
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  $('clock-sec').textContent = `:${String(now.getSeconds()).padStart(2, '0')}`;
}, 250);

/* ── state label + face ────────────────── */
// The face sleeps (eyes closed) after a short idle spell and wakes the
// moment anything happens — listening, thinking, speaking, or interaction.
const SLEEP_AFTER_MS = 8000;
let sleepTimer = null;
const isAsleep = () => document.body.classList.contains('asleep');

function setState(state, label) {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  document.body.classList.remove('asleep');
  face.setState(state);
  const el = $('state-label');
  el.textContent = label;
  el.classList.toggle('active', state !== 'idle');
  if (state === 'idle') {
    sleepTimer = setTimeout(() => {
      face.setState('sleeping');
      document.body.classList.add('asleep');
      el.textContent = 'SLEEPING';
    }, SLEEP_AFTER_MS);
  }
}
setState('idle', 'STANDBY');

// Main window hidden/minimized → freeze CSS animations (theme.css keys off
// win-hidden). backgroundThrottling is off, so without this everything keeps
// compositing at full rate while nobody can see it.
window.jarvis?.onWinVisibility?.((visible) =>
  document.documentElement.classList.toggle('win-hidden', !visible));

/* ── websocket ─────────────────────────── */
// In the Electron app (file://) the orchestrator is local; served over the
// LAN (phone access) we connect back to wherever the page came from, with
// the token riding along.
function wsUrl() {
  if (location.protocol.startsWith('http')) {
    const token = new URLSearchParams(location.search).get('t')
      || (document.cookie.match(/(?:^|;\s*)momzu_t=([^;]+)/)?.[1] ?? '');
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?t=${token}`;
  }
  return 'ws://127.0.0.1:8765';
}

function connect() {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => $('conn-dot').classList.add('on');
  ws.onclose = () => {
    $('conn-dot').classList.remove('on');
    setState('idle', 'OFFLINE — RECONNECTING');
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handlers[msg.type]?.(msg);
  };
}

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  else addMsg('error', 'Orchestrator offline — is `npm run orchestrator` running?');
}

// Fire-and-forget send for cosmetic messages — no error spam when offline.
function sendQuiet(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

/* ── chat log ──────────────────────────── */
function addMsg(cls, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text;
  $('chat-log').appendChild(div);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return div;
}

/* ── server message handlers ───────────── */
const handlers = {
  init(msg) {
    providers = msg.providers;
    commandDeck = msg.commandDeck;
    objectives = msg.objectives;
    reminders = msg.reminders;
    speakOn = msg.speak;
    busyTurn = !!msg.busy;
    if (busyTurn) setState('thinking', 'PROCESSING'); // reconnected mid-turn
    keyStatus = msg.keyStatus || {};
    refreshKeyBtn();
    const sel = $('provider-select');
    sel.innerHTML = '';
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === msg.defaultProvider) opt.selected = true;
      sel.appendChild(opt);
    }
    providerModels = msg.providerModels || {};
    renderModelSelect();
    refreshModelVal();
    renderDeck();
    renderList('objectives');
    renderList('reminders');
    handlers.status(msg.status);
    setState('idle', 'STANDBY');
    sendQuiet({ type: 'memory-conversations' });
    // Phone access: show the PHONE button on the desktop app only.
    remoteUrl = msg.remote?.url || null;
    $('phone-btn').classList.toggle('hidden', !remoteUrl || location.protocol !== 'file:');
  },
  status(s) {
    if (!s) return;
    $('cpu-bar').style.width = `${s.cpuLoad}%`;
    $('cpu-val').textContent = `${s.cpuLoad}%`;
    $('mem-bar').style.width = `${s.memUsedPct}%`;
    $('mem-val').textContent = `${s.memUsedGb} / ${s.memTotalGb} GB`;
    $('uptime-val').textContent = `${s.uptimeHours}h`;
    $('host-val').textContent = s.hostname;
  },
  user(msg) { addMsg('user', msg.text); },
  transcribing() {
    setState('thinking', 'TRANSCRIBING');
  },
  transcript() { /* echoed back as `user` by the chat pipeline */ },
  chime(msg) {
    // Rising blip = your request was heard and is being worked on.
    // When minimized the mini overlay chimes — don't double-play.
    if (document.hidden) return;
    playChime(msg.kind);
  },
  halt() {
    // Server-initiated full stop (voice "stop"/"wait"/"cancel"): kill any
    // playback, drop the busy flag, confirm with a descending earcon.
    busyTurn = false;
    stopSpeech();
    if (!document.hidden) playChime('stop');
  },
  busy(msg) {
    // Server-side truth about a turn being in flight. While on, nothing may
    // idle or sleep the face — the user must see Momzu is doing something.
    busyTurn = !!msg.on;
    if (busyTurn) {
      if (isAsleep()) setState('thinking', 'PROCESSING');
    } else if (!isAsleep() && (!speakOn || (!speaking && speechQueue.length === 0))) {
      setState('idle', 'STANDBY');
    }
  },
  thinking() {
    // A new turn is starting — cut off any leftover speech from the last one.
    speechQueue.length = 0;
    if (currentSrc) { try { currentSrc.stop(); } catch {} currentSrc = null; }
    speaking = false;
    reportSpeech(false);
    setState('thinking', 'PROCESSING');
    currentMsg = null;
  },
  acting(msg) {
    setState('working', 'ACTING');
    addMsg('action', `▶ ${msg.tool}: ${msg.input}`);
    currentMsg = null;
  },
  'action-result'(msg) {
    if (msg.output && msg.output !== '(exit 0)') {
      addMsg(msg.ok ? 'result' : 'error', msg.output.slice(0, 800));
    }
  },
  token(msg) {
    if (!currentMsg) currentMsg = addMsg('jarvis', '');
    currentMsg.textContent += msg.text;
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  },
  done(msg) {
    if (currentMsg) {
      if (msg.text?.trim()) currentMsg.textContent = msg.text;
      else currentMsg.remove(); // action-only turn — nothing to show
    }
    currentMsg = null;
    // Reset the face unless speech is (about to be) playing. A sleeping
    // face stays asleep. While the server is mid-turn, empty dones go back
    // to THINKING, never idle — 'busy: off' does the real reset.
    if (busyTurn) {
      if (!msg.text?.trim() && !isAsleep() && !speaking && speechQueue.length === 0) setState('thinking', 'PROCESSING');
    } else if (!isAsleep() && (!speakOn || (!speaking && speechQueue.length === 0))) setState('idle', 'STANDBY');
    // Keep the conversations browser fresh (unless viewing one right now).
    if (!$('memory-convos').querySelector('.back')) sendQuiet({ type: 'memory-conversations' });
  },
  'reminder-due'(msg) {
    addMsg('action', `⏰ Reminder: ${msg.text}`);
  },
  notice(msg) {
    // Informational, not an error — no red bubble, no ERROR face.
    addMsg('action', `ℹ ${msg.message}`);
  },
  error(msg) {
    addMsg('error', msg.message);
    setState('error', 'ERROR');
    // A queued-input notice mid-turn must fall back to THINKING, not idle.
    setTimeout(() => {
      if (busyTurn) setState('thinking', 'PROCESSING');
      else setState('idle', 'STANDBY');
    }, 2500);
    currentMsg = null;
  },
  cleared() { $('chat-log').innerHTML = ''; },
  'provider-changed'(msg) {
    // Keep the dropdown in sync when the provider changes elsewhere
    // (another client, or a reconnect after the server persisted it).
    const sel = $('provider-select');
    if (sel.value !== msg.defaultProvider) sel.value = msg.defaultProvider;
    renderModelSelect();
    refreshModelVal();
  },
  'ui-state'() { /* consumed by the mini widget */ },
  keys(msg) { keyStatus = msg.status || {}; refreshKeyBtn(); renderKeySections(); },
  'speak-state'(msg) { speakOn = msg.value; },
  'dictate-state'(msg) {
    dictating = msg.active;
    $('dictate-btn').classList.toggle('active', msg.active);
    setState(msg.active ? 'listening' : 'idle', msg.active ? 'DICTATING' : 'STANDBY');
  },
  'dictate-transcript'(msg) {
    addMsg('dictate', `Dictated: ${msg.text}`);
  },
  'intent-result'(msg) {
    addMsg('action', `Intent: ${msg.intent} (${Math.round(msg.confidence * 100)}%)`);
  },
  'memory-result'(msg) {
    const el = $('memory-results');
    if (!msg.results?.length) { el.innerHTML = '<div class="dim">no matches</div>'; return; }
    el.innerHTML = msg.results.map((r) =>
      `<div class="memory-result"><span class="ts">${new Date(r.timestamp).toLocaleTimeString()}</span> ${(r.content || '').slice(0, 120).replace(/</g, '&lt;')}</div>`
    ).join('');
  },
  'memory-stats'(msg) {
    if (msg.stats) $('mem-stats').textContent = `${msg.stats.totalMemories || 0} items`;
  },
  // ── past conversations browser ─────────
  'memory-conversations'(msg) {
    const el = $('memory-convos');
    const convos = (msg.conversations || []).filter((c) => c.turns > 0);
    if (!convos.length) { el.innerHTML = '<div class="dim">no past conversations yet</div>'; return; }
    el.innerHTML = convos.map((c) => {
      const d = new Date(c.started);
      return `<div class="memory-convo" data-id="${c.conversation_id}">`
        + `<span class="ts">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>`
        + ` ${c.turns} turn${c.turns > 1 ? 's' : ''}</div>`;
    }).join('');
    el.querySelectorAll('.memory-convo').forEach((div) => {
      div.onclick = () => send({ type: 'memory-conversation', id: div.dataset.id });
    });
  },
  'memory-conversation'(msg) {
    const el = $('memory-convos');
    const turns = (msg.turns || []).filter((t) => t.type === 'turn');
    el.innerHTML = '<div class="memory-convo back">← back to conversations</div>'
      + (turns.map((t) =>
        `<div class="memory-turn ${t.role}"><b>${t.role === 'user' ? 'You' : 'AI'}:</b> ${(t.content || '').slice(0, 300).replace(/</g, '&lt;')}</div>`
      ).join('') || '<div class="dim">empty conversation</div>');
    el.querySelector('.back').onclick = () => send({ type: 'memory-conversations' });
  },
  ticker(msg) {
    const track = $('ticker-track');
    track.textContent = `${new Date(msg.at).toLocaleTimeString()} — ${msg.text}   •   ${track.textContent}`.slice(0, 600);
  },
  list(msg) {
    if (msg.name === 'objectives') objectives = msg.items;
    else reminders = msg.items;
    renderList(msg.name);
  },
  async speech(msg) {
    // When minimized, the mini overlay handles playback — don't double-play.
    if (document.hidden) return;
    try {
      audioCtx ??= new AudioContext();
      const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
      const buffer = await audioCtx.decodeAudioData(bytes.buffer);
      speechQueue.push(buffer);
      playNextSpeech();
    } catch { /* skip undecodable chunk */ }
  },
};

/* ── sequential playback of streamed speech chunks ── */
const speechQueue = [];
let speaking = false;
let currentSrc = null;   // track the active source so Escape can stop it
let analyser = null;
let meterData = null;
let reportedPlaying = false; // last speech-state sent to the orchestrator

// The orchestrator needs to know when our voice is ACTUALLY coming out of
// the speakers (not when it was synthesized) — that's what its echo
// suppression keys off.
function reportSpeech(playing) {
  if (reportedPlaying === playing) return;
  reportedPlaying = playing;
  sendQuiet({ type: 'speech-state', playing });
}

let freqData = null;
let mouthShape = silentMouth();

function ensureAnalyser() {
  if (analyser) return;
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;               // rileyjarvis lip-sync settings
  analyser.smoothingTimeConstant = 0.72;
  analyser.connect(audioCtx.destination);
  meterData = new Uint8Array(analyser.fftSize);
  freqData = new Uint8Array(analyser.frequencyBinCount);
}

// lip-sync the face to the voice while it speaks
function meter() {
  if (!speaking) { mouthShape = silentMouth(); face.setMouth(mouthShape); return; }
  mouthShape = mouthFromAudio(analyser, meterData, freqData, mouthShape);
  face.setMouth(mouthShape);
  requestAnimationFrame(meter);
}

// Earcons. 'wake' = rising two-note blip: the request was heard and is being
// worked on (research: with no acknowledgment users repeat themselves louder).
// 'stop' = falling pair: the halt was accepted. Pure WebAudio — no asset files.
let lastChimeAt = 0;
function playChime(kind) {
  try {
    audioCtx ??= new AudioContext();
    // Back-to-back chimes (wake+stop on "Momzu stop") play in sequence.
    const gap = Math.max(0, lastChimeAt + 0.35 - audioCtx.currentTime);
    const t0 = audioCtx.currentTime + gap;
    lastChimeAt = t0;
    const freqs = kind === 'stop' ? [659, 440] : [880, 1318];
    freqs.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.22);
    });
  } catch { /* audio not ready — chime is best-effort */ }
}

function stopSpeech() {
  speechQueue.length = 0;
  if (currentSrc) {
    try { currentSrc.stop(); } catch {}
    currentSrc = null;
  }
  speaking = false;
  reportSpeech(false);
  face.setMouth(silentMouth());
  setState('idle', 'STANDBY');
  send({ type: 'interrupt' });
}

function playNextSpeech() {
  if (speaking) return;
  const buffer = speechQueue.shift();
  if (!buffer) { reportSpeech(false); setState('idle', 'STANDBY'); return; }
  speaking = true;
  reportSpeech(true);
  setState('speaking', 'SPEAKING');
  ensureAnalyser();
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  src.onended = () => { currentSrc = null; speaking = false; playNextSpeech(); };
  currentSrc = src;
  src.start();
  meter();
}

/* ── panels ────────────────────────────── */
function renderDeck() {
  const deck = $('command-deck');
  deck.innerHTML = '';
  for (const cmd of commandDeck) {
    const btn = document.createElement('button');
    btn.textContent = cmd.label;
    // 'chat' deck buttons are one-tap AI commands (briefing, screen, page
    // summary…) sent to the currently selected model.
    btn.onclick = () => cmd.kind === 'chat'
      ? send({ type: 'chat', text: cmd.target, provider: $('provider-select').value })
      : send({ type: 'skill', kind: cmd.kind, target: cmd.target });
    deck.appendChild(btn);
  }
}

function renderList(name) {
  const items = name === 'objectives' ? objectives : reminders;
  const ul = $(name);
  ul.innerHTML = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = item.done ? 'done' : '';
    // Timed reminders show when they fire (⏰) or that they already did (✓).
    const due = item.due
      ? `<span class="due${item.notified ? ' fired' : ''}">${item.notified ? '✓' : '⏰'} ${new Date(item.due).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>`
      : '';
    li.innerHTML = `<span class="box">${item.done ? '◈' : '◇'}</span><span>${item.text.replace(/</g, '&lt;')}${due}</span><span class="del">✕</span>`;
    li.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      items.splice(i, 1);
      send({ type: 'list.set', name, items });
    };
    li.onclick = () => {
      item.done = !item.done;
      send({ type: 'list.set', name, items });
    };
    ul.appendChild(li);
  });
}

for (const name of ['objective', 'reminder']) {
  $(`${name}-form`).addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    const listName = `${name}s`;
    const items = listName === 'objectives' ? objectives : reminders;
    // Reminders accept a time suffix: "call mom @18:30" or "stretch +20m".
    let item = { text, done: false };
    if (listName === 'reminders') {
      let m = text.match(/^(.*?)\s*@\s*(\d{1,2}):(\d{2})$/);
      if (m) {
        const d = new Date();
        d.setHours(+m[2], +m[3], 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        item = { text: m[1], done: false, due: d.getTime() };
      } else if ((m = text.match(/^(.*?)\s*\+(\d+)\s*m(?:in(?:utes?)?)?$/i))) {
        item = { text: m[1], done: false, due: Date.now() + (+m[2]) * 60000 };
      }
    }
    items.push(item);
    send({ type: 'list.set', name: listName, items });
    input.value = '';
  });
}

/* ── chat input ────────────────────────── */
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  send({ type: 'chat', text, provider: $('provider-select').value });
  $('chat-input').value = '';
});
// Interacting with the input wakes the sleeping face.
$('chat-input').addEventListener('focus', () => setState('idle', 'STANDBY'));
$('provider-select').addEventListener('change', (e) => {
  const id = e.target.value;
  // Persist the selection so it survives WebSocket reconnects.
  send({ type: 'set-provider', provider: id });
  renderModelSelect();
  refreshModelVal();
  // Selecting a provider that needs a key but has none → open Settings.
  const keyName = PROVIDER_KEY[id];
  if (keyName && keyName !== 'anthropic' && !(keyStatus[keyName] > 0)) {
    openSettings();
  }
});

/* ── per-provider model picker ─────────── */
function renderModelSelect() {
  const sel = $('model-select');
  const info = providerModels[$('provider-select').value];
  sel.innerHTML = '';
  const options = info?.options || [];
  sel.classList.toggle('hidden', options.length < 2);
  for (const m of options) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === info.current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function refreshModelVal() {
  const provider = $('provider-select').selectedOptions[0]?.textContent || '–';
  const info = providerModels[$('provider-select').value];
  const model = info?.options?.find((m) => m.id === info.current)?.label || info?.current;
  // Vitals row is narrow: drop parentheticals like "(deepest)" and keep
  // the full label for the dropdown only.
  const compact = (model ? `${provider} · ${model}` : provider).replace(/\s*\([^)]*\)/g, '');
  $('model-val').textContent = compact;
}

$('model-select').addEventListener('change', (e) => {
  send({ type: 'model-set', provider: $('provider-select').value, model: e.target.value });
});

handlers['model-changed'] = (msg) => {
  providerModels = msg.providerModels || providerModels;
  renderModelSelect();
  refreshModelVal();
};

/* ── API keys / settings modal ─────────────────── */
const KEY_PROVIDERS = [
  { id: 'gemini', label: 'GEMINI', hint: 'aistudio.google.com/apikey — paste several to pool them' },
  { id: 'deepseek', label: 'DEEPSEEK', hint: 'platform.deepseek.com/api_keys' },
  { id: 'anthropic', label: 'CLAUDE (API)', hint: 'console.anthropic.com — optional; subscription needs no key' },
];
// which providers in the dropdown depend on a stored key
const PROVIDER_KEY = { deepseek: 'deepseek', gemini: 'gemini', anthropic: 'anthropic' };
let keyStatus = {};

function renderKeySections() {
  const wrap = $('key-sections');
  wrap.innerHTML = '';
  for (const p of KEY_PROVIDERS) {
    const count = keyStatus[p.id] || 0;
    const sec = document.createElement('div');
    sec.className = 'key-section';
    sec.innerHTML = `
      <div class="krow">
        <label>${p.label}</label>
        <span class="kstat ${count ? 'set' : 'unset'}">${count ? `${count} key${count > 1 ? 's' : ''} saved` : 'no key'}</span>
      </div>
      <textarea data-provider="${p.id}" placeholder="Paste key(s), one per line${count ? ' — leave blank to keep current' : ''}"></textarea>
      <div class="khint">${p.hint}</div>
      <button class="ksave" data-provider="${p.id}">SAVE</button>
      <span class="ksaved" data-provider="${p.id}"></span>`;
    wrap.appendChild(sec);
  }
  wrap.querySelectorAll('.ksave').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.provider;
      const ta = wrap.querySelector(`textarea[data-provider="${id}"]`);
      const keys = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!keys.length) return; // blank = keep existing
      send({ type: 'keys.set', provider: id, keys });
      ta.value = '';
      const saved = wrap.querySelector(`.ksaved[data-provider="${id}"]`);
      saved.textContent = '✓ saved';
      setTimeout(() => { saved.textContent = ''; }, 2500);
    };
  });
}

function openSettings() {
  renderKeySections();
  $('settings-overlay').classList.remove('hidden');
}
function closeSettings() { $('settings-overlay').classList.add('hidden'); }

$('keys-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('settings-overlay')) closeSettings();
});

/* ── phone access modal ───────────────── */
let remoteUrl = null;

async function openPhone() {
  if (!remoteUrl) return;
  $('phone-overlay').classList.remove('hidden');
  $('phone-url').textContent = remoteUrl;
  $('phone-copied').textContent = '';
  const box = $('phone-qr');
  box.innerHTML = '';
  try {
    // Loaded on demand so a missing lib can never break the app.
    const { default: qrcode } = await import('../../node_modules/qrcode-generator/dist/qrcode.mjs');
    const qr = qrcode(0, 'M');
    qr.addData(remoteUrl);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
  } catch {
    box.innerHTML = '<div class="dim" style="padding:20px">QR unavailable — type the link below on your phone.</div>';
  }
}

$('phone-btn').addEventListener('click', openPhone);
$('phone-close').addEventListener('click', () => $('phone-overlay').classList.add('hidden'));
$('phone-overlay').addEventListener('click', (e) => {
  if (e.target === $('phone-overlay')) $('phone-overlay').classList.add('hidden');
});
$('phone-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(remoteUrl || '');
    $('phone-copied').textContent = '✓ copied';
    setTimeout(() => { $('phone-copied').textContent = ''; }, 2500);
  } catch { $('phone-copied').textContent = 'copy failed'; }
});

/* ── voice picker ─────────────────────── */
let currentTts = {};

function openVoice() {
  $('voice-overlay').classList.remove('hidden');
  $('voice-saved').textContent = '';
  send({ type: 'voices-list' });
}
function closeVoice() { $('voice-overlay').classList.add('hidden'); }

handlers.voices = (msg) => {
  currentTts = msg.current || {};
  $('voice-engine').value = ['kokoro', 'say'].includes(currentTts.engine) ? currentTts.engine : 'kokoro';
  const fill = (sel, voices, selected) => {
    sel.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.label || v.name;
      if (v.name === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  };
  const en = msg.say.filter((v) => v.lang === 'en');
  const fr = msg.say.filter((v) => v.lang === 'fr');
  fill($('voice-en'), en.length ? en : msg.say, currentTts.voice || 'Samantha');
  fill($('voice-fr'), fr.length ? fr : msg.say, currentTts.voiceFr || 'Amélie');
  fill($('voice-kokoro'),
    (msg.kokoro?.voices || []).map((v) => ({ name: v.id, label: v.label })),
    currentTts.kokoroVoice || 'af_heart');
  $('voice-kokoro-note').textContent = !msg.kokoro?.installed
    ? 'Kokoro is not installed on this Mac.'
    : msg.kokoro?.ready
      ? 'Kokoro is loaded and ready. French replies use its native French voice automatically.'
      : 'Kokoro warms up in a few seconds after the app starts. French replies use its native French voice automatically.';
  updateVoicePanels();
};

handlers['voice-state'] = (msg) => { currentTts = msg.tts || currentTts; };

function updateVoicePanels() {
  const engine = $('voice-engine').value;
  $('voice-kokoro-opts').classList.toggle('hidden', engine !== 'kokoro');
  $('voice-say-opts').classList.toggle('hidden', engine !== 'say');
}

$('voice-btn').addEventListener('click', openVoice);
$('voice-close').addEventListener('click', closeVoice);
$('voice-overlay').addEventListener('click', (e) => {
  if (e.target === $('voice-overlay')) closeVoice();
});
$('voice-engine').addEventListener('change', updateVoicePanels);
$('voice-save').addEventListener('click', () => {
  send({
    type: 'voice-set',
    tts: {
      engine: $('voice-engine').value,
      voice: $('voice-en').value,
      voiceFr: $('voice-fr').value,
      kokoroVoice: $('voice-kokoro').value,
    },
  });
  $('voice-saved').textContent = '✓ saved — listen…';
  setTimeout(() => { $('voice-saved').textContent = ''; }, 4000);
});

function refreshKeyBtn() {
  // highlight the KEYS button if any non-claude provider still lacks a key
  const missing = KEY_PROVIDERS.some((p) => p.id !== 'anthropic' && !(keyStatus[p.id] > 0));
  $('keys-btn').classList.toggle('has-missing', missing);
}

/* ── voice-only mode: hide the text, just talk ─── */
function applyVoiceOnly(on) {
  document.body.classList.toggle('voice-only', on);
  $('text-toggle').classList.toggle('off', on);
  localStorage.setItem('voiceOnly', on ? '1' : '');
}
$('memory-search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  if (q) send({ type: 'memory-query', query: q });
  else $('memory-results').innerHTML = '';
});
$('dictate-btn').addEventListener('click', toggleDictate);
$('text-toggle').addEventListener('click', () =>
  applyVoiceOnly(!document.body.classList.contains('voice-only')));
applyVoiceOnly(!!localStorage.getItem('voiceOnly'));

/* ── push-to-talk ──────────────────────── */
let silenceTimer = null;
let silenceAc = null; // AudioContext for silence detection

async function startRecording() {
  if (recording) return;
  // Barge-in: talking again cuts the assistant off — stop playback locally
  // and abort any in-flight generation server-side before listening.
  if (speaking || speechQueue.length) {
    speechQueue.length = 0;
    if (currentSrc) { try { currentSrc.stop(); } catch {} currentSrc = null; }
    speaking = false;
    face.setMouth(silentMouth());
  }
  sendQuiet({ type: 'interrupt' });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      stopSilenceDetect();
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      if (blob.size < 2000) { setState('idle', 'STANDBY'); sendQuiet({ type: 'ui-state', state: 'idle' }); return; }
      sendQuiet({ type: 'ui-state', state: 'thinking' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      const audioType = dictating ? 'dictate-audio' : 'audio';
      send({ type: audioType, data: btoa(bin), provider: $('provider-select').value });
    };
    mediaRecorder.start();
    recording = true;
    $('mic-btn').classList.add('recording');
    setState('listening', 'LISTENING');
    // Let the mini widget mirror the mic state while recording.
    sendQuiet({ type: 'ui-state', state: 'listening' });

    // Auto-stop after 1.5s of silence — feels like walkie-talkie: press
    // the shortcut, speak, and it stops on its own when you're done.
    startSilenceDetect(stream);
  } catch (err) {
    // Browsers only expose the mic in a secure context — a phone on the
    // plain-http link has no navigator.mediaDevices at all.
    const insecure = location.protocol === 'http:'
      && !['localhost', '127.0.0.1'].includes(location.hostname);
    addMsg('error', insecure
      ? 'Mic needs the secure link: tap 📱 PHONE on the Mac and scan the new QR (https), accept the certificate warning once.'
      : `Mic error: ${err.message} — allow microphone access in System Settings.`);
  }
}

function startSilenceDetect(stream) {
  stopSilenceDetect();
  try {
    silenceAc = new AudioContext();
    const src = silenceAc.createMediaStreamSource(stream);
    const analyser = silenceAc.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let silentSince = null;

    function tick() {
      if (!silenceAc) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      if (rms < 0.015) {
        if (silentSince === null) silentSince = Date.now();
        else if (Date.now() - silentSince > 1500) {
          stopRecording();
          return;
        }
      } else {
        silentSince = null;
      }
      silenceTimer = requestAnimationFrame(tick);
    }
    silenceTimer = requestAnimationFrame(tick);
  } catch { /* silence detection is best-effort */ }
}

function stopSilenceDetect() {
  if (silenceTimer) { cancelAnimationFrame(silenceTimer); silenceTimer = null; }
  if (silenceAc) { silenceAc.close().catch(() => {}); silenceAc = null; }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  $('mic-btn').classList.remove('recording');
  mediaRecorder?.stop();
}

$('mic-btn').addEventListener('click', () => recording ? stopRecording() : startRecording());
window.jarvis?.onPTT(() => recording ? stopRecording() : startRecording());
window.jarvis?.onPTTStart(() => { if (!recording) startRecording(); });
window.jarvis?.onPTTStop(() => { if (recording) stopRecording(); });
window.jarvis?.onDictateToggle(() => toggleDictate());

function toggleDictate() {
  dictating = !dictating;
  send({ type: dictating ? 'dictate-start' : 'dictate-stop' });
}

// hold spacebar to talk (when not typing in a field)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    startRecording();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && recording &&
      !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    stopRecording();
  }
});

// Escape stops any ongoing speech / generation.
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') stopSpeech();
});

connect();
