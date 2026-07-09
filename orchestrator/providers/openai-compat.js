// Shared streaming client for OpenAI-compatible chat APIs (DeepSeek, Ollama…),
// with an optional NATIVE function-calling loop: the model calls real tools
// (open_app, music, calendar…) instead of emitting fragile ACTION-JSON prose.
import { z } from 'zod';

export async function* streamOpenAICompat({ baseUrl, apiKey, model, messages, systemPrompt }) {
  const body = {
    model,
    stream: true,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages,
    ],
  };
  const res = await postChat(baseUrl, apiKey, body);
  yield* parseSSE(res.body, (data) => data.choices?.[0]?.delta?.content || '');
}

// Native tool loop. `tools` are toolkit defs ({ name, description, schema,
// run }); text tokens stream out as they arrive, tool calls are executed
// with results fed back, up to maxRounds rounds.
export async function* streamOpenAICompatTools({
  baseUrl, apiKey, model, messages, systemPrompt, tools, onEvent, maxRounds = 6,
}) {
  const toolSpecs = tools.map((t) => {
    const params = z.toJSONSchema(t.schema);
    delete params.$schema;
    return { type: 'function', function: { name: t.name, description: t.description, parameters: params } };
  });
  const convo = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages,
  ];

  for (let round = 0; round < maxRounds; round++) {
    const res = await postChat(baseUrl, apiKey, { model, stream: true, messages: convo, tools: toolSpecs });
    const calls = []; // accumulated by stream index
    let text = '';
    for await (const data of sseJson(res.body)) {
      const delta = data.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; yield delta.content; }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: tc.id || `call_${i}`, name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    }
    const pending = calls.filter(Boolean);
    if (!pending.length) return; // plain answer — done

    convo.push({
      role: 'assistant',
      content: text || null,
      tool_calls: pending.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const c of pending) {
      let args = {};
      try { args = JSON.parse(c.args || '{}'); } catch { /* run with empty args */ }
      const t = tools.find((x) => x.name === c.name);
      onEvent?.({ kind: 'acting', tool: c.name, input: summarizeArgs(args) });
      const r = t
        ? await Promise.resolve(t.run(args)).catch((e) => ({ ok: false, output: String(e.message || e) }))
        : { ok: false, output: `unknown tool "${c.name}"` };
      onEvent?.({ kind: 'result', ok: r.ok, output: String(r.output).slice(0, 400) });
      convo.push({ role: 'tool', tool_call_id: c.id, content: ((r.ok ? '' : 'ERROR: ') + r.output).slice(0, 4000) });
    }
  }
  yield ' I had to stop — that took too many steps.';
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return String(args ?? '');
  const v = args.command || args.script || args.app || args.path || args.text
    || Object.values(args).find((x) => typeof x === 'string') || JSON.stringify(args);
  return String(v).slice(0, 120);
}

async function postChat(baseUrl, apiKey, body) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res;
}

// Parse an SSE byte stream into JSON events.
export async function* sseJson(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* skip malformed events */ }
    }
  }
}

// Parse an SSE byte stream, mapping each JSON `data:` event to text via pick().
export async function* parseSSE(stream, pick) {
  for await (const data of sseJson(stream)) {
    try {
      const text = pick(data);
      if (text) yield text;
    } catch { /* skip malformed events */ }
  }
}
