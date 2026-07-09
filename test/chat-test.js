// Headless orchestrator test: connect over ws, send a chat, expect a reply.
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:8765');
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 90000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'chat', text: 'Reply with exactly: JARVIS ONLINE', provider: 'claude-cli' }));
});

let reply = '';
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'init') console.log('init: providers =', msg.providers.map((p) => p.id).join(', '));
  if (msg.type === 'token') reply += msg.text;
  if (msg.type === 'error') { console.error('ERROR:', msg.message); process.exit(1); }
  if (msg.type === 'done') {
    console.log('reply:', JSON.stringify(msg.text));
    clearTimeout(timeout);
    process.exit(/JARVIS ONLINE/i.test(msg.text) ? 0 : 1);
  }
});
