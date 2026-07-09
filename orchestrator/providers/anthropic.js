import { parseSSE } from './openai-compat.js';
import { keyStore, isRetryableKeyError } from '../keys.js';

export function createProvider(config = {}) {
  async function* once(apiKey, messages, systemPrompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model || 'claude-sonnet-5',
        max_tokens: 4096,
        stream: true,
        ...(config.effort ? { output_config: { effort: config.effort } } : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    yield* parseSSE(res.body, (d) => (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') ? d.delta.text : '');
  }

  return {
    id: 'anthropic',
    label: config.label || 'Claude (API)',
    reset() {},
    async *chat(messages, { systemPrompt } = {}) {
      const store = keyStore();
      const keys = store.keysFor('anthropic');
      if (!keys.length) throw new Error('No Anthropic API key — add one in Settings (or use "Claude (subscription)", which needs no key).');
      for (let i = 0; i < keys.length; i++) {
        try { yield* once(keys[i], messages, systemPrompt); return; }
        catch (err) {
          store.rotate('anthropic');
          if (i === keys.length - 1 || !isRetryableKeyError(err)) throw err;
        }
      }
    },
  };
}
