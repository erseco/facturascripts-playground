import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FS_MYFILES_PATH,
  PLAYGROUND_DB_PATH,
} from "../src/runtime/bootstrap-paths.js";
import {
  createSnapshotManager,
  isEmscriptenNetworkError,
  isFatalWasmError,
  isSafeToReplay,
} from "../src/runtime/crash-recovery.js";

const PERSIST = "/persist/mutable";

// In-memory filesystem with the subset of the PHP API the snapshot manager
// uses. `unreadable` paths throw on read, `unlistable` dirs throw on list.
function createFs(
  entries = {},
  { unreadable = [], unlistable = [], failWrites = [] } = {},
) {
  const files = new Map(
    Object.entries(entries).map(([path, bytes]) => [
      path,
      Uint8Array.from(bytes),
    ]),
  );
  const dirs = new Set();
  for (const path of files.keys()) {
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir; ) {
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  const mkdirs = [];
  return {
    files,
    mkdirs,
    fileExists: (path) => files.has(path) || dirs.has(path),
    isDir: (path) => dirs.has(path),
    listFiles(path) {
      if (unlistable.includes(path)) throw new Error(`EACCES ${path}`);
      const children = new Set();
      for (const entry of [...files.keys(), ...dirs]) {
        if (!entry.startsWith(`${path}/`)) continue;
        children.add(`${path}/${entry.slice(path.length + 1).split("/")[0]}`);
      }
      return [...children].sort();
    },
    readFileAsBuffer(path) {
      if (unreadable.includes(path) || !files.has(path)) {
        throw new Error(`ENOENT ${path}`);
      }
      return files.get(path);
    },
    mkdirTree: (path) => mkdirs.push(path),
    writeFile(path, data) {
      if (failWrites.includes(path)) throw new Error(`EROFS ${path}`);
      files.set(path, Uint8Array.from(data));
    },
  };
}

function createManager(maxCrashCheckpointBytes = 1024) {
  const messages = [];
  const manager = createSnapshotManager({
    postShell: (message) => messages.push(message),
    maxCrashCheckpointBytes,
  });
  const details = (kind) =>
    messages.filter((m) => m.kind === kind).map((m) => m.detail);
  return { manager, messages, details };
}

const bytes = (fs, path) => [...fs.files.get(path)];

describe("crash classification", () => {
  it("treats errno 23 (EHOSTUNREACH) as a network crash", () => {
    assert.equal(isEmscriptenNetworkError({ errno: 23 }), true);
    assert.equal(isEmscriptenNetworkError({ errno: 2 }), false);
    assert.equal(isEmscriptenNetworkError(null), false);
  });

  it("recognises fatal WASM errors by type, errno or message", () => {
    assert.equal(isFatalWasmError(null), false);
    assert.equal(isFatalWasmError({ errno: 23 }), true);
    assert.equal(isFatalWasmError(new WebAssembly.RuntimeError("x")), true);
    for (const message of [
      "memory access out of bounds",
      "unreachable executed",
      "RuntimeError: boom",
      "Failed opening required 'vendor/autoload.php'",
    ]) {
      assert.equal(isFatalWasmError(new Error(message)), true, message);
    }
    assert.equal(isFatalWasmError("unreachable"), true, "plain strings too");
    assert.equal(isFatalWasmError(new Error("404 Not Found")), false);
  });

  it("replays only GET and HEAD requests", () => {
    assert.equal(isSafeToReplay(undefined), true, "defaults to GET");
    assert.equal(isSafeToReplay({ method: "head" }), true);
    assert.equal(isSafeToReplay({ method: "POST" }), false);
    assert.equal(isSafeToReplay({ method: "DELETE" }), false);
  });
});

describe("snapshot manager journal checkpoint", () => {
  it("reports a non-size checkpoint failure without a size detail", async () => {
    const { manager, details } = createManager();
    const result = await manager.hydrate({
      _php: createFs({ [PLAYGROUND_DB_PATH]: [1] }),
      flushPersistence: async () => ({
        enabled: true,
        ok: false,
        reason: "flush-failed",
      }),
    });
    assert.deepEqual(result, { captured: false, reason: "flush-failed" });
    assert.deepEqual(details("error"), [
      "[snapshot] mutable-state checkpoint failed; using the last persisted checkpoint",
    ]);
  });

  it("names the size limit when the checkpoint is too large", async () => {
    const { manager, details } = createManager(2048);
    await manager.hydrate({
      _php: createFs(),
      flushPersistence: async () => ({
        enabled: true,
        ok: false,
        reason: "size-limit",
      }),
    });
    assert.match(details("error")[0], /\(0KB exceeds 2KB limit\)/);
  });

  it("falls back to a generic reason when the failure has none", async () => {
    const { manager } = createManager();
    const result = await manager.hydrate({
      _php: createFs(),
      flushPersistence: async () => ({ enabled: true, ok: false }),
    });
    assert.deepEqual(result, {
      captured: false,
      reason: "persist-checkpoint-failed",
    });
  });

  it("turns a throwing flush into a flush-failed result", async () => {
    const { manager, details } = createManager();
    const result = await manager.hydrate({
      _php: createFs({ [PLAYGROUND_DB_PATH]: [1] }),
      flushPersistence: async () => {
        throw new Error("IndexedDB closed");
      },
    });
    assert.deepEqual(result, { captured: false, reason: "flush-failed" });
    assert.match(details("error")[0], /checkpoint failed: IndexedDB closed;/);
    assert.equal(manager.hasPendingRestore, false);
  });

  it("counts missing flushed-op totals as zero", async () => {
    const { manager, details } = createManager();
    const result = await manager.hydrate({
      _php: createFs({ [PLAYGROUND_DB_PATH]: [1] }),
      flushPersistence: async () => ({ enabled: true, ok: true }),
    });
    assert.equal(result.persistMode, "journal");
    assert.ok(
      details("trace").includes(
        "[snapshot] checkpointed 0 pending mutable ops (0KB)",
      ),
    );
  });

  it("uses the file fallback when flushPersistence returns nothing", async () => {
    const { manager } = createManager();
    const fs = createFs({
      [PLAYGROUND_DB_PATH]: [1],
      [`${PERSIST}/config/state.json`]: [4],
    });
    const result = await manager.hydrate({
      _php: fs,
      flushPersistence: async () => undefined,
    });
    assert.equal(result.persistMode, "fallback");
  });
});

describe("snapshot manager file fallback", () => {
  it("captures /persist/mutable without the DB and restores it", async () => {
    const { manager, details } = createManager();
    const configPath = `${PERSIST}/config/state.json`;
    const sessionPath = `${PERSIST}/sessions/sess_1`;
    const source = createFs(
      {
        [PLAYGROUND_DB_PATH]: [9, 9],
        [configPath]: [1, 2],
        [sessionPath]: [3],
        [`${PERSIST}/locked/secret`]: [5],
        [`${PERSIST}/broken.tmp`]: [6],
      },
      {
        unlistable: [`${PERSIST}/locked`],
        unreadable: [`${PERSIST}/broken.tmp`],
      },
    );

    const result = await manager.hydrate({ _php: source }, PLAYGROUND_DB_PATH);
    assert.deepEqual(result, {
      captured: true,
      persistMode: "fallback",
      myFilesMode: "fallback",
    });
    assert.ok(
      details("trace").includes(
        "[snapshot] saved bounded mutable-state fallback (2 entries, 0KB)",
      ),
    );

    const target = createFs();
    assert.deepEqual(await manager.restore({ _php: target }), {
      restored: true,
      addonsRestored: false,
    });
    assert.deepEqual(bytes(target, configPath), [1, 2]);
    assert.deepEqual(bytes(target, sessionPath), [3]);
    assert.deepEqual(bytes(target, PLAYGROUND_DB_PATH), [9, 9]);
    assert.equal(target.files.has(`${PERSIST}/broken.tmp`), false);
    assert.equal(target.files.has(`${PERSIST}/locked/secret`), false);
    // Parents are created once per directory, not once per file.
    assert.deepEqual(target.mkdirs, [
      `${PERSIST}/config`,
      `${PERSIST}/sessions`,
    ]);
  });

  it("abandons the snapshot when /persist/mutable exceeds the bound", async () => {
    const { manager, details } = createManager(2);
    const result = await manager.hydrate({
      _php: createFs({
        [PLAYGROUND_DB_PATH]: [1],
        [`${PERSIST}/a/x`]: [1, 2],
        [`${PERSIST}/a/y`]: [3],
        [`${PERSIST}/b`]: [4],
      }),
    });
    assert.deepEqual(result, { captured: false, reason: "size-limit" });
    assert.match(details("error")[0], /fallback exceeds 0KB; skipping/);
    assert.equal(manager.hasPendingRestore, false);
  });

  it("captures nothing extra when the runtime cannot inspect files", async () => {
    const { manager } = createManager();
    const result = await manager.hydrate({
      _php: { readFileAsBuffer: () => new Uint8Array([7]) },
    });
    assert.deepEqual(result, {
      captured: true,
      persistMode: "fallback",
      myFilesMode: "fallback",
    });
    const target = createFs();
    await manager.restore({ _php: target });
    assert.deepEqual([...target.files.keys()], [PLAYGROUND_DB_PATH]);
  });

  it("captures nothing extra when existence checks throw", async () => {
    const { manager } = createManager();
    const result = await manager.hydrate({
      _php: {
        fileExists() {
          throw new Error("FS not ready");
        },
        isDir: () => false,
        readFileAsBuffer: () => new Uint8Array([7]),
      },
    });
    assert.equal(result.captured, true);
  });

  it("skips the ephemeral MyFiles Log and Tmp folders", async () => {
    const { manager } = createManager();
    const docPath = `${FS_MYFILES_PATH}/Docs/invoice.pdf`;
    await manager.hydrate({
      _php: createFs({
        [PLAYGROUND_DB_PATH]: [1],
        [docPath]: [2],
        [`${FS_MYFILES_PATH}/Log/app.log`]: [3],
        [`${FS_MYFILES_PATH}/Tmp/cache/x`]: [4],
      }),
    });
    const target = createFs();
    await manager.restore({ _php: target });
    assert.deepEqual(
      [...target.files.keys()].filter((p) => p.startsWith(FS_MYFILES_PATH)),
      [docPath],
    );
  });
});

describe("snapshot manager DB read", () => {
  it("defaults to the playground DB path", async () => {
    const { manager, details } = createManager();
    const result = await manager.hydrate({
      _php: createFs({ [PLAYGROUND_DB_PATH]: [1, 2, 3] }),
    });
    assert.equal(result.captured, true);
    assert.ok(details("trace").includes("[snapshot] saved DB (3 bytes)"));
  });

  it("refuses an empty DB and drops the fallback files", async () => {
    const { manager, details } = createManager();
    const result = await manager.hydrate({
      _php: createFs({
        [PLAYGROUND_DB_PATH]: [],
        [`${PERSIST}/config/state.json`]: [1],
      }),
    });
    assert.deepEqual(result, { captured: false, reason: "db-read-failed" });
    assert.match(details("error")[0], /DB snapshot is empty/);
    assert.equal(manager.hasPendingRestore, false);
  });

  it("refuses a missing DB", async () => {
    const { manager } = createManager();
    const result = await manager.hydrate(
      { _php: createFs() },
      "/persist/mutable/db/other.sqlite",
    );
    assert.equal(result.reason, "db-read-failed");
  });
});

describe("snapshot manager addon directories", () => {
  const pluginDir = "/www/facturascripts/Plugins/Demo";

  it("captures tracked addon files and restores them", async () => {
    const { manager, details } = createManager();
    manager.trackAddonDir(pluginDir);
    manager.trackAddonDir("/www/facturascripts/Plugins/Missing");
    manager.trackAddonDir("/www/facturascripts/Plugins/Empty");
    const fs = createFs(
      {
        [PLAYGROUND_DB_PATH]: [1],
        [`${pluginDir}/Init.php`]: [1],
        [`${pluginDir}/Model/Thing.php`]: [2],
        [`${pluginDir}/Model/bad.php`]: [3],
        "/www/facturascripts/Plugins/Empty/x": [4],
      },
      {
        unreadable: [`${pluginDir}/Model/bad.php`],
        unlistable: ["/www/facturascripts/Plugins/Empty"],
      },
    );

    assert.equal((await manager.hydrate({ _php: fs })).captured, true);
    assert.ok(
      details("trace").includes(
        `[snapshot] tracking installed addon: ${pluginDir}`,
      ),
    );
    assert.ok(details("trace").includes("[snapshot] saved 2 addon files"));

    const target = createFs();
    assert.deepEqual(await manager.restore({ _php: target }), {
      restored: true,
      addonsRestored: true,
    });
    assert.deepEqual(bytes(target, `${pluginDir}/Model/Thing.php`), [2]);
    assert.ok(details("trace").includes("[snapshot] restored 2 addon files"));
  });

  it("reports an addon directory that cannot be inspected", async () => {
    const { manager, details } = createManager();
    manager.trackAddonDir(pluginDir);
    const fs = createFs({ [PLAYGROUND_DB_PATH]: [1] });
    const result = await manager.hydrate({
      _php: {
        ...fs,
        fileExists(path) {
          if (path === pluginDir) throw new Error("EIO");
          return fs.fileExists(path);
        },
      },
    });
    assert.equal(result.captured, true);
    assert.ok(
      details("error").includes(
        `[snapshot] failed to read addon dir ${pluginDir}: EIO`,
      ),
    );
  });
});

describe("snapshot manager restore", () => {
  it("reports nothing to restore before a snapshot", async () => {
    const { manager } = createManager();
    assert.equal(manager.hasPendingRestore, false);
    assert.deepEqual(await manager.restore({ _php: createFs() }), {
      restored: false,
      addonsRestored: false,
    });
  });

  it("clear() discards a captured snapshot", async () => {
    const { manager } = createManager();
    await manager.hydrate({ _php: createFs({ [PLAYGROUND_DB_PATH]: [1] }) });
    assert.equal(manager.hasPendingRestore, true);
    manager.clear();
    assert.equal(manager.hasPendingRestore, false);
  });

  it("counts failed writes and is not restored when every write fails", async () => {
    const { manager, details } = createManager();
    const pluginDir = "/www/facturascripts/Plugins/Demo";
    manager.trackAddonDir(pluginDir);
    const configPath = `${PERSIST}/config/state.json`;
    const docPath = `${FS_MYFILES_PATH}/doc.txt`;
    const addonPath = `${pluginDir}/Init.php`;
    await manager.hydrate({
      _php: createFs({
        [PLAYGROUND_DB_PATH]: [1],
        [configPath]: [2],
        [docPath]: [3],
        [addonPath]: [4],
      }),
    });

    const target = createFs(
      {},
      { failWrites: [PLAYGROUND_DB_PATH, configPath, docPath, addonPath] },
    );
    assert.deepEqual(await manager.restore({ _php: target }), {
      restored: false,
      addonsRestored: false,
    });
    const traces = details("trace");
    assert.ok(
      traces.includes(
        "[snapshot] restored 0 mutable-state fallback files (1 failed)",
      ),
    );
    assert.ok(traces.includes("[snapshot] restored 0 addon files (1 failed)"));
    assert.ok(
      traces.includes(
        "[snapshot] restored 0 MyFiles checkpoint files (1 failed)",
      ),
    );
    assert.ok(
      details("error").includes(
        `[snapshot] failed to restore DB: EROFS ${PLAYGROUND_DB_PATH}`,
      ),
    );
    assert.equal(manager.hasPendingRestore, false);
  });

  it("restores a custom DB path without creating directories", async () => {
    const { manager } = createManager();
    await manager.hydrate(
      { _php: createFs({ "/db.sqlite": [5] }) },
      "/db.sqlite",
    );
    const target = createFs();
    await manager.restore({ _php: target });
    assert.deepEqual(bytes(target, "/db.sqlite"), [5]);
    assert.deepEqual(target.mkdirs, []);
  });

  it("restores the MyFiles checkpoint alone", async () => {
    const { manager, details } = createManager();
    const docPath = `${FS_MYFILES_PATH}/doc.txt`;
    await manager.hydrate({
      _php: createFs({ [PLAYGROUND_DB_PATH]: [1], [docPath]: [3] }),
    });
    const target = createFs({}, { failWrites: [PLAYGROUND_DB_PATH] });
    assert.deepEqual(await manager.restore({ _php: target }), {
      restored: true,
      addonsRestored: false,
    });
    assert.deepEqual(bytes(target, docPath), [3]);
    assert.ok(
      details("trace").includes(
        "[snapshot] restored 1 MyFiles checkpoint files",
      ),
    );
  });
});
