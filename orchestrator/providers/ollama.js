// Local models via Ollama — proof the adapter interface extends without
// touching the router. Install ollama + pull a model, then select it in the UI.
import { streamOpenAICompat } from './openai-compat.js';

export function createProvider(config = {}) {
  return {
    id: 'ollama',
    label: config.label || 'Ollama (local)',
    reset() {},
    async *chat(messages, { systemPrompt } = {}) {
      yield* streamOpenAICompat({
        baseUrl: `${config.baseUrl || 'http://127.0.0.1:11434'}/v1`,
        apiKey: null,
        model: config.model || 'llama3.2',
        messages,
        systemPrompt,
      });
    },
  };
}
