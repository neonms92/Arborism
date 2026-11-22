// Test records, kept in IndexedDB so results survive reloads and can be
// compared across sessions; JSON export/import moves them between machines.
// Falls back to memory when IndexedDB is unavailable (private window).

const DB = 'arborism-tests', STORE = 'runs';
let dbp = null;
const mem = new Map();

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { const s = rq.result.createObjectStore(STORE, { keyPath: 'run' }); s.createIndex('test', 'test'); s.createIndex('batch', 'batch'); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
const tx = async (mode, fn) => {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
};

export async function put(recs) {
  const list = Array.isArray(recs) ? recs : [recs];
  return tx('readwrite', (s) => { for (const r of list) { if (s) s.put(r); else mem.set(r.run, r); } });
}
export async function all() {
  const db = await open();
  if (!db) return [...mem.values()];
  return new Promise((resolve) => {
    const rq = db.transaction(STORE).objectStore(STORE).getAll();
    rq.onsuccess = () => resolve(rq.result); rq.onerror = () => resolve([]);
  });
}
export async function clear() { mem.clear(); return tx('readwrite', (s) => s && s.clear()); }

export async function exportJSON() {
  const recs = await all();
  const blob = new Blob([JSON.stringify({ format: 'arborism-tests-1', exported: new Date().toISOString(), records: recs })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `arborism-tests-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return recs.length;
}
export async function importJSON(file) {
  const o = JSON.parse(await file.text()), recs = Array.isArray(o) ? o : o.records || [];
  await put(recs.filter((r) => r && r.run && r.test));
  return recs.length;
}
