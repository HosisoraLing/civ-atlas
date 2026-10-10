/** Wiki storage: account-scoped offline cache. Server acknowledgements are tracked by native sync. */
export const wikiMode = () => import.meta.env?.VITE_WIKI_STORAGE === 'true';
const OWNER = 'civ-atlas:wiki-import-owner';
const PREFIXES = ['wenming-ditu:world:', 'wenming-ditu:meta:', 'wenming-ditu:thumb:', 'wenming-ditu:legacy:', 'wenming-ditu:assistant:', 'civ-atlas:ai-notes:'];
const IMPORT_KEYS = ['civ-atlas:ai-settings', 'civ-atlas:ai-secrets'];
let namespace = 'civ-atlas:wiki:guest:';
const fallback = new Map<string, string | null>();
function disk(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
const cache: Storage = {
  get length() { return keys().length; },
  key(i) { return keys()[i] ?? null; },
  getItem(k) {
    const key = namespace + k;
    if (fallback.has(key)) return fallback.get(key) ?? null;
    try { return disk()?.getItem(key) ?? null; } catch { return null; }
  },
  setItem(k, v) {
    const key = namespace + k;
    try {
      const s = disk();
      if (!s) throw new Error('no storage');
      s.setItem(key, v);
      fallback.delete(key);
    } catch { fallback.set(key, String(v)); }
  },
  removeItem(k) {
    const key = namespace + k;
    try { const s = disk(); if (!s) throw new Error('no storage'); s.removeItem(key); fallback.delete(key); } catch { fallback.set(key, null); }
  },
  clear() { for (const k of keys()) cache.removeItem(k); },
};
function keys(): string[] {
  const out = new Set<string>();
  try {
    const s = disk();
    if (s) for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(namespace)) out.add(k.slice(namespace.length));
    }
  } catch { /* Server saves still work without disk cache. */ }
  for (const [k, v] of fallback) if (k.startsWith(namespace)) {
    const name = k.slice(namespace.length);
    if (v === null) out.delete(name); else out.add(name);
  }
  return [...out];
}
export function dataStorage(): Storage | undefined { return wikiMode() ? cache : disk(); }
export function storageEventKey(key: string | null): string | null | undefined {
  if (!wikiMode() || key === null) return key;
  return key.startsWith(namespace) ? key.slice(namespace.length) : undefined;
}
/** Claim pre-Wiki saves once, leaving original bytes untouched until uploaded. */
export function prepareWikiStorage(user: string): number {
  namespace = `civ-atlas:wiki:${user}:`;
  const s = disk();
  if (!s) return 0;
  let owner: string | null;
  try { owner = s.getItem(OWNER); } catch { return 0; }
  if (owner && owner !== user) return 0;
  // Mark ownership before copying; a later account never receives this account's saves or keys.
  try { s.setItem(OWNER, user); } catch { return 0; }
  if (cache.getItem('wiki:legacy-import-complete')) return 0;
  const source = Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => !!k && (PREFIXES.some((p) => k.startsWith(p)) || IMPORT_KEYS.includes(k)));
  let count = 0;
  for (const k of source) {
    if (cache.getItem(k) !== null) continue;
    const raw = s.getItem(k);
    if (raw === null) continue;
    cache.setItem(k, raw);
    if (k.startsWith(PREFIXES[0])) count++;
  }
  cache.setItem('wiki:legacy-import-complete', 'true');
  return count;
}
/** Original source is removed only after the matching uploaded snapshot is acknowledged. */
export function acknowledgeMigration(id: string, save: string, assistant: unknown, notes: unknown): void {
  if (!wikiMode()) return;
  const s = disk();
  if (!s || s.getItem(OWNER) !== namespace.slice('civ-atlas:wiki:'.length, -1)) return;
  try {
    const key = PREFIXES[0] + id;
    const original = s.getItem(key);
    if (!original || cache.getItem(key) !== save) return;
    // Native parsing normalizes old save formats; their original source remains a rescue copy.
    if (original !== save) return;
    const originalNotes = s.getItem('civ-atlas:ai-notes:' + id);
    if (originalNotes && JSON.stringify(JSON.parse(originalNotes)) !== JSON.stringify(notes)) return;
    const chat = s.getItem('wenming-ditu:assistant:' + id);
    if (chat && JSON.stringify(JSON.parse(chat)) !== JSON.stringify(assistant)) return;
    for (const p of PREFIXES.slice(0, 3).concat(['wenming-ditu:assistant:', 'civ-atlas:ai-notes:'])) s.removeItem(p + id);
  } catch { /* Keep the rescue copy. */ }
}
