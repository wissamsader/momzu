// Thin read-only query helpers for the memory-viewer UI panel.
// Keeps MemoryStore itself focused on storage/recall.

export function listConversations(store, limit = 20) {
  return store.listConversations(limit);
}

export function getConversation(store, id) {
  return {
    id,
    turns: store.getConversation(id),
  };
}

export function searchMemories(store, query, limit = 20) {
  return store.search(query, limit);
}

export function getMemoryStats(store) {
  return store.getStats();
}
