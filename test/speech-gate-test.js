// Speech gate test — proves code is NEVER spoken aloud, no matter how the
// model formats it or how the stream is chunked. Runs each case many times
// with random chunk sizes (1..17 chars) to simulate real token streaming.
import { createSpeechGate, looksLikeCode, speakableText } from '../orchestrator/voice/tts.js';
import { parseActions, stripActions } from '../orchestrator/computer.js';

let failures = 0;
const fail = (name, msg) => { failures++; console.error(`✗ ${name}: ${msg}`); };
const pass = (name) => console.log(`✓ ${name}`);

// Stream `text` through a fresh gate in random chunks; return spoken text.
function speakAll(text, seedChunks = null) {
  const gate = createSpeechGate();
  let out = '';
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const size = seedChunks ? seedChunks[n++ % seedChunks.length] : 1 + Math.floor(Math.random() * 17);
    out += gate.feed(text.slice(i, i + size));
    i += size;
  }
  out += gate.flush();
  return out;
}

const CODE_MARKERS = [
  '<!DOCTYPE', '<html', '<head', '<body', '<div', '</div', '<h1', 'function ',
  'const ', 'document.querySelector', 'margin:', 'padding:', 'background:',
  'display: flex', '{', '}', '```', 'ACTION', 'querySelector', '=>', 'onclick',
];

function assertNoCode(name, spoken) {
  for (const marker of CODE_MARKERS) {
    if (spoken.includes(marker)) {
      fail(name, `spoken output contains ${JSON.stringify(marker)} — full spoken: ${JSON.stringify(spoken.slice(0, 300))}`);
      return false;
    }
  }
  return true;
}

const HTML = '<!DOCTYPE html>\\n<html>\\n<head>\\n<style>\\nbody { margin: 0; background: #111; color: #eee; font-family: sans-serif; }\\n.hero { display: flex; padding: 4rem; }\\n</style>\\n</head>\\n<body>\\n<div class=\\"hero\\"><h1>Welcome. To. My. Site.</h1></div>\\n<script>\\nconst btn = document.querySelector(\'.cta\'); function go() { window.location = \'#\'; }\\n</script>\\n</body>\\n</html>';

// ── Case 1: DeepSeek-style — prose, then single-line ACTION write with full site
{
  const name = 'ACTION write with embedded website (single line JSON)';
  const text = `On it. I will build the site now.\nACTION {"tool":"write","path":"~/Desktop/site/index.html","content":"${HTML}"}\nDone — your website is on the Desktop. Want me to open it?`;
  let ok = true;
  for (let run = 0; run < 200 && ok; run++) ok = assertNoCode(name, speakAll(text));
  const spoken = speakAll(text, [7]);
  if (ok && !spoken.includes('On it')) { fail(name, `lost the "On it." prose: ${JSON.stringify(spoken)}`); ok = false; }
  if (ok && !/Done — your website is on the Desktop/.test(spoken)) { fail(name, `lost closing prose: ${JSON.stringify(spoken)}`); ok = false; }
  if (ok) pass(name);
}

// ── Case 2: Gemini-style — code fences with raw HTML/CSS/JS
{
  const name = 'fenced code block with website code';
  const text = 'On it. Here is the site.\n```html\n' + HTML.replace(/\\n/g, '\n').replace(/\\"/g, '"') + '\n```\nDone. The site is ready on your Desktop.';
  let ok = true;
  for (let run = 0; run < 200 && ok; run++) ok = assertNoCode(name, speakAll(text));
  const spoken = speakAll(text, [5]);
  if (ok && !spoken.includes('Done. The site is ready')) { fail(name, `lost closing prose: ${JSON.stringify(spoken)}`); ok = false; }
  if (ok) pass(name);
}

// ── Case 3: worst case — raw unfenced code dumped straight into prose
{
  const name = 'raw unfenced multi-line website code';
  const text = 'Sure, creating the page.\n' + HTML.replace(/\\n/g, '\n').replace(/\\"/g, '"') + '\nAll done, check your Desktop.';
  let ok = true;
  for (let run = 0; run < 200 && ok; run++) ok = assertNoCode(name, speakAll(text));
  if (ok) pass(name);
}

// ── Case 4: multiple ACTIONs (multi-file site) + shell heredoc with braces
{
  const name = 'multiple ACTIONs incl. shell heredoc with braces';
  const text = [
    'On it.',
    `ACTION {"tool":"write","path":"~/Desktop/site/index.html","content":"${HTML}"}`,
    'ACTION {"tool":"write","path":"~/Desktop/site/style.css","content":"body { margin: 0; } .nav { color: red; }"}',
    String.raw`ACTION {"tool":"shell","input":"cat > ~/Desktop/site/app.js <<'EOF'\nfunction hi() { console.log('hi'); }\nEOF"}`,
    'Done — three files created. Anything else?',
  ].join('\n');
  let ok = true;
  for (let run = 0; run < 200 && ok; run++) ok = assertNoCode(name, speakAll(text));
  const spoken = speakAll(text, [3]);
  if (ok && !spoken.includes('Done — three files created')) { fail(name, `lost closing prose: ${JSON.stringify(spoken)}`); ok = false; }
  if (ok) pass(name);
}

// ── Case 5: plain prose passes through intact (nothing over-suppressed)
{
  const name = 'plain prose untouched';
  const cases = [
    'Sure. The weather in Lisbon is 22 degrees and sunny. Perfect for a walk.',
    "C'est fait. Le dossier est sur le bureau. Autre chose?",
    'Your meeting is at 15:30. I set a reminder 20 minutes before. You have 3 open objectives.',
    'Done — the site is on your Desktop, want me to open it?',
  ];
  let ok = true;
  for (const c of cases) {
    for (let run = 0; run < 50 && ok; run++) {
      const spoken = speakAll(c).replace(/\s+/g, ' ').trim();
      const want = c.replace(/\s+/g, ' ').trim();
      if (spoken !== want) { fail(name, `prose mangled:\n  want: ${want}\n  got:  ${spoken}`); ok = false; }
    }
  }
  if (ok) pass(name);
}

// ── Case 6: prose containing the word Action (not the directive) survives
{
  const name = 'the word "action" in prose is not eaten';
  const spoken = speakAll('The action movie starts at nine. I booked two tickets.', [4]);
  if (!spoken.includes('action movie starts at nine')) fail(name, `got: ${JSON.stringify(spoken)}`);
  else pass(name);
}

// ── Case 7: parseActions handles nested braces + multi-line JSON
{
  const name = 'parseActions with braces in content';
  const text = `ACTION {"tool":"write","path":"~/x.css","content":"body { margin: 0; } h1 { color: red; }"}`;
  const actions = parseActions(text);
  if (actions.length !== 1) fail(name, `expected 1 action, got ${actions.length}`);
  else if (!actions[0].content.includes('margin: 0; }')) fail(name, `content truncated: ${actions[0].content}`);
  else pass(name);
}

// ── Case 8: stripActions removes the full balanced span
{
  const name = 'stripActions removes whole ACTION incl. braces';
  const text = `On it.\nACTION {"tool":"write","path":"~/x.css","content":"body { margin: 0; }"}\nDone.`;
  const stripped = stripActions(text);
  if (stripped.includes('{') || stripped.includes('margin')) fail(name, `leak: ${JSON.stringify(stripped)}`);
  else if (!/On it\.\s*Done\./.test(stripped)) fail(name, `prose lost: ${JSON.stringify(stripped)}`);
  else pass(name);
}

// ── Case 9: looksLikeCode belt-and-braces catches leaked snippets
{
  const name = 'looksLikeCode catches common code sentences';
  const codey = [
    'const x = document.querySelector(".btn");',
    'body { margin: 0; padding: 0; }',
    '<div class="hero">Hello</div>',
    'if (x === 1) { return true; }',
    'npm install && npm run build',
    '.hero { display: flex; }',
  ];
  const prose = [
    'Done — the site is on your Desktop, want me to open it?',
    'The temperature is 22 degrees; quite warm for October.',
    'I added milk, eggs and bread to your list.',
  ];
  let ok = true;
  for (const c of codey) if (!looksLikeCode(c)) { fail(name, `missed code: ${c}`); ok = false; }
  for (const p of prose) if (looksLikeCode(p)) { fail(name, `false positive on prose: ${p}`); ok = false; }
  if (ok) pass(name);
}

// ── Case 10: 500 fuzz runs mixing everything, random chunking
{
  const name = 'fuzz: 500 random-chunk runs over mixed output';
  const text = [
    'On it. Building your portfolio site now.',
    `ACTION {"tool":"write","path":"~/Desktop/portfolio/index.html","content":"${HTML}"}`,
    '```css\nbody { background: black; }\n.card { border-radius: 12px; }\n```',
    'ACTION {"tool":"shell","input":"open ~/Desktop/portfolio/index.html"}',
    'Done — the portfolio is live on your Desktop and open in your browser. Want changes?',
  ].join('\n');
  let ok = true;
  for (let run = 0; run < 500 && ok; run++) ok = assertNoCode(name, speakAll(text));
  if (ok) pass(name);
}

// speakableText still strips markdown for the final say/kokoro layer
{
  const name = 'speakableText strips residual markdown';
  const out = speakableText('Done — **the site** is [here](https://x.com). `npm start` runs it.');
  if (/[*[\]`]/.test(out) || out.includes('https')) fail(name, out);
  else pass(name);
}

console.log(failures === 0 ? '\nALL SPEECH-GATE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
