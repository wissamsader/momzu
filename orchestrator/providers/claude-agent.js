// Claude Agent SDK — the engine behind Claude Code, on the logged-in
// subscription. One PERSISTENT streaming session per app run: the engine
// process stays warm across turns (no per-message spawn), keeps its own
// conversation context, and runs the full agentic loop with self-correction.
//
// The system prompt uses the SDK's claude_code PRESET with our personality
// appended — replacing the preset with a custom string strips the agentic
// operating instructions and visibly degrades tool use.
import os from 'node:os';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { toolDefs } from '../tools.js';

const asResult = (r) => ({ content: [{ type: 'text', text: (r.ok ? '' : 'ERROR: ') + r.output }], isError: !r.ok });

// All capabilities come from the shared toolkit (orchestrator/tools.js) —
// the same definitions power DeepSeek/Gemini native function calling.
const jarvisTools = createSdkMcpServer({
  name: 'jarvis',
  tools: toolDefs.map((t) =>
    tool(t.name, t.description, t.schema.shape, async (args) => asResult(await t.run(args)))),
});

// Minimal push-based async channel: bridges the SDK's single message stream
// to one consumer per turn.
class Channel {
  constructor() { this.buf = []; this.waiters = []; this.closed = false; }
  push(v) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false }); else this.buf.push(v);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

export function createProvider(config = {}) {
  let session = null; // { q, input, setTurn }

  function startSession(systemAppend) {
    const input = new Channel();
    let turn = null;
    const q = query({
      prompt: (async function* () { for await (const m of input) yield m; })(),
      options: {
        model: config.model || 'sonnet',
        ...(config.effort ? { effort: config.effort } : {}),
        cwd: os.homedir(),
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
        mcpServers: { jarvis: jarvisTools },
        // Claude in Chrome: gives the agent the same browser-extension tools
        // Claude Code has (mcp__claude-in-chrome__*) — it drives the user's
        // real Chrome: navigate, click, fill forms, read pages. Harmless if
        // the extension isn't running; the AppleScript chrome tool remains
        // as fallback.
        extraArgs: { chrome: null },
      },
    });
    // seenLen: how many history messages this warm session has witnessed.
    // Turns handled by OTHER providers (or restored from a previous run) are
    // invisible to the session, so chat() recaps them inline.
    const s = { q, input, seenLen: 0, setTurn(ch) { turn = ch; } };
    (async () => {
      try {
        for await (const msg of q) {
          const isEnd = msg.type === 'result';
          turn?.push(msg);
          if (isEnd) { turn?.close(); turn = null; }
        }
      } catch (err) {
        turn?.push({ type: 'session_error', error: err });
      } finally {
        turn?.close(); turn = null;
        if (session === s) session = null; // engine died → fresh session next turn
      }
    })();
    return s;
  }

  // The engine's own auth errors speak Claude-Code-ese ("Please run
  // /login") — translate to the guide's words. Also drop the warm session:
  // a sign-in done right after (in Terminal) is then picked up on the next
  // try, no app restart needed.
  function friendlyError(raw) {
    const msg = String(raw?.message || raw || 'agent error');
    if (/not logged in|please run \/login|invalid bearer token|token has expired/i.test(msg)) {
      try { session?.input.close(); } catch { /* already gone */ }
      session = null;
      return new Error('Claude isn\'t signed in on this Mac yet — do the one-time "Connect a brain" setup in the guide (install Claude Code, sign in with your Claude subscription), then just ask me again.');
    }
    return raw instanceof Error ? raw : new Error(msg);
  }

  return {
    id: 'claude-agent',
    label: config.label || 'Claude (agent)',

    reset() {
      try { session?.input.close(); } catch { /* already gone */ }
      session = null;
    },

    async interrupt() {
      try { await session?.q.interrupt(); } catch { /* turn already over */ }
    },

    async *chat(messages, { systemPrompt, onEvent } = {}) {
      const last = messages[messages.length - 1];
      if (!session) session = startSession(systemPrompt || '');
      // Recap any turns this warm session never saw — conversation that
      // happened on other models, or before an app restart. Without this the
      // agent has no idea what was just discussed when the user switches back.
      const unseen = messages.slice(session.seenLen, -1);
      let content = last.content;
      if (unseen.length > 0) {
        const recap = unseen
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 500)}`)
          .join('\n');
        content = `[Earlier conversation you were not part of (handled by another model or a previous session) — context only, do not re-answer it:]\n${recap}\n\n[The user's current message:]\n${content}`;
      }
      session.seenLen = messages.length;
      // The warm session's system prompt is frozen at start, so the current
      // time rides along with each message (needed for reminders, "today").
      content = `[Local time: ${new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}]\n${content}`;
      const turn = new Channel();
      session.setTurn(turn);
      session.input.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      });

      // Narration control: text BEFORE the first tool call streams out
      // (spoken) and text AFTER the last tool call is the spoken
      // outcome — but step-by-step commentary BETWEEN tool calls ("I found
      // fa, I'll open the conversation…") is routed to onEvent as narration:
      // shown in the dashboard, never yielded, so it is never spoken.
      let toolUsed = false;
      let textBuf = '';
      let lastNarration = '';
      for await (const msg of turn) {
        if (msg.type === 'session_error') throw friendlyError(msg.error);
        if (msg.type === 'stream_event') {
          const delta = msg.event?.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            if (toolUsed) textBuf += delta.text;
            else yield delta.text;
          }
        } else if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              // Whatever text piled up before this tool call was narration.
              if (textBuf.trim()) {
                lastNarration = textBuf;
                onEvent?.({ kind: 'narration', text: textBuf });
              }
              textBuf = '';
              toolUsed = true;
              onEvent?.({
                kind: 'acting',
                tool: block.name.replace(/^mcp__claude-in-chrome__/, 'chrome: ').replace(/^mcp__jarvis__/, ''),
                input: summarizeInput(block.input),
              });
            }
          }
        } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              const text = Array.isArray(block.content)
                ? block.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
                : String(block.content ?? '');
              onEvent?.({ kind: 'result', ok: !block.is_error, output: text.slice(0, 400) });
            }
          }
        } else if (msg.type === 'result') {
          if (msg.is_error) throw friendlyError(new Error(String(msg.result || msg.subtype || 'agent error').slice(0, 400)));
        }
      }
      // Text after the LAST tool call is the real outcome — speak it.
      if (textBuf.trim()) yield textBuf;
      else if (toolUsed && lastNarration.trim()) {
        // The turn ENDED on a silent tool call (the model composed its
        // summary, then ran one last tool — notes update, cleanup…). That
        // summary IS the outcome; it's already in the transcript as
        // narration, so route it to speech only — never end a task silent.
        onEvent?.({ kind: 'outcome-speech', text: lastNarration });
      }
    },
  };
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const v = input.command || input.script || input.app || input.file_path || input.pattern
    || Object.values(input).find((x) => typeof x === 'string') || JSON.stringify(input);
  return String(v).slice(0, 120);
}
