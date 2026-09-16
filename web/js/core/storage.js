// try/catch-wrapped storage helpers (private browsing / disabled storage
// should degrade gracefully, never throw into the caller).

function make(storage) {
  return {
    get(key, fallback) {
      try {
        const raw = storage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch (e) { /* ignore */ }
    },
    remove(key) {
      try {
        storage.removeItem(key);
      } catch (e) { /* ignore */ }
    },
  };
}

export const session = make(typeof sessionStorage !== 'undefined' ? sessionStorage : memoryStorage());
export const local = make(typeof localStorage !== 'undefined' ? localStorage : memoryStorage());

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}
