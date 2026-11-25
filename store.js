// Device storage (IndexedDB) and sync with the Apps Script web app.
// The device keeps: config (script URL + key), the last synced data,
// the outbox of unsent changes, and per-device settings.
// None of this ever leaves the device except to the script URL itself.

const DB_NAME = 'ruthines';
const STORE = 'kv';
const memory = new Map(); // fallback when IndexedDB is unavailable (private mode)
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) return reject(new Error('no IndexedDB'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

export async function load(key) {
  const db = await openDb();
  if (!db) return memory.get(key);
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(memory.get(key));
  });
}

export async function save(key, value) {
  memory.set(key, value);
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value === undefined) tx.objectStore(STORE).delete(key);
    else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/* ---------- talking to the script ---------- */

const TIMEOUT_MS = 30000;

async function call(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'follow', signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    const err = new Error(navigator.onLine === false ? 'Offline' : 'Could not reach the script');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    // Usually a Google sign-in page: the deployment isn't set to "Anyone".
    throw new Error('The script did not return data. Check the deployment is a Web app with access "Anyone".');
  }
  if (!body.ok) throw new Error(body.error || 'Script error');
  return body;
}

/** Read data. since = YYYY-MM-DD to reach further back than 90 days. */
export function fetchData(config, since) {
  return post(config, { ops: [], since });
}

/** Apply ops, then read data. */
export function pushOps(config, ops) {
  return post(config, { ops: ops.map(({ _id, ...op }) => op) });
}

/**
 * Every call is a POST with the key inside the body, never in the URL.
 * text/plain keeps it a "simple" request, so the browser sends no CORS preflight.
 */
function post(config, payload) {
  return call(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: config.key, ...payload }),
  });
}
