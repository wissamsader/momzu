// Provider registry. To add a provider: create a file exporting
// createProvider(config) → { id, label, reset(), async *chat(messages, opts) }
// and add it here + in config/jarvis.config.json.
import * as claudeAgent from './claude-agent.js';
import * as claudeCli from './claude-cli.js';
import * as anthropic from './anthropic.js';
import * as deepseek from './deepseek.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';

const factories = {
  'claude-agent': claudeAgent.createProvider,
  'claude-cli': claudeCli.createProvider,
  anthropic: anthropic.createProvider,
  deepseek: deepseek.createProvider,
  gemini: gemini.createProvider,
  ollama: ollama.createProvider,
};

export function loadProviders(config) {
  const providers = new Map();
  for (const [id, providerConfig] of Object.entries(config.providers || {})) {
    const factory = factories[id];
    if (factory) providers.set(id, factory(providerConfig));
  }
  return providers;
}
