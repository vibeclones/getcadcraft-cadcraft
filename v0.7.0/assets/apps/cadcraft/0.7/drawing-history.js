/* SPDX-License-Identifier: Apache-2.0 */
/**
 * drawing-history.js — the versions of a drawing (0.7 D7.31): copies kept on this computer each time Studio saves it, and the
 * versions the cloud holds for a drawing opened from it. DOM-free; history-ui.js is the panel.
 *
 *   const local = new LocalHistory({ factory })       copies on this computer (IndexedDB "cadcraft-history"; memory in Node)
 *   await local.snapshot({ key, name, bytes, format, note })   → the record, or null when it equals the newest copy
 *   await local.list(key)  → [{ id, key, name, at, size, sha256, format, note }]  newest first (no bytes)
 *   await local.get(id)    → { …, bytes }          await local.remove(id)       await local.usage() → { files, bytes }
 *   const cloud = new CloudHistory(cadcraftDesktop.cloud)     the same drawing's versions on the server (sign-in is the shell's)
 *   await cloud.versions(uuid)  → [{ no, size, sha256, at, by, note, source }]  newest first
 *   await cloud.open(uuid, no)  → { bytes, version, sha256 }   (the SHA-256 the server sends is checked)
 *
 * What is kept (Studio only; the page decides): at most 25 copies per drawing and 400 MB in all, the oldest go first; a save
 * that changes nothing keeps nothing. The key is the file's path (Studio) so another drawing with the same name has its own
 * history. Copies stay on this computer: nothing here uploads anything, and the cloud half only reads.
 */

export const PER_DRAWING = 25;
export const TOTAL_BYTES = 400 * 1024 * 1024;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes) {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) return null;
  return hex(await s.digest('SHA-256', bytes));
}

function memoryStore() {
  const meta = new Map(), data = new Map();
  let n = 0;
  return {
    kind: 'memory',
    async put(rec, bytes) { rec.id = ++n; meta.set(rec.id, { ...rec }); data.set(rec.id, bytes); return rec.id; },
    async metas() { return [...meta.values()].map((x) => ({ ...x })); },
    async meta(id) { const m = meta.get(id); return m ? { ...m } : null; },
    async bytes(id) { return data.get(id) || null; },
    async del(ids) { for (const id of ids) { meta.delete(id); data.delete(id); } },
  };
}

function idbStore(factory) {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = factory.open('cadcraft-history', 1);
    r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true }); db.createObjectStore('data'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  }));
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    kind: 'indexeddb',
    async put(rec, bytes) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['meta', 'data'], 'readwrite');
        let id;
        const r = t.objectStore('meta').add(rec);
        r.onsuccess = () => { id = r.result; t.objectStore('data').put(bytes, id); };
        t.oncomplete = () => resolve(id);
        t.onerror = t.onabort = () => reject(t.error);
      });
    },
    async metas() { const db = await open(); return req(db.transaction('meta').objectStore('meta').getAll()); },
    async meta(id) { const db = await open(); return (await req(db.transaction('meta').objectStore('meta').get(id))) || null; },
    async bytes(id) { const db = await open(); return (await req(db.transaction('data').objectStore('data').get(id))) || null; },
    async del(ids) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['meta', 'data'], 'readwrite');
        for (const id of ids) { t.objectStore('meta').delete(id); t.objectStore('data').delete(id); }
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error);
      });
    },
  };
}

export class LocalHistory {
  constructor({ factory = globalThis.indexedDB, perDrawing = PER_DRAWING, totalBytes = TOTAL_BYTES } = {}) {
    this.store = factory ? idbStore(factory) : memoryStore();
    this.perDrawing = perDrawing;
    this.totalBytes = totalBytes;
  }
  get kind() { return this.store.kind; }

  async snapshot({ key, name, bytes, format = '', note = '', at = Date.now() }) {
    if (!key || !(bytes instanceof Uint8Array) || !bytes.length) return null;
    const sha256 = await sha256Hex(bytes);
    const mine = (await this.list(key));
    if (mine[0] && sha256 && mine[0].sha256 === sha256) return null;   // nothing changed since the newest copy
    const rec = { key: String(key), name: String(name || ''), at, size: bytes.length, sha256, format: String(format || ''), note: String(note || '') };
    rec.id = await this.store.put(rec, bytes);
    await this.prune(key);
    return rec;
  }

  async list(key) {
    return (await this.store.metas()).filter((m) => m.key === String(key)).sort((a, b) => b.at - a.at || b.id - a.id)
      .map(({ id, key: k, name, at, size, sha256, format, note }) => ({ id, key: k, name, at, size, sha256, format, note }));
  }
  async get(id) {
    const m = await this.store.meta(id), bytes = m && await this.store.bytes(id);
    return m && bytes ? { ...m, bytes } : null;
  }
  async remove(id) { await this.store.del([id]); }
  async usage() { const all = await this.store.metas(); return { files: all.length, bytes: all.reduce((n, m) => n + m.size, 0) }; }

  /** Oldest copies go: more than `perDrawing` of one drawing, then, over `totalBytes`, the oldest of any (never the newest of a drawing). */
  async prune(key) {
    const all = (await this.store.metas()).sort((a, b) => b.at - a.at || b.id - a.id);
    const drop = new Set();
    const mine = all.filter((m) => m.key === String(key));
    for (const m of mine.slice(this.perDrawing)) drop.add(m.id);
    let total = all.filter((m) => !drop.has(m.id)).reduce((n, m) => n + m.size, 0);
    const newest = new Set();
    const seen = new Set();
    for (const m of all) if (!seen.has(m.key)) { seen.add(m.key); newest.add(m.id); }
    for (const m of [...all].reverse()) {   // oldest first
      if (total <= this.totalBytes) break;
      if (drop.has(m.id) || newest.has(m.id)) continue;
      drop.add(m.id); total -= m.size;
    }
    if (drop.size) await this.store.del([...drop]);
    return drop.size;
  }
}

export class CloudError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sync API's reads (versions, open) through the shell's `cloud.request` (it adds the bearer; the page never sees a token). */
export class CloudHistory {
  constructor(cloud) { this.request = cloud && typeof cloud.request === 'function' ? cloud.request : null; }
  get available() { return !!this.request; }
  async #call(path) {
    if (!this.request) throw new CloudError('unavailable');
    let res;
    try { res = await this.request({ method: 'GET', path }); } catch (e) { throw new CloudError(e && e.code === 'not_allowed' ? 'not_allowed' : 'offline'); }
    if (res.status >= 200 && res.status < 300) return res;
    let json = null;
    try { json = res.json(); } catch { json = null; }
    throw new CloudError(String((json && (json.code || json.error)) || (res.status === 429 ? 'throttled' : res.status >= 500 ? 'server' : 'error')), res.status);
  }
  async versions(drawing) {
    if (!UUID_RE.test(String(drawing || ''))) throw new CloudError('invalid');
    const r = await this.#call('/api/v1/sync/versions?drawing=' + encodeURIComponent(drawing));
    const d = r.json().data || {};
    return (Array.isArray(d.versions) ? d.versions : []).map((v) => ({
      no: Number(v.no), size: Number(v.size_bytes) || 0, sha256: v.sha256 || null, at: Date.parse(v.saved_at) || null,
      by: v.saved_by ? String(v.saved_by) : null, note: v.note ? String(v.note) : '', source: v.source ? String(v.source) : null,
    })).filter((v) => Number.isFinite(v.no)).sort((a, b) => b.no - a.no);
  }
  async open(drawing, version) {
    if (!UUID_RE.test(String(drawing || '')) || !Number.isInteger(version)) throw new CloudError('invalid');
    const r = await this.#call('/api/v1/sync/open?drawing=' + encodeURIComponent(drawing) + '&version=' + version);
    const h = r.headers || {};
    const want = h['x-cadcraft-sha256'] || h['X-CadCraft-Sha256'] || null;
    const bytes = r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body);
    const got = await sha256Hex(bytes);
    if (want && got && want.toLowerCase() !== got) throw new CloudError('checksum');
    return { bytes, version, sha256: got };
  }
}
