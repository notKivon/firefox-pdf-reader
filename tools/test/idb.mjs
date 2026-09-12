// An in-memory IndexedDB, enough of one for `src/store/*`. Node has none, and
// the consent gate is exactly the rule that must not be allowed to break
// silently — a missed grant means text reaching a model unasked, and a spurious
// one means the card never appears again.
//
// Request and transaction events fire on microtasks, as the real thing does, so
// `db.js`'s read-modify-write inside one transaction is exercised for real
// rather than flattened into something that would pass either way.
class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
  }
}

class FakeIndex {
  constructor(store, keyPath) {
    this.store = store;
    this.keyPath = keyPath;
  }

  getAll(value) {
    return this.store.tx._run(() =>
      [...this.store.data.values()].filter((record) => record[this.keyPath] === value),
    );
  }
}

class FakeStore {
  constructor(tx, spec) {
    this.tx = tx;
    this.spec = spec;
    this.data = spec.data;
  }

  get(key) {
    return this.tx._run(() => structuredClone(this.data.get(key)));
  }

  put(value) {
    return this.tx._run(() => {
      this.data.set(value[this.spec.keyPath], structuredClone(value));
      return value[this.spec.keyPath];
    });
  }

  delete(key) {
    return this.tx._run(() => void this.data.delete(key));
  }

  index(name) {
    return new FakeIndex(this, this.spec.indexes.get(name));
  }
}

class FakeTransaction {
  constructor(db, names) {
    this.db = db;
    this.names = names;
    this.pending = 0;
    this.finished = false;
    this.error = null;
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`store ${name} is not in this transaction`);
    return new FakeStore(this, this.db.stores.get(name));
  }

  _run(exec) {
    const request = new FakeRequest();
    this.pending++;
    queueMicrotask(() => {
      request.result = exec();
      this.pending--;
      request.onsuccess?.();
      // Auto-commit: if nothing new was queued by the continuation that this
      // success just woke, the transaction is over.
      queueMicrotask(() => {
        if (this.finished || this.pending > 0) return;
        this.finished = true;
        this.oncomplete?.();
      });
    });
    return request;
  }
}

class FakeDb {
  constructor(name, version, stores) {
    this.name = name;
    this.version = version;
    this.stores = stores;
    this.closed = false;
    this.objectStoreNames = { contains: (n) => stores.has(n) };
  }

  createObjectStore(name, { keyPath }) {
    this.stores.set(name, { keyPath, data: new Map(), indexes: new Map() });
    return {
      createIndex: (indexName, path) => this.stores.get(name).indexes.set(indexName, path),
    };
  }

  transaction(names, _mode) {
    if (this.closed) throw new Error("the connection is closed");
    return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
  }

  close() {
    this.closed = true;
  }
}

/** Installs `globalThis.indexedDB` and returns a handle for inspecting it. */
export function installIndexedDb() {
  const databases = new Map();

  globalThis.indexedDB = {
    open(name, version) {
      const request = new FakeRequest();
      const existing = databases.get(name) ?? { version: 0, stores: new Map() };
      databases.set(name, existing);
      queueMicrotask(() => {
        const db = new FakeDb(name, version, existing.stores);
        request.result = db;
        if (version > existing.version) {
          existing.version = version;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };

  return {
    records: (storeName) => [...(databases.get("scholar-reader")?.stores.get(storeName)?.data.values() ?? [])],
    version: () => databases.get("scholar-reader")?.version,
    reset: () => databases.clear(),
  };
}
