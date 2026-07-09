// End-to-end: the Claude agent provider must drive the real Chrome through
// the Claude-in-Chrome extension tools (mcp__claude-in-chrome__*), exactly
// like Claude Code does. Requires orchestrator on :8765, Chrome running with
// the extension installed.
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:8765');
const acting = [];
const spoken = [];
let doneText = '';
let done = false;
let lastActivity = Date.now();

const hardTimeout = setTimeout(() => finish('TIMEOUT'), 240000);
const idle = setInterval(() => {
  if (done && Date.now() - lastActivity > 15000) finish(null);
}, 1000);

function finish(err) {
  clearTimeout(hardTimeout);
  clearInterval(idle);
  ws.close();
  console.log('tools used:', acting.join(', ') || '(none)');
  console.log('spoken:', spoken.map((s) => JSON.stringify(s.slice(0, 120))).join(' '));
  console.log('done text:', JSON.stringify(doneText.slice(0, 300)));
  let failures = 0;
  if (err) { console.error(`✗ ${err}`); failures++; }
  const usedExtension = acting.some((t) => t.startsWith('chrome: '));
  if (!usedExtension) { console.error('✗ agent did NOT use the Claude-in-Chrome extension tools'); failures++; }
  else console.log('✓ agent drove Chrome via the extension:', acting.filter((t) => t.startsWith('chrome: ')).join(', '));
  if (!/example domain/i.test(doneText + ' ' + spoken.join(' '))) {
    console.error('✗ page title "Example Domain" not reported'); failures++;
  } else console.log('✓ read the real page title from the browser');
  console.log(failures === 0 ? '\nCHROME EXTENSION TEST — PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'chat',
    provider: 'claude-agent',
    text: 'Open example.com in a new Chrome tab using your Chrome browser extension tools, read the page, and tell me the exact page heading.',
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (['token', 'speaking', 'acting', 'action-result', 'done', 'thinking'].includes(msg.type)) lastActivity = Date.now();
  if (msg.type === 'acting') acting.push(msg.tool);
  if (msg.type === 'speaking') spoken.push(msg.text);
  if (msg.type === 'error') console.error('  [error]', msg.message);
  if (msg.type === 'done') { done = true; doneText += ' ' + (msg.text || ''); }
});
ws.on('error', (e) => finish(`ws error: ${e.message}`));
