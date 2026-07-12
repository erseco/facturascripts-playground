import assert from "node:assert/strict";
import { test } from "node:test";

import { FS_ROOT, PLAYGROUND_DB_PATH } from "../src/runtime/bootstrap-paths.js";
import { createSnapshotManager } from "../src/runtime/crash-recovery.js";

const MYFILES_PATH = `${FS_ROOT}/MyFiles`;

function createMessages() {
  const messages = [];
  return {
    messages,
    postShell: (message) => messages.push(message),
  };
}

test("snapshot manager flushes pending mutable-state ops before reading the DB", async () => {
  const { messages, postShell } = createMessages();
  const flushCalls = [];
  let dbReads = 0;
  const snapshot = createSnapshotManager({
    postShell,
    maxCrashCheckpointBytes: 4096,
  });

  const result = await snapshot.hydrate(
    {
      _php: {
        fileExists(path) {
          return path !== MYFILES_PATH;
        },
        isDir(path) {
          return path !== PLAYGROUND_DB_PATH;
        },
        readFileAsBuffer(path) {
          assert.equal(path, PLAYGROUND_DB_PATH);
          dbReads++;
          return new Uint8Array([1, 2, 3]);
        },
      },
      async flushPersistence(options) {
        flushCalls.push(options);
        return {
          enabled: true,
          ok: true,
          flushedOps: 2,
          hydratedBytes: 1024,
          estimatedBytes: 1024,
        };
      },
    },
    PLAYGROUND_DB_PATH,
  );

  assert.deepEqual(result, {
    captured: true,
    persistMode: "journal",
    myFilesMode: "fallback",
  });
  assert.equal(dbReads, 1);
  assert.deepEqual(flushCalls, [
    { pathPrefix: "/persist/mutable", maxBytes: 4096 },
  ]);
  assert.equal(snapshot.hasPendingRestore, true);
  assert.ok(
    messages.some((message) =>
      message.detail?.includes("checkpointed 2 pending mutable ops"),
    ),
  );
});

test("snapshot manager does not capture a newer DB when the mutable checkpoint fails", async () => {
  const { postShell } = createMessages();
  let dbReads = 0;
  const snapshot = createSnapshotManager({
    postShell,
    maxCrashCheckpointBytes: 4096,
  });

  const result = await snapshot.hydrate(
    {
      _php: {
        readFileAsBuffer() {
          dbReads++;
          return new Uint8Array([1]);
        },
      },
      async flushPersistence() {
        return {
          enabled: true,
          ok: false,
          reason: "size-limit",
          estimatedBytes: 8192,
        };
      },
    },
    PLAYGROUND_DB_PATH,
  );

  assert.equal(result.captured, false);
  assert.equal(result.reason, "size-limit");
  assert.equal(dbReads, 0);
  assert.equal(snapshot.hasPendingRestore, false);
});

test("snapshot manager restores a bounded MyFiles fallback when persistence is unavailable", async () => {
  const { postShell } = createMessages();
  const uploadPath = `${MYFILES_PATH}/Docs/manual.pdf`;
  const snapshot = createSnapshotManager({
    postShell,
    maxCrashCheckpointBytes: 1024,
  });

  const result = await snapshot.hydrate(
    {
      _php: {
        fileExists(path) {
          return path === MYFILES_PATH;
        },
        isDir(path) {
          return path === MYFILES_PATH || path === `${MYFILES_PATH}/Docs`;
        },
        listFiles(path) {
          if (path === MYFILES_PATH) return [`${MYFILES_PATH}/Docs`];
          if (path === `${MYFILES_PATH}/Docs`) return [uploadPath];
          return [];
        },
        readFileAsBuffer(path) {
          if (path === PLAYGROUND_DB_PATH) return new Uint8Array([9, 8]);
          if (path === uploadPath) return new Uint8Array([7, 6, 5]);
          throw new Error(`unexpected read: ${path}`);
        },
      },
      async flushPersistence() {
        return { enabled: false, ok: true };
      },
    },
    PLAYGROUND_DB_PATH,
  );

  assert.deepEqual(result, {
    captured: true,
    persistMode: "fallback",
    myFilesMode: "fallback",
  });

  const writes = new Map();
  const restoreResult = await snapshot.restore({
    _php: {
      mkdirTree() {},
      writeFile(path, data) {
        writes.set(path, [...data]);
      },
    },
  });

  assert.equal(restoreResult.restored, true);
  assert.deepEqual(writes.get(PLAYGROUND_DB_PATH), [9, 8]);
  assert.deepEqual(writes.get(uploadPath), [7, 6, 5]);
  assert.equal(snapshot.hasPendingRestore, false);
});

test("snapshot manager abandons the live snapshot when MyFiles exceeds the bounded fallback limit", async () => {
  const { postShell } = createMessages();
  const uploadPath = `${MYFILES_PATH}/large.bin`;
  let dbReads = 0;
  const snapshot = createSnapshotManager({
    postShell,
    maxCrashCheckpointBytes: 3,
  });

  const result = await snapshot.hydrate(
    {
      _php: {
        fileExists(path) {
          return path === MYFILES_PATH;
        },
        isDir(path) {
          return path === MYFILES_PATH;
        },
        listFiles() {
          return [uploadPath];
        },
        readFileAsBuffer(path) {
          if (path === PLAYGROUND_DB_PATH) {
            dbReads++;
            return new Uint8Array([1]);
          }
          return new Uint8Array([1, 2, 3, 4]);
        },
      },
      async flushPersistence() {
        return {
          enabled: true,
          ok: true,
          flushedOps: 0,
          hydratedBytes: 0,
          estimatedBytes: 0,
        };
      },
    },
    PLAYGROUND_DB_PATH,
  );

  assert.equal(result.captured, false);
  assert.equal(result.reason, "size-limit");
  assert.equal(dbReads, 0);
  assert.equal(snapshot.hasPendingRestore, false);
});
