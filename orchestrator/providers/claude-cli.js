// Claude via the locally-authenticated `claude` CLI — uses your Pro
// subscription, no API key. Conversation continuity via --resume.
// System instructions are injected directly into each message so the
// model cannot ignore them (--append-system-prompt is too easy to bypass).
import { spawn } from 'node:child_process';

export function createProvider(config = {}) {
  let sessionId = null;

  return {
    id: 'claude-cli',
    label: config.label || 'Claude (subscription)',

    reset() { sessionId = null; },

    async *chat(messages, { systemPrompt, onEvent } = {}) {
      const last = messages[messages.length - 1];

      // Inject system instructions directly into the message — the model
      // MUST see them. --append-system-prompt is unreliable; the model can
      // ignore it. Direct injection is impossible to ignore.
      const content = systemPrompt
        ? `${systemPrompt}\n\n---\n\nUSER MESSAGE: ${last.content}`
        : last.content;

      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--setting-sources', '',
        // Claude in Chrome: browser tasks drive the real Chrome through the
        // extension (navigate/click/fill/read), auto-allowed so headless
        // runs don't stall on permission prompts.
        '--chrome',
        '--allowedTools', 'mcp__claude-in-chrome',
      // Let Claude use native tools (bash) for Mac control — no --tools flag
      ];
      if (config.model) args.push('--model', config.model);
      if (config.effort) args.push('--effort', config.effort);
      if (sessionId) args.push('--resume', sessionId);

      const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      // A missing `claude` binary must become a spoken error, not an
      // unhandled 'error' event that kills the whole orchestrator. The
      // stdin handler swallows the EPIPE that follows a failed spawn.
      let spawnErr = null;
      child.on('error', (err) => { spawnErr = err; });
      child.stdin.on('error', () => {});
      child.stdin.write(content);
      child.stdin.end();

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });

      let buf = '';
      let yieldedDelta = false;
      let fullFallback = '';
      // Same narration control as the agent provider: text between tool
      // calls is shown but never yielded (yielded text gets spoken aloud).
      let toolUsed = false;
      let textBuf = '';
      let lastNarration = '';
      for await (const chunk of child.stdout) {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.session_id) sessionId = ev.session_id;
          if (ev.type === 'stream_event') {
            const delta = ev.event?.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              yieldedDelta = true;
              if (toolUsed) textBuf += delta.text;
              else yield delta.text;
            }
          } else if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text') fullFallback += block.text;
              if (block.type === 'tool_use') {
                if (textBuf.trim()) {
                  lastNarration = textBuf;
                  onEvent?.({ kind: 'narration', text: textBuf });
                }
                textBuf = '';
                toolUsed = true;
                onEvent?.({
                  kind: 'acting',
                  tool: String(block.name || '').replace(/^mcp__claude-in-chrome__/, 'chrome: '),
                  input: JSON.stringify(block.input || {}).slice(0, 120),
                });
              }
            }
          }
        }
      }
      if (textBuf.trim()) yield textBuf; // outcome after the last tool call
      else if (toolUsed && lastNarration.trim() && yieldedDelta) {
        // Turn ended on a silent tool call — the summary composed before it
        // is the outcome (already in the transcript): speech only.
        onEvent?.({ kind: 'outcome-speech', text: lastNarration });
      }
      if (!yieldedDelta && fullFallback) yield fullFallback;

      const code = await new Promise((res) => {
        if (spawnErr) return res(-1);
        child.on('close', res);
        child.on('error', () => res(-1));
      });
      if (spawnErr) {
        throw new Error(spawnErr.code === 'ENOENT'
          ? 'Claude Code isn\'t installed on this Mac yet — follow the "Connect a brain" steps in the guide, or pick another brain from the dropdown.'
          : `couldn't start the claude command: ${spawnErr.message}`);
      }
      if (code !== 0 && !yieldedDelta && !fullFallback) {
        throw new Error(`claude CLI exited ${code}: ${stderr.slice(0, 400)}`);
      }
    },
  };
}
