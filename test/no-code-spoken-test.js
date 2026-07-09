// End-to-end proof that building a website NEVER speaks code aloud.
// Requires the orchestrator running on ws://127.0.0.1:8765 with API keys.
//   node test/no-code-spoken-test.js deepseek
//   node test/no-code-spoken-test.js gemini
import WebSocket from 'ws';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const provider = process.argv[2] || 'deepseek';
const siteDir = path.join(os.homedir(), 'Desktop', `jarvis-voice-test-${provider}`);
rmSync(siteDir, { recursive: true, force: true });

const CODE_MARKERS = [
  '<!DOCTYPE', '<html', '<head>', '<body', '<div', '</', '<h1', '<style',
  'function ', 'const ', 'document.', 'margin:', 'padding:', 'display: flex',
  '{', '}', '```', 'ACTION', '=>',
];

const ws = new WebSocket('ws://127.0.0.1:8765');
const spoken = [];
const tickers = [];
let lastActivity = Date.now();
let done = false;

const hardTimeout = setTimeout(() => finish('TIMEOUT waiting for completion'), 240000);

function finish(err) {
  clearTimeout(hardTimeout);
  clearInterval(idle);
  ws.close();
  console.log(`\n[${provider}] spoken chunks (${spoken.length}):`);
  for (const s of spoken) console.log(`  » ${JSON.stringify(s.slice(0, 160))}`);
  let failures = 0;
  if (err) { console.error(`✗ ${err}`); failures++; }
  if (spoken.length === 0) { console.error('✗ nothing was spoken at all (expected at least "On it.")'); failures++; }
  for (const s of spoken) {
    for (const m of CODE_MARKERS) {
      if (s.includes(m)) { console.error(`✗ CODE SPOKEN ALOUD — marker ${JSON.stringify(m)} in ${JSON.stringify(s.slice(0, 200))}`); failures++; }
    }
  }
  const index = path.join(siteDir, 'index.html');
  if (!existsSync(index)) {
    console.error(`✗ site file was not created at ${index} (tickers: ${tickers.slice(-6).join(' | ')})`);
    failures++;
  } else {
    const html = readFileSync(index, 'utf8');
    console.log(`✓ site created: ${index} (${html.length} chars, has <html>: ${/<html/i.test(html)})`);
  }
  rmSync(siteDir, { recursive: true, force: true });
  console.log(failures === 0 ? `\n[${provider}] NO CODE SPOKEN — PASS` : `\n[${provider}] ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

// Finish once things go quiet after at least one 'done'.
const idle = setInterval(() => {
  if (done && Date.now() - lastActivity > 20000) finish(null);
}, 1000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'chat',
    provider,
    text: `Build a simple one page website about coffee and save it as index.html inside the folder ${siteDir} on my desktop. Then tell me when it is done.`,
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  // Only turn-related traffic counts as activity — periodic tickers and
  // status broadcasts would otherwise keep the idle timer alive forever.
  if (['token', 'speaking', 'acting', 'action-result', 'done', 'thinking'].includes(msg.type)) {
    lastActivity = Date.now();
  }
  if (msg.type === 'speaking') spoken.push(msg.text);
  if (msg.type === 'ticker') tickers.push(msg.text);
  if (msg.type === 'error') console.error(`  [error msg] ${msg.message}`);
  if (msg.type === 'done') done = true;
});
ws.on('error', (e) => finish(`ws error: ${e.message}`));
