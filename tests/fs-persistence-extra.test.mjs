import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { __private__dont__use } from "@php-wasm/universal";
import {
  clearJournal,
  createJournalFlusher,
  dropLegacyOpcacheJournals,
  flushPendingOps,
  initFsPersistence,
  operationTouchesPathPrefix,
} from "../src/runtime/fs-persistence.js";

// Minimal async IndexedDB: one Map of stores per database name. Requests and
// transactions settle on a microtask, like the real API. `fail` makes the
// named step error out instead.
function createFakeIndexedDB({ fail = null, alwaysUpgrade = false } = {}) {
  const databases = new Map();
  const later = queueMicrotask;
  return {
    databases,
    open(name) {
      const req = {};
      later(() => {
        if (fail === "open") {
          req.error = new Error("open blocked");
          req.onerror();
          return;
        }
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          closed: false,
          objectStoreNames: { contains: (store) => stores.has(store) },
          createObjectStore: (store) => stores.set(store, []),
          close() {
            db.closed = true;
          },
          transaction(store) {
            const rows = stores.get(store);
            const tx = {
              objectStore: () => ({
                getAll() {
                  const getReq = {};
                  later(() => {
                    if (fail === "getAll") {
                      getReq.error = new Error("read failed");
                      getReq.onerror();
                      return;
                    }
                    getReq.result = fail === "noResult" ? undefined : [...rows];
                    getReq.onsuccess();
                  });
                  return getReq;
                },
                clear: () => {
                  rows.length = 0;
                },
                add: (row) => rows.push(row),
              }),
            };
            later(() => {
              if (fail === "transaction") {
                tx.error = new Error("transaction aborted");
                tx.onerror?.();
              } else {
                tx.oncomplete?.();
              }
            });
            return tx;
          },
        };
        req.result = db;
        if (isNew || alwaysUpgrade)
          req.onupgradeneeded({ target: { result: db } });
        req.onsuccess();
      });
      return req;
    },
  };
}

const originalIndexedDB = globalThis.indexedDB;
afterEach(() => {
  if (originalIndexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = originalIndexedDB;
});

function installIndexedDB(options) {
  const idb = createFakeIndexedDB(options);
  globalThis.indexedDB = idb;
  return idb;
}

// A raw PHP runtime with an in-memory file map and an Emscripten-like FS
// object that @php-wasm/fs-journal wraps to observe writes.
function createRawPhp(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  const FS = {
    write() {},
    unlink() {},
    mkdir() {},
  };
  return {
    files,
    calls,
    FS,
    [__private__dont__use]: { FS },
    addEventListener() {},
    removeEventListener() {},
    readFileAsBuffer(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    writeFile(path, data) {
      calls.push(["writeFile", path]);
      files.set(path, data);
    },
    mkdir(path) {
      calls.push(["mkdir", path]);
    },
    unlink(path) {
      calls.push(["unlink", path]);
      if (!files.delete(path)) throw new Error(`ENOENT ${path}`);
    },
    rmdir(path) {
      calls.push(["rmdir", path]);
    },
    mv(from, to) {
      calls.push(["mv", from, to]);
    },
  };
}

const opsIn = (idb, scope) =>
  idb.databases.get(`facturascripts-fs-journal:${scope}`).get("ops");

describe("initFsPersistence", () => {
  it("journals /persist writes and replays them on the next boot", async () => {
    const idb = installIndexedDB();
    const php = createRawPhp({
      "/persist/mutable/config/state.json": new Uint8Array([1, 2]),
    });
    const persistence = await initFsPersistence(php, "scope-a");

    // Writes through the wrapped FS are journaled; SQLite temp files are not.
    php.FS.write({ path: "/persist/mutable/config/state.json" });
    php.FS.write({ path: "/persist/mutable/db/facturascripts.sqlite-journal" });
    php.FS.write({ path: "/persist/mutable/db/facturascripts.sqlite-wal" });

    const result = await persistence.flushNow();
    assert.equal(result.ok, true);
    assert.equal(result.flushedOps, 1);
    assert.equal(result.hydratedBytes, 2);

    const stored = opsIn(idb, "scope-a");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].path, "/persist/mutable/config/state.json");

    const fresh = createRawPhp();
    await initFsPersistence(fresh, "scope-a");
    assert.deepEqual(
      [...fresh.files.get("/persist/mutable/config/state.json")],
      [1, 2],
    );
  });

  it("keeps replaying after an op that cannot be applied", async () => {
    const idb = installIndexedDB();
    await initFsPersistence(createRawPhp(), "scope-b");
    opsIn(idb, "scope-b").push(
      { operation: "DELETE", path: "/persist/gone.txt", nodeType: "file" },
      { operation: "CREATE", path: "/persist/dir", nodeType: "directory" },
      {
        operation: "WRITE",
        path: "/persist/kept.txt",
        nodeType: "file",
        data: new Uint8Array([7]),
      },
    );

    const php = createRawPhp();
    await initFsPersistence(php, "scope-b");
    assert.deepEqual([...php.files.get("/persist/kept.txt")], [7]);
    // The batch failed on the dangling unlink, then each op was retried alone.
    assert.deepEqual(
      php.calls.map(([name]) => name),
      ["unlink", "unlink", "mkdir", "writeFile"],
    );
  });

  it("tolerates a store without results and an existing object store", async () => {
    installIndexedDB({ fail: "noResult", alwaysUpgrade: true });
    const php = createRawPhp();
    await initFsPersistence(php, "scope-c");
    await initFsPersistence(php, "scope-c");
    assert.deepEqual(php.calls, []);
  });

  it("rejects when the journal cannot be read", async () => {
    installIndexedDB({ fail: "getAll" });
    await assert.rejects(initFsPersistence(createRawPhp(), "scope-d"), {
      message: "read failed",
    });
  });

  it("flushes only the requested path prefix", async () => {
    const idb = installIndexedDB();
    const php = createRawPhp({
      "/persist/mutable/a.json": new Uint8Array([1]),
      "/persist/other/b.json": new Uint8Array([2]),
    });
    const persistence = await initFsPersistence(php, "scope-e");
    php.FS.write({ path: "/persist/mutable/a.json" });
    php.FS.write({ path: "/persist/other/b.json" });

    const result = await persistence.flushNow({
      pathPrefix: "/persist/mutable/",
    });
    assert.equal(result.flushedOps, 1);
    assert.deepEqual(
      opsIn(idb, "scope-e").map((op) => op.path),
      ["/persist/mutable/a.json"],
    );

    await persistence.flushNow();
    assert.deepEqual(
      opsIn(idb, "scope-e").map((op) => op.path),
      ["/persist/mutable/a.json", "/persist/other/b.json"],
    );
  });
});

describe("clearJournal", () => {
  it("empties the scope's journal and closes the database", async () => {
    const idb = installIndexedDB();
    await initFsPersistence(createRawPhp(), "scope-f");
    opsIn(idb, "scope-f").push({ operation: "CREATE", path: "/persist/x" });
    await clearJournal("scope-f");
    assert.deepEqual(opsIn(idb, "scope-f"), []);
  });

  it("rejects when the database cannot be opened", async () => {
    installIndexedDB({ fail: "open" });
    await assert.rejects(clearJournal("scope-g"), { message: "open blocked" });
  });

  it("rejects when the clear transaction fails", async () => {
    installIndexedDB({ fail: "transaction" });
    await assert.rejects(clearJournal("scope-h"), {
      message: "transaction aborted",
    });
  });
});

describe("createJournalFlusher", () => {
  const openStore = async (options) => {
    const idb = createFakeIndexedDB(options);
    const req = idb.open("db");
    return new Promise((resolve) => {
      req.onupgradeneeded = (e) => e.target.result.createObjectStore("ops");
      req.onsuccess = () => resolve({ db: req.result, idb });
    });
  };

  it("debounces scheduled flushes into one timer that flushNow cancels", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { db, idb } = await openStore();
    const pendingOps = [
      { operation: "WRITE", path: "/persist/a", nodeType: "file" },
    ];
    const flusher = createJournalFlusher(
      { readFileAsBuffer: () => new Uint8Array([1]) },
      db,
      pendingOps,
    );
    flusher.scheduleFlush();
    flusher.scheduleFlush();
    const result = await flusher.flushNow();
    assert.equal(result.flushedOps, 1);
    t.mock.timers.tick(1500);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idb.databases.get("db").get("ops").length, 1);
  });

  it("stops and reports when a flush fails", async () => {
    const { db } = await openStore({ fail: "transaction" });
    const pendingOps = [
      { operation: "WRITE", path: "/persist/a", nodeType: "file" },
    ];
    const flusher = createJournalFlusher(
      { readFileAsBuffer: () => new Uint8Array([1]) },
      db,
      pendingOps,
    );
    const result = await flusher.flushNow();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "flush-failed");
    assert.equal(result.error.message, "transaction aborted");
    assert.equal(pendingOps.length, 1, "the ops stay pending for a retry");
  });

  it("estimates sizes from the Emscripten FS when a limit is set", async () => {
    const { db } = await openStore();
    const pendingOps = [
      { operation: "WRITE", path: "/persist/big", nodeType: "file" },
    ];
    const flusher = createJournalFlusher(
      {
        [__private__dont__use]: { FS: { stat: () => ({ size: 64 }) } },
        readFileAsBuffer: () => new Uint8Array(64),
      },
      db,
      pendingOps,
    );
    const result = await flusher.flushNow({ maxBytes: 10 });
    assert.deepEqual(result, {
      ok: false,
      reason: "size-limit",
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 64,
    });
  });
});

describe("flushPendingOps", () => {
  const run = (rawPhp, pendingOps, options = {}) =>
    flushPendingOps({
      rawPhp,
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async () => {},
      ...options,
    });

  it("does nothing when no op is selected", async () => {
    const pendingOps = [{ operation: "WRITE", path: "/persist/a" }];
    assert.deepEqual(await run({}, pendingOps, { shouldFlush: () => false }), {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
    assert.equal(pendingOps.length, 1);
  });

  it("falls back to php.stat, then to zero, for size estimates", async () => {
    const write = (path) => ({ operation: "WRITE", path, nodeType: "file" });
    const viaStat = await run(
      { stat: () => ({ size: 5 }), readFileAsBuffer: () => new Uint8Array(5) },
      [
        write("/persist/a"),
        { operation: "CREATE", path: "/persist/d", nodeType: "directory" },
      ],
      { maxBytes: 100 },
    );
    assert.equal(viaStat.estimatedBytes, 5);

    const unknown = await run(
      { readFileAsBuffer: () => new Uint8Array(1) },
      [write("/persist/b")],
      { maxBytes: 100 },
    );
    assert.equal(unknown.estimatedBytes, 0);

    const nonNumeric = await run(
      { readFileAsBuffer: () => new Uint8Array(1) },
      [write("/persist/c")],
      { maxBytes: 100, getFileSize: () => "n/a" },
    );
    assert.equal(nonNumeric.estimatedBytes, 0);
  });

  it("counts hydrated bytes only for WRITE ops that could be read", async () => {
    let persisted;
    const result = await run(
      {
        readFileAsBuffer(path) {
          if (path === "/persist/vanished") throw new Error("ENOENT");
          return new Uint8Array(4);
        },
      },
      [
        { operation: "WRITE", path: "/persist/kept", nodeType: "file" },
        { operation: "WRITE", path: "/persist/vanished", nodeType: "file" },
        { operation: "CREATE", path: "/persist/dir", nodeType: "directory" },
      ],
      {
        replacePersistedOps: async (ops) => {
          persisted = ops;
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.flushedOps, 3);
    assert.equal(result.hydratedBytes, 4);
    assert.equal(persisted.length, 3);
  });
});

describe("operationTouchesPathPrefix", () => {
  it("matches everything without a prefix and handles missing fields", () => {
    assert.equal(operationTouchesPathPrefix({ path: "/x" }, null), true);
    assert.equal(operationTouchesPathPrefix(undefined, "/persist"), false);
    assert.equal(
      operationTouchesPathPrefix({ operation: "RENAME", path: "/tmp/a" }, "/p"),
      false,
    );
    assert.equal(
      operationTouchesPathPrefix({ path: "/persist" }, "/persist/"),
      true,
    );
    assert.equal(
      operationTouchesPathPrefix({ path: "/persisted" }, "/persist"),
      false,
    );
  });
});

describe("dropLegacyOpcacheJournals", () => {
  it("keeps going when deletion throws or enumeration fails", async () => {
    const deleted = [];
    const idb = {
      deleteDatabase(name) {
        deleted.push(name);
        throw new Error("blocked");
      },
      databases: async () => {
        throw new Error("not allowed");
      },
    };
    assert.deepEqual(await dropLegacyOpcacheJournals("8.4", "", idb), [
      "facturascripts-opcache:8.4",
      "facturascripts-opcache:8.4:default",
    ]);
    assert.equal(deleted.length, 2);
  });

  it("ignores empty and nameless enumeration entries", async () => {
    const idb = {
      deleteDatabase() {},
      databases: async () => [null, {}],
    };
    assert.deepEqual(await dropLegacyOpcacheJournals("8.3", undefined, idb), [
      "facturascripts-opcache:8.3",
      "facturascripts-opcache:8.3:default",
    ]);
    const noList = { deleteDatabase() {}, databases: async () => null };
    assert.equal(
      (await dropLegacyOpcacheJournals("8.3", "x", noList)).length,
      2,
    );
  });

  it("uses the global indexedDB by default", async () => {
    const deleted = [];
    globalThis.indexedDB = { deleteDatabase: (name) => deleted.push(name) };
    await dropLegacyOpcacheJournals("8.2");
    assert.deepEqual(deleted, [
      "facturascripts-opcache:8.2",
      "facturascripts-opcache:8.2:default",
    ]);
  });
});
