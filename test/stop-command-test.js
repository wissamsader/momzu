// Instant STOP command + ack chime test:
//   1. idle "stop" → halt broadcast (no model turn, no busy, no ack chime)
//   2. "count to ten" → NOT a stop command: a real turn starts and the ack
//      chime(kind:wake) fires at turn start (replaces the old spoken "Sure.")
//      — then halted mid-turn by "wait wait wait wait" → halt + busy:false
//
// Needs the app (or dev orchestrator) running on :8765. Momzu may speak
// briefly during step 2 — run while the user is away.
// Run: node test/stop-command-test.js
import { WebSocket } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ws = new WebSocket('ws://127.0.0.1:8765');
  const events = [];
  let failures = 0;
  const assert = (ok, label) => {
    console.log(`${ok ? '✓' : '✗ FAIL'}: ${label}`);
    if (!ok) failures++;
  };
  const waitFor = (pred, timeoutMs) => new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit || Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(hit || null); }
    }, 50);
  });

  ws.on('message', (buf) => {
    try { events.push(JSON.parse(buf)); } catch { /* binary */ }
  });
  await new Promise((r) => ws.once('open', r));
  await waitFor((m) => m.type === 'init', 5000);

  // ── 1. idle stop → halt, and never a busy turn ─────────────────────────
  events.length = 0;
  ws.send(JSON.stringify({ type: 'chat', text: 'stop' }));
  const halt1 = await waitFor((m) => m.type === 'halt', 3000);
  assert(!!halt1, 'idle "stop" → halt broadcast');
  await sleep(1000);
  assert(!events.some((m) => m.type === 'busy' && m.on), 'idle "stop" never starts a model turn');
  assert(!events.some((m) => m.type === 'chime' && m.kind === 'wake'), 'idle "stop" plays no ack chime');

  // ── 2. non-stop phrase runs (with ack chime); "wait" kills it mid-turn ──
  events.length = 0;
  ws.send(JSON.stringify({ type: 'chat', text: 'Count slowly from one to ten in words, one number per sentence.' }));
  const busyOn = await waitFor((m) => m.type === 'busy' && m.on, 15000);
  assert(!!busyOn, '"count to ten" starts a real turn (not misread as stop)');
  const ack = await waitFor((m) => m.type === 'chime' && m.kind === 'wake', 5000);
  assert(!!ack, 'turn start → ack chime(kind:wake) instead of spoken "Sure."');
  await waitFor((m) => m.type === 'token', 60000); // let it actually produce output
  ws.send(JSON.stringify({ type: 'chat', text: 'Wait, wait, wait, wait.' }));
  const halt2 = await waitFor((m) => m.type === 'halt', 5000);
  assert(!!halt2, 'mid-turn "wait wait wait" → halt broadcast');
  const busyOff = await waitFor((m) => m.type === 'busy' && m.on === false, 15000);
  assert(!!busyOff, 'halted turn dies → busy:false');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL STOP-COMMAND TESTS PASSED');
  ws.close();
  process.exit(failures ? 1 : 0);
})();
