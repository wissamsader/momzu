// Intent classifier — fast keyword/pattern-based classification before the
// expensive LLM call. Routes to direct actions, system queries, or chat.
// Config-driven; no model dependency.

// Default rules — overridable in config.
const DEFAULT_RULES = {
  open_app: {
    priority: 10,
    patterns: ['^open\\s+([\\w\\s]+)$'],
  },
  action: {
    priority: 9,
    patterns: ['^(close|launch|start|stop|run|show|find|play|pause|send|create|delete|set|turn|navigate|go to|browse|search for|click|type|scroll)'],
  },
  search: {
    priority: 8,
    patterns: ['^(search|google|look up|find information about|what is|who is|how to|weather|news)'],
  },
  dictation: {
    priority: 7,
    patterns: ['^(start dictation|stop dictation|type this|write this|dictate)'],
  },
  system_query: {
    priority: 5,
    patterns: ['^(what time|what day|what date|how are you|status|uptime|cpu|memory|battery|system|hostname)'],
  },
  chat: {
    priority: 0,
    patterns: ['.'], // catch-all
  },
};

// Compile rules from config (or use defaults). Returns sorted rule set.
export function loadRules(config = {}) {
  const rules = [];
  const defs = (config.rules && Object.keys(config.rules).length > 0)
    ? config.rules
    : DEFAULT_RULES;
  for (const [intent, def] of Object.entries(defs)) {
    const patterns = (def.patterns || []).map((p) => new RegExp(p, 'i'));
    rules.push({ intent, priority: def.priority || 0, patterns });
  }
  rules.sort((a, b) => b.priority - a.priority);
  return rules;
}

// Classify text against the rule set. Returns { intent, confidence, params }.
export function classify(text, rules) {
  if (!text?.trim()) return { intent: 'chat', confidence: 0, params: {} };

  for (const rule of rules) {
    for (const re of rule.patterns) {
      const m = text.match(re);
      if (m) {
        const params = extractParams(rule.intent, text, m);
        return {
          intent: rule.intent,
          confidence: rule.priority / 10,
          params,
        };
      }
    }
  }

  return { intent: 'chat', confidence: 0, params: {} };
}

// Pull out structured params based on intent type.
function extractParams(intent, text, match) {
  switch (intent) {
    case 'open_app':
      return { app: (match[1] || '').trim() };
    case 'search':
      return { query: text.replace(/^(search for?|google|look up|find information about)\s*/i, '').trim() };
    case 'action':
      return { command: text.trim() };
    default:
      return {};
  }
}

// Simple energy-based VAD. Returns true if the PCM buffer contains speech.
// pcm: Float32Array of 16-bit PCM samples. threshold: RMS cutoff (default 0.01).
export function hasSpeech(pcm, threshold = 0.01) {
  if (!pcm || pcm.length === 0) return false;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length);
  return rms > threshold;
}
