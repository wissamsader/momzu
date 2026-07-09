// Sensitive-info redaction — scrubs PII from text before it leaves the machine
// or is stored to disk. Each pattern is individually toggleable in config.

const PATTERNS = {
  email:   { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,  label: '[EMAIL]' },
  creditCard: { re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,       label: '[CC]' },
  apiKey:  { re: /\b(sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{30,}|sk-ant-[a-zA-Z0-9_-]+|sk-or-[a-zA-Z0-9_-]+)\b/g, label: '[API-KEY]' },
  phone:   { re: /\b(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, label: '[PHONE]' },
  ssn:     { re: /\b\d{3}-\d{2}-\d{4}\b/g,                              label: '[SSN]' },
  address: { re: /\b\d{2,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Way|Place|Pl)\b/gi, label: '[ADDRESS]' },
  ipv4:    { re: /\b(?<!\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b(?!\.\d)/g, label: '[IP]' },
};

// Compile the active set from config. Returns an array of { re, label }.
export function loadPatterns(config = {}) {
  if (config.enabled === false) return [];
  const active = [];
  const toggles = config.patterns || {};
  for (const [name, def] of Object.entries(PATTERNS)) {
    if (toggles[name] !== false) active.push(def);
  }
  return active;
}

// Apply all active patterns to text. Returns { redacted, count }.
export function redact(text, activePatterns) {
  if (!text || !activePatterns.length) return { redacted: text, count: 0 };
  let count = 0;
  let out = text;
  for (const { re, label } of activePatterns) {
    const matches = out.match(re);
    if (matches) {
      count += matches.length;
      out = out.replace(re, label);
    }
  }
  return { redacted: out, count };
}

export { PATTERNS };
