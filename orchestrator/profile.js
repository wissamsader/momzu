// User profile — durable facts about the user, extracted from conversations
// by a cheap one-shot Haiku call (Agent SDK, runs on the logged-in
// subscription — no API key). Replaces the old regex "fact" rows.
//
// Facts live in STATE_DIR/profile.json as [{ text, at }]. Exchanges are
// batched: extraction fires once BATCH_SIZE exchanges pile up, or on the
// periodic sweep — never per-turn, so it costs almost nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const BATCH_SIZE = 4;
const SWEEP_MS = 5 * 60_000;
const MAX_FACTS = 120;   // oldest beyond this are dropped
const NOTE_FACTS = 20;   // most recent facts injected into the system prompt

const EXTRACTOR_PROMPT = `You extract durable personal facts from a voice-assistant conversation.
A durable fact is something worth remembering about the user WEEKS from now: who they are, people and projects in their life, preferences, routines, tools they use, decisions they made.
NOT durable: one-off requests ("open Spotify"), questions, moods, anything about the assistant itself, anything already in the known-facts list (or a trivial rephrasing of it).
Reply with ONLY a JSON array of short fact strings (third person, e.g. "Works with Alex on the Northlight brand"). No commentary. Return [] when nothing qualifies.`;

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function haikuOnce(prompt) {
  let out = '';
  const q = query({
    prompt,
    options: {
      model: 'haiku',
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      permissionMode: 'default',
      systemPrompt: EXTRACTOR_PROMPT,
    },
  });
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) if (b.type === 'text') out += b.text;
    }
    if (msg.type === 'result' && msg.is_error) throw new Error(String(msg.result || 'extractor error').slice(0, 200));
  }
  return out;
}

export function createProfile(stateDir) {
  const file = path.join(stateDir, 'profile.json');
  let facts = [];
  try { facts = JSON.parse(readFileSync(file, 'utf8')).filter((f) => f?.text); } catch { /* first run */ }

  let pending = [];
  let extracting = false;

  function save() {
    try { writeFileSync(file, JSON.stringify(facts, null, 2)); } catch { /* best-effort */ }
  }

  function add(texts) {
    const known = new Set(facts.map((f) => norm(f.text)));
    let added = 0;
    for (const t of texts) {
      const text = String(t || '').trim();
      if (text.length < 5 || text.length > 220) continue;
      if (known.has(norm(text))) continue;
      known.add(norm(text));
      facts.push({ text, at: Date.now() });
      added++;
    }
    if (facts.length > MAX_FACTS) facts = facts.slice(-MAX_FACTS);
    if (added) save();
    return added;
  }

  async function extract() {
    if (extracting || pending.length === 0) return 0;
    extracting = true;
    const batch = pending.splice(0);
    try {
      const convo = batch
        .map(({ user, assistant }) =>
          `User: ${user.slice(0, 500)}\nAssistant: ${String(assistant || '').slice(0, 300)}`)
        .join('\n---\n');
      const knownList = facts.slice(-NOTE_FACTS * 2).map((f) => `- ${f.text}`).join('\n') || '(none yet)';
      const raw = await haikuOnce(`Known facts:\n${knownList}\n\nConversation:\n${convo}\n\nNew durable facts as a JSON array:`);
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      if (start === -1 || end <= start) return 0;
      const arr = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(arr)) return 0;
      return add(arr.filter((x) => typeof x === 'string'));
    } catch (err) {
      console.log('[jarvis] fact extraction skipped:', String(err.message || err).slice(0, 120));
      return 0;
    } finally {
      extracting = false;
    }
  }

  const sweep = setInterval(() => { extract(); }, SWEEP_MS);
  sweep.unref?.();

  return {
    // Queue one exchange; extraction runs in batches in the background.
    observe(userText, assistantText) {
      if (!userText || userText.trim().length < 15) return;
      pending.push({ user: userText, assistant: assistantText });
      if (pending.length >= BATCH_SIZE) extract();
    },

    // Short system-prompt block with the freshest facts, or '' when empty.
    note() {
      if (facts.length === 0) return '';
      const lines = facts.slice(-NOTE_FACTS).map((f) => `- ${f.text}`).join('\n');
      return `\nWhat you know about the user from past conversations:\n${lines}`;
    },

    facts: () => facts.slice(),
    count: () => facts.length,
    flush: () => extract(),
    clear() { facts = []; pending = []; save(); },
  };
}
