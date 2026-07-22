import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpcacheKey,
  collapseAndHydrate,
  flushPendingOps,
  opcacheDatabaseName,
  operationTouchesPathPrefix,
} from "../src/runtime/fs-persistence.js";

test("OPcache persistence is isolated by PHP and exact core identity", () => {
  const stable = opcacheDatabaseName(buildOpcacheKey("8.5", "stable-sha"));
  const beta = opcacheDatabaseName(buildOpcacheKey("8.5", "beta-sha"));
  const olderPhp = opcacheDatabaseName(buildOpcacheKey("8.4", "stable-sha"));

  assert.notEqual(stable, beta);
  assert.notEqual(stable, olderPhp);
  assert.equal(stable, "facturascripts-opcache:8.5:stable-sha");
});

// Regression guard for the journal-flush OOM: a heavy install rewrites the same
// (multi-MB) SQLite DB hundreds of times within one debounce window. Hydrating
// the raw, un-collapsed op list read every write's content into memory at once →
// `RangeError: Array buffer allocation failed`. collapseAndHydrate must normalize
// FIRST (collapsing same-path writes) so each changed file is read exactly once.
test("collapseAndHydrate reads each changed file once, not once per write", async () => {
  const path = "/persist/data.sq3";
  const ops = Array.from({ length: 500 }, () => ({
    operation: "WRITE",
    path,
    nodeType: "file",
  }));

  const reads = new Map();
  const fakePhp = {
    readFileAsBuffer(p) {
      reads.set(p, (reads.get(p) || 0) + 1);
      return new Uint8Array(8);
    },
  };

  const hydrated = await collapseAndHydrate(fakePhp, ops);

  // 500 writes to one path collapse to a single WRITE op...
  const writes = hydrated.filter(
    (op) => op.operation === "WRITE" && op.path === path,
  );
  assert.equal(writes.length, 1);
  // ...and the file is read exactly once (the OOM guard), not 500 times.
  assert.equal(reads.get(path), 1);
});

test("flushPendingOps flushes only matching path-prefix ops", async () => {
  const dataRoot = "/persist/mutable";
  const dataPath = `${dataRoot}/config/state.json`;
  const dbOp = {
    operation: "WRITE",
    path: "/internal/shared/opcache/script.bin",
    nodeType: "file",
  };
  const pendingOps = [
    dbOp,
    { operation: "WRITE", path: dataPath, nodeType: "file" },
    { operation: "WRITE", path: dataPath, nodeType: "file" },
  ];
  let reads = 0;
  let persisted = [];

  const result = await flushPendingOps({
    rawPhp: {
      readFileAsBuffer(path) {
        assert.equal(path, dataPath);
        reads++;
        return new Uint8Array([1, 2, 3]);
      },
    },
    pendingOps,
    loadPersistedOps: async () => [],
    replacePersistedOps: async (ops) => {
      persisted = ops;
    },
    shouldFlush: (op) => operationTouchesPathPrefix(op, dataRoot),
    maxBytes: 1024,
    getFileSize: () => 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.flushedOps, 1);
  assert.equal(result.hydratedBytes, 3);
  assert.equal(reads, 1);
  assert.deepEqual(pendingOps, [dbOp]);
  assert.equal(persisted.length, 1);
  assert.deepEqual([...persisted[0].data], [1, 2, 3]);
});

test("flushPendingOps rejects an oversized checkpoint before hydrating", async () => {
  const fileOp = {
    operation: "WRITE",
    path: "/persist/mutable/config/large.json",
    nodeType: "file",
  };
  const pendingOps = [fileOp];
  let reads = 0;
  let writes = 0;

  const result = await flushPendingOps({
    rawPhp: {
      readFileAsBuffer() {
        reads++;
        return new Uint8Array(32);
      },
    },
    pendingOps,
    loadPersistedOps: async () => [],
    replacePersistedOps: async () => {
      writes++;
    },
    maxBytes: 8,
    getFileSize: () => 32,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "size-limit");
  assert.equal(result.estimatedBytes, 32);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(pendingOps, [fileOp]);
});

test("flushPendingOps restores selected ops if persistence fails", async () => {
  const fileOp = {
    operation: "WRITE",
    path: "/persist/mutable/config/state.json",
    nodeType: "file",
  };
  const pendingOps = [fileOp];

  const result = await flushPendingOps({
    rawPhp: {
      readFileAsBuffer: () => new Uint8Array([1]),
    },
    pendingOps,
    loadPersistedOps: async () => [],
    replacePersistedOps: async () => {
      throw new Error("IndexedDB unavailable");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "flush-failed");
  assert.deepEqual(pendingOps, [fileOp]);
});

test("operationTouchesPathPrefix matches renames touching the prefix", () => {
  const root = "/persist/mutable";

  assert.equal(
    operationTouchesPathPrefix(
      {
        operation: "RENAME",
        path: "/tmp/upload",
        toPath: `${root}/config/new.json`,
        nodeType: "file",
      },
      root,
    ),
    true,
  );
  assert.equal(
    operationTouchesPathPrefix(
      {
        operation: "RENAME",
        path: `${root}/config/old.json`,
        toPath: "/tmp/removed",
        nodeType: "file",
      },
      root,
    ),
    true,
  );
});
