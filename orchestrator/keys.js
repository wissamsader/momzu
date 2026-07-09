// API-key store. Keys are entered in the app and saved to a local,
// gitignored file. Multiple keys per provider are supported and rotated when
// one hits an auth/quota/rate error, so several Gemini keys act as a pool.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Env-var fallbacks so an existing .env keeps working.
const ENV_FALLBACK = {
  deepseek: () => [process.env.DEEPSEEK_API_KEY],
  gemini: () => [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY],
  anthropic: () => [process.env.ANTHROPIC_API_KEY],
};

class KeyStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'keys.json');
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = this._load();
    this.index = {}; // per-provider rotation cursor
  }

  _load() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); }
    catch { return {}; }
  }

  // All usable keys for a provider: stored keys first, else env fallback.
  keysFor(provider) {
    const stored = (this.data[provider] || []).filter(Boolean);
    if (stored.length) return stored;
    return (ENV_FALLBACK[provider]?.() || []).filter(Boolean);
  }

  // The current key (respects the rotation cursor).
  get(provider) {
    const keys = this.keysFor(provider);
    if (!keys.length) return null;
    return keys[(this.index[provider] || 0) % keys.length];
  }

  rotate(provider) {
    this.index[provider] = ((this.index[provider] || 0) + 1);
  }

  count(provider) { return this.keysFor(provider).length; }

  set(provider, keys) {
    this.data[provider] = (keys || []).map((k) => k.trim()).filter(Boolean);
    this.index[provider] = 0;
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // Count per provider — for showing status in the UI (never the keys).
  status() {
    const out = {};
    for (const p of ['deepseek', 'gemini', 'anthropic']) out[p] = this.count(p);
    return out;
  }
}

export function isRetryableKeyError(err) {
  return /\b(401|403|429)\b|quota|exhausted|rate.?limit|invalid.*key|unauthor/i.test(err?.message || '');
}

let store = null;
export function initKeyStore(stateDir) { store = new KeyStore(stateDir); return store; }
export function keyStore() { return store; }
