// Verify: Arabic input → reply in English, no Arabic script in
// tokens or spoken text. Run against the live orchestrator on :8765.
import WebSocket from 'ws';

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const ws = new WebSocket('ws://127.0.0.1:8765');

const spoken = [];
let reply = '';
let done = false;
let lastActivity = Date.now();

const hardTimeout = setTimeout(() => finish('TIMEOUT'), 120000);
const idle = setInterval(() => {
  if (done && Date.now() - lastActivity > 8000) finish(null);
}, 1000);

function finish(err) {
  clearTimeout(hardTimeout);
  clearInterval(idle);
  ws.close();
  console.log('reply text:', JSON.stringify(reply.trim().slice(0, 300)));
  console.log('spoken chunks:', spoken.length);
  for (const s of spoken) console.log('  »', JSON.stringify(s.slice(0, 120)));
  let failures = 0;
  if (err) { console.error('✗', err); failures++; }
  if (ARABIC.test(reply)) { console.error('✗ ARABIC SCRIPT IN REPLY'); failures++; }
  for (const s of spoken) if (ARABIC.test(s)) { console.error('✗ ARABIC SCRIPT SPOKEN'); failures++; }
  if (!reply.trim()) { console.error('✗ empty reply'); failures++; }
  console.log(failures === 0 ? 'PASS — English-only reply' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

ws.on('open', () => {
  // Arabic: "hi, how are you? what's the weather like today in Paris?"
  ws.send(JSON.stringify({
    type: 'chat',
    text: 'مرحبا، كيف حالك؟ ما هو طقس اليوم في باريس؟',
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (['token', 'speaking', 'done', 'thinking'].includes(msg.type)) lastActivity = Date.now();
  if (msg.type === 'token') reply += msg.text ?? msg.token ?? '';
  if (msg.type === 'speaking') spoken.push(msg.text);
  if (msg.type === 'error') console.error('  [error]', msg.message);
  if (msg.type === 'done') done = true;
});
ws.on('error', (e) => finish('ws error: ' + e.message));
