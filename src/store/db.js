// IndexedDB "scholar-reader": one shared connection, thin promise helpers.
// Every store module (docs, outlines, quota) goes through here.
const DB_NAME = "scholar-reader";
const DB_VERSION = 2;

export const DOCS = "docs";
export const OUTLINES = "outlines";
export const CONSENTS = "consents";
export const QUOTA = "quota";

let connection = null;

function upgrade(db) {
  // Key paths follow SPEC.md: docs by document hash, outlines by cache key,
  // quota by providerId:pacificDate.
  if (!db.objectStoreNames.contains(DOCS)) {
    db.createObjectStore(DOCS, { keyPath: "hash" });
  }
  if (!db.objectStoreNames.contains(OUTLINES)) {
    const outlines = db.createObjectStore(OUTLINES, { keyPath: "key" });
    // Every cached outline for one document, across providers and prompt
    // versions, has to be findable together to evict it.
    outlines.createIndex("hash", "hash", { unique: false });
  }
  if (!db.objectStoreNames.contains(CONSENTS)) {
    // Version 2 adds this and nothing else: an absent grant is correctly read as
    // "ask", so there is no migration to write.
    const consents = db.createObjectStore(CONSENTS, { keyPath: "key" });
    // Same reason as outlines: every grant for one document has to be revocable
    // together (step 14).
    consents.createIndex("hash", "hash", { unique: false });
  }
  if (!db.objectStoreNames.contains(QUOTA)) {
    db.createObjectStore(QUOTA, { keyPath: "key" });
  }
}

export function openDb() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (cause) {
      reject(new Error(`IndexedDB is unavailable in this context (${cause.name}).`, { cause }));
      return;
    }
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      // The viewer and the background page each hold their own connection to one
      // database, so the next version bump would be blocked by whichever opened
      // first. Closing on `versionchange` lets the other context upgrade; the
      // next call reopens.
      request.result.onversionchange = () => {
        request.result.close();
        connection = null;
      };
      resolve(request.result);
    };
    request.onerror = () =>
      reject(new Error(`IndexedDB could not be opened: ${request.error?.message ?? "unknown error"}`));
    request.onblocked = () =>
      reject(new Error("IndexedDB is blocked by an older Scholar Reader tab. Close it and reload."));
  });
  // A failed open must not be remembered as the answer forever; retry next call.
  connection.catch(() => {
    connection = null;
  });
  return connection;
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function get(storeName, key) {
  const db = await openDb();
  return requestDone(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}

export async function put(storeName, value) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value);
  await txDone(tx);
  return value;
}

export async function del(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await txDone(tx);
}

export async function getAllByIndex(storeName, indexName, value) {
  const db = await openDb();
  const index = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName);
  return requestDone(index.getAll(value));
}

// Read-modify-write inside one transaction, so two tabs opening the same paper
// cannot clobber each other's record. `mutate` must be synchronous: an await on
// anything other than an IndexedDB request lets the transaction auto-commit.
// Returning undefined from `mutate` leaves the store untouched.
export async function update(storeName, key, mutate) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const existing = await requestDone(store.get(key));
  const next = mutate(existing);
  if (next !== undefined) store.put(next);
  await txDone(tx);
  return next;
}
