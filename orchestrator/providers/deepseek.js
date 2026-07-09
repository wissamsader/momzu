import { streamOpenAICompatTools } from './openai-compat.js';
import { keyStore, isRetryableKeyError } from '../keys.js';
import { apiToolDefs } from '../tools.js';

export function createProvider(config = {}) {
  return {
    id: 'deepseek',
    label: config.label || 'DeepSeek',
    reset() {},
    async *chat(messages, { systemPrompt, onEvent } = {}) {
      const store = keyStore();
      const keys = store.keysFor('deepseek');
      if (!keys.length) throw new Error('No DeepSeek API key — add one in Settings.');
      // Try each key; a rate-limited key throws on the first fetch (before
      // anything streamed) and falls through to the next one cleanly.
      for (let i = 0; i < keys.length; i++) {
        try {
          yield* streamOpenAICompatTools({
            baseUrl: 'https://api.deepseek.com',
            apiKey: keys[i],
            model: config.model || 'deepseek-chat',
            messages, systemPrompt,
            tools: apiToolDefs,
            onEvent,
          });
          return;
        } catch (err) {
          store.rotate('deepseek');
          if (i === keys.length - 1 || !isRetryableKeyError(err)) throw err;
        }
      }
    },
  };
}
