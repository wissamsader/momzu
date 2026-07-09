// Gemini with NATIVE function calling: each round is a non-streaming
// generateContent call (function calls arrive whole); text is yielded per
// round, tool results are fed back as functionResponse parts.
import { z } from 'zod';
import { keyStore, isRetryableKeyError } from '../keys.js';
import { apiToolDefs } from '../tools.js';

const MAX_ROUNDS = 6;

// Gemini's schema dialect: standard JSON schema minus meta keys.
function geminiSchema(schema) {
  const params = z.toJSONSchema(schema);
  const clean = (node) => {
    if (!node || typeof node !== 'object') return node;
    delete node.$schema;
    delete node.additionalProperties;
    for (const v of Object.values(node.properties || {})) clean(v);
    if (node.items) clean(node.items);
    return node;
  };
  const out = clean(params);
  // Empty parameter objects are rejected — omit them instead.
  return Object.keys(out.properties || {}).length ? out : undefined;
}

export function createProvider(config = {}) {
  const model = config.model || 'gemini-2.5-flash';
  const declarations = apiToolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    ...(geminiSchema(t.schema) ? { parameters: geminiSchema(t.schema) } : {}),
  }));

  async function generate(apiKey, contents, systemPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents,
        tools: [{ functionDeclarations: declarations }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts || [];
  }

  async function* toolLoop(apiKey, messages, systemPrompt, onEvent) {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const parts = await generate(apiKey, contents, systemPrompt);
      const text = parts.filter((p) => p.text).map((p) => p.text).join('');
      const calls = parts.filter((p) => p.functionCall);
      if (text) yield text;
      if (!calls.length) return;

      contents.push({ role: 'model', parts });
      const responses = [];
      for (const { functionCall } of calls) {
        const t = apiToolDefs.find((x) => x.name === functionCall.name);
        const args = functionCall.args || {};
        onEvent?.({
          kind: 'acting',
          tool: functionCall.name,
          input: String(args.command || args.script || args.app || args.text || JSON.stringify(args)).slice(0, 120),
        });
        const r = t
          ? await Promise.resolve(t.run(args)).catch((e) => ({ ok: false, output: String(e.message || e) }))
          : { ok: false, output: `unknown tool "${functionCall.name}"` };
        onEvent?.({ kind: 'result', ok: r.ok, output: String(r.output).slice(0, 400) });
        responses.push({
          functionResponse: {
            name: functionCall.name,
            response: { result: ((r.ok ? '' : 'ERROR: ') + r.output).slice(0, 4000) },
          },
        });
      }
      contents.push({ role: 'user', parts: responses });
    }
    yield ' I had to stop — that took too many steps.';
  }

  return {
    id: 'gemini',
    label: config.label || 'Gemini',
    reset() {},
    async *chat(messages, { systemPrompt, onEvent } = {}) {
      const store = keyStore();
      const keys = store.keysFor('gemini');
      if (!keys.length) throw new Error('No Gemini API key — add one in Settings.');
      // Rotate through your pool of Gemini keys on rate-limit/quota errors.
      for (let i = 0; i < keys.length; i++) {
        try { yield* toolLoop(keys[i], messages, systemPrompt, onEvent); return; }
        catch (err) {
          store.rotate('gemini');
          if (i === keys.length - 1 || !isRetryableKeyError(err)) throw err;
        }
      }
    },
  };
}
