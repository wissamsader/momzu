// Conversation memory — stores turns in a local SQLite database with
// full-text search via FTS5. Durable facts about the user live separately
// in profile.json (see facts.js), not in this table.

import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  content TEXT NOT NULL,
  conversation_id TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, content=memories, content_rowid=rowid
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

export class MemoryStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // INSERT OR REPLACE must fire the delete trigger for the replaced row,
    // or the FTS index keeps a ghost entry.
    this.db.pragma('recursive_triggers = ON');
    this.db.exec(SCHEMA);
    // The FTS index is external-content: rows written before the sync
    // triggers existed were never indexed, so recall silently found nothing.
    // Rebuild when the index has drifted from the source table. COUNT(*) on
    // the FTS table itself proxies to the content table, so drift must be
    // measured against the _docsize shadow table (one row per indexed doc).
    const ver = this.db.pragma('user_version', { simple: true });
    const rows = this.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
    let drift = true;
    try {
      const indexed = this.db.prepare('SELECT COUNT(*) AS c FROM memories_fts_docsize').get().c;
      drift = rows !== indexed;
    } catch { /* shadow table shape changed — rebuild to be safe */ }
    if (ver < 2 || drift) {
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      this.db.pragma('user_version = 2');
      console.log(`[jarvis] memory FTS index rebuilt (${rows} rows)`);
    }
  }

  // Drop conversation turns older than the retention window. Runs at
  // startup; the FTS triggers keep the index in sync with the deletes.
  prune(retentionDays = 90) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const n = this.db.prepare(
      `DELETE FROM memories WHERE timestamp < ? AND type = 'turn'`
    ).run(cutoff).changes;
    if (n > 500) this.db.exec('VACUUM');
    return n;
  }

  // ── write ──────────────────────────────────────

  remember(entry) {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO memories (id, timestamp, type, role, content, conversation_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      entry.id,
      entry.timestamp || Date.now(),
      entry.type,
      entry.role || null,
      entry.content,
      entry.conversation_id || null,
      entry.metadata ? JSON.stringify(entry.metadata) : null
    );
  }

  // ── recall ─────────────────────────────────────

  recall(query, { limit = 5, recentTurns = 10 } = {}) {
    const results = [];

    // 1. Recent context from current conversation
    const recent = this.db.prepare(
      `SELECT content, role, type FROM memories
       WHERE type = 'turn'
       ORDER BY timestamp DESC
       LIMIT ?`
    ).all(recentTurns);
    for (const r of recent.reverse()) {
      results.push({ source: 'recent', role: r.role, content: r.content });
    }

    // 2. Keyword match via FTS5 against past content
    if (query?.trim()) {
      const keywords = query.split(/\s+/).filter((w) => w.length > 2).join(' OR ');
      if (keywords) {
        try {
          const fts = this.db.prepare(
            `SELECT m.content, m.role, m.timestamp, m.type
             FROM memories_fts f
             JOIN memories m ON f.rowid = m.rowid
             WHERE memories_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          ).all(keywords, limit);
          for (const r of fts) {
            // don't duplicate recent entries
            if (!results.some((x) => x.content === r.content)) {
              results.push({ source: 'past', role: r.role, content: r.content, timestamp: r.timestamp });
            }
          }
        } catch {
          // FTS5 match can throw on malformed queries — degrade to LIKE search
          const like = this.db.prepare(
            `SELECT content, role, timestamp, type FROM memories
             WHERE content LIKE ? AND type = 'turn'
             ORDER BY timestamp DESC LIMIT ?`
          ).all(`%${query.split(/\s+/)[0] || query}%`, limit);
          for (const r of like) {
            if (!results.some((x) => x.content === r.content)) {
              results.push({ source: 'past', role: r.role, content: r.content, timestamp: r.timestamp });
            }
          }
        }
      }
    }

    return results;
  }

  // ── search ─────────────────────────────────────

  search(keyword, limit = 20) {
    if (!keyword?.trim()) return [];
    try {
      return this.db.prepare(
        `SELECT m.id, m.timestamp, m.type, m.role, m.content, m.conversation_id
         FROM memories_fts f
         JOIN memories m ON f.rowid = m.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      ).all(keyword, limit);
    } catch {
      return this.db.prepare(
        `SELECT id, timestamp, type, role, content, conversation_id
         FROM memories WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?`
      ).all(`%${keyword}%`, limit);
    }
  }

  // ── conversations ──────────────────────────────

  getConversation(id) {
    return this.db.prepare(
      `SELECT id, timestamp, type, role, content FROM memories
       WHERE conversation_id = ? ORDER BY timestamp`
    ).all(id);
  }

  listConversations(limit = 50) {
    return this.db.prepare(
      `SELECT conversation_id, MIN(timestamp) as started, COUNT(*) as turns
       FROM memories WHERE conversation_id IS NOT NULL
       GROUP BY conversation_id ORDER BY started DESC LIMIT ?`
    ).all(limit);
  }

  // ── stats ──────────────────────────────────────

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM memories').get();
    const convs = this.db.prepare(
      'SELECT COUNT(DISTINCT conversation_id) as c FROM memories WHERE conversation_id IS NOT NULL'
    ).get();
    return {
      totalMemories: total.c,
      totalConversations: convs.c,
    };
  }

  // ── maintenance ────────────────────────────────

  clear() {
    this.db.exec('DELETE FROM memories'); // FTS follows via the delete trigger
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    this.db.exec('VACUUM');
  }

  close() {
    this.db.close();
  }
}
