/**
 * Crash recovery utilities for the PHP WASM runtime.
 *
 * Recovery strategy:
 *   - Reactive rotation detects fatal errors and discards the runtime.
 *   - Idempotent requests (GET/HEAD) are replayed once on a fresh runtime.
 *   - Non-idempotent requests are NOT replayed to avoid side-effects.
 *   - Pending /persist/mutable journal changes are checkpointed before the DB snapshot.
 */

import { FS_ROOT, PLAYGROUND_DB_PATH } from "./bootstrap-paths.js";

const PERSIST_CHECKPOINT_PATH = "/persist/mutable";
const MYFILES_PATH = `${FS_ROOT}/MyFiles`;
// Log/Tmp are runtime-generated cache/log folders. Recreating them empty on boot
// is cheaper and safer than pinning crash recovery to transient files.
const MYFILES_EPHEMERAL_PREFIXES = [
  `${MYFILES_PATH}/Log`,
  `${MYFILES_PATH}/Tmp`,
];
const DEFAULT_MAX_CRASH_CHECKPOINT_BYTES = 16 * 1024 * 1024;

/**
 * Detect Emscripten errno 23 (EHOSTUNREACH).  In WASM, outbound curl
 * calls that cannot reach the host crash with this errno.  Dashboard's
 * Telemetry/Forja/News HTTP calls trigger it on Firefox/Safari where
 * Emscripten's networking layer fails to connect.
 */
export function isEmscriptenNetworkError(error) {
  if (!error) return false;
  return error.errno === 23;
}

/**
 * Determine whether an error represents a fatal, unrecoverable WASM crash.
 */
export function isFatalWasmError(error) {
  if (!error) {
    return false;
  }

  if (isEmscriptenNetworkError(error)) return true;

  const message = String(error.message || error);
  return (
    (typeof WebAssembly !== "undefined" &&
      error instanceof WebAssembly.RuntimeError) ||
    message.includes("memory access out of bounds") ||
    message.includes("unreachable") ||
    message.includes("RuntimeError") ||
    message.includes("Failed opening required")
  );
}

/**
 * Determine whether a serialized request is safe to replay after a crash.
 */
export function isSafeToReplay(serializedRequest) {
  const method = String(serializedRequest?.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * Format an error into a human-readable string for display/logging.
 */
export function formatErrorDetail(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return String(error.stack || error.message || error);
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function formatKB(bytes) {
  return Math.round((bytes || 0) / 1024);
}

export function createSnapshotManager({
  postShell,
  maxCrashCheckpointBytes = DEFAULT_MAX_CRASH_CHECKPOINT_BYTES,
}) {
  let savedDbSnapshot = null;
  let savedAddonFiles = null;
  let savedPersistFiles = null;
  let savedMyFiles = null;
  const installedAddonDirs = new Set();

  function clearSavedState() {
    savedDbSnapshot = null;
    savedAddonFiles = null;
    savedPersistFiles = null;
    savedMyFiles = null;
  }

  function restoreFiles(rawPhp, files) {
    let ok = 0;
    let failed = 0;
    const createdDirs = new Set();

    for (const file of files) {
      try {
        const lastSlash = file.path.lastIndexOf("/");
        const parentDir =
          lastSlash > 0 ? file.path.substring(0, lastSlash) : null;
        if (parentDir && !createdDirs.has(parentDir)) {
          rawPhp.mkdirTree(parentDir);
          let dir = parentDir;
          while (dir && !createdDirs.has(dir)) {
            createdDirs.add(dir);
            dir = dir.substring(0, dir.lastIndexOf("/")) || null;
          }
        }
        rawPhp.writeFile(file.path, file.data);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  function collectFiles(rawPhp, dirPath) {
    const files = [];
    try {
      const entries = rawPhp.listFiles(dirPath, { prependPath: true });
      for (const entry of entries) {
        if (rawPhp.isDir(entry)) {
          files.push(...collectFiles(rawPhp, entry));
        } else {
          try {
            const data = rawPhp.readFileAsBuffer(entry);
            files.push({ path: entry, data: new Uint8Array(data) });
          } catch {
            // Unreadable file — skip
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read — skip
    }
    return files;
  }

  function collectFilesBounded(
    rawPhp,
    dirPath,
    maxBytes,
    { skip = null } = {},
  ) {
    const files = [];
    let totalBytes = 0;
    let exceeded = false;

    const visit = (path) => {
      if (exceeded || skip?.(path)) return;

      let entries;
      try {
        entries = rawPhp.listFiles(path, { prependPath: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (exceeded || skip?.(entry)) return;
        if (rawPhp.isDir(entry)) {
          visit(entry);
          continue;
        }

        try {
          const data = new Uint8Array(rawPhp.readFileAsBuffer(entry));
          if (totalBytes + data.byteLength > maxBytes) {
            exceeded = true;
            files.length = 0;
            return;
          }
          totalBytes += data.byteLength;
          files.push({ path: entry, data });
        } catch {
          // Unreadable file — skip
        }
      }
    };

    visit(dirPath);
    return { exceeded, files, totalBytes };
  }

  async function preparePersistCheckpoint(php, rawPhp) {
    if (typeof php.flushPersistence === "function") {
      try {
        const result = await php.flushPersistence({
          pathPrefix: PERSIST_CHECKPOINT_PATH,
          maxBytes: maxCrashCheckpointBytes,
        });

        if (result?.enabled) {
          if (!result.ok) {
            const sizeDetail =
              result.reason === "size-limit"
                ? ` (${formatKB(result.estimatedBytes)}KB exceeds ${formatKB(maxCrashCheckpointBytes)}KB limit)`
                : "";
            postShell({
              kind: "error",
              detail: `[snapshot] mutable-state checkpoint failed${sizeDetail}; using the last persisted checkpoint`,
            });
            return { ok: false, mode: "journal", reason: result.reason };
          }

          postShell({
            kind: "trace",
            detail: `[snapshot] checkpointed ${result.flushedOps || 0} pending mutable ops (${formatKB(result.hydratedBytes)}KB)`,
          });
          return { ok: true, mode: "journal" };
        }
      } catch (error) {
        postShell({
          kind: "error",
          detail: `[snapshot] mutable-state checkpoint failed: ${error.message}; using the last persisted checkpoint`,
        });
        return { ok: false, mode: "journal", reason: "flush-failed" };
      }
    }

    if (
      typeof rawPhp?.fileExists !== "function" ||
      typeof rawPhp?.isDir !== "function"
    ) {
      return { ok: true, mode: "fallback", files: [] };
    }

    let hasPersistRoot = false;
    try {
      hasPersistRoot =
        rawPhp.fileExists(PERSIST_CHECKPOINT_PATH) &&
        rawPhp.isDir(PERSIST_CHECKPOINT_PATH);
    } catch {
      return { ok: true, mode: "fallback", files: [] };
    }

    if (!hasPersistRoot) {
      return { ok: true, mode: "fallback", files: [] };
    }

    const fallback = collectFilesBounded(
      rawPhp,
      PERSIST_CHECKPOINT_PATH,
      maxCrashCheckpointBytes,
      {
        skip: (path) => path === PLAYGROUND_DB_PATH,
      },
    );
    if (fallback.exceeded) {
      postShell({
        kind: "error",
        detail: `[snapshot] bounded mutable-state fallback exceeds ${formatKB(maxCrashCheckpointBytes)}KB; skipping live snapshot`,
      });
      return { ok: false, mode: "fallback", reason: "size-limit" };
    }

    postShell({
      kind: "trace",
      detail: `[snapshot] saved bounded mutable-state fallback (${fallback.files.length} entries, ${formatKB(fallback.totalBytes)}KB)`,
    });
    return { ok: true, mode: "fallback", files: fallback.files };
  }

  function prepareMyFilesCheckpoint(rawPhp) {
    if (
      typeof rawPhp?.fileExists !== "function" ||
      typeof rawPhp?.isDir !== "function"
    ) {
      return { ok: true, mode: "fallback", files: [] };
    }

    let hasMyFiles = false;
    try {
      hasMyFiles =
        rawPhp.fileExists(MYFILES_PATH) && rawPhp.isDir(MYFILES_PATH);
    } catch {
      return { ok: true, mode: "fallback", files: [] };
    }

    if (!hasMyFiles) {
      return { ok: true, mode: "fallback", files: [] };
    }

    const fallback = collectFilesBounded(
      rawPhp,
      MYFILES_PATH,
      maxCrashCheckpointBytes,
      {
        skip: (path) =>
          MYFILES_EPHEMERAL_PREFIXES.some(
            (prefix) => path === prefix || path.startsWith(`${prefix}/`),
          ),
      },
    );
    if (fallback.exceeded) {
      postShell({
        kind: "error",
        detail: `[snapshot] bounded MyFiles checkpoint exceeds ${formatKB(maxCrashCheckpointBytes)}KB; skipping live snapshot`,
      });
      return { ok: false, mode: "fallback", reason: "size-limit" };
    }

    postShell({
      kind: "trace",
      detail: `[snapshot] saved bounded MyFiles checkpoint (${fallback.files.length} entries, ${formatKB(fallback.totalBytes)}KB)`,
    });
    return { ok: true, mode: "fallback", files: fallback.files };
  }

  return {
    async hydrate(php, dbPath) {
      clearSavedState();
      const rawPhp = php._php;
      const effectiveDbPath = dbPath || PLAYGROUND_DB_PATH;

      const persistCheckpoint = await preparePersistCheckpoint(php, rawPhp);
      if (!persistCheckpoint.ok) {
        return {
          captured: false,
          reason: persistCheckpoint.reason || "persist-checkpoint-failed",
        };
      }

      const myFilesCheckpoint = prepareMyFilesCheckpoint(rawPhp);
      if (!myFilesCheckpoint.ok) {
        clearSavedState();
        return {
          captured: false,
          reason: myFilesCheckpoint.reason || "myfiles-checkpoint-failed",
        };
      }

      if (
        persistCheckpoint.mode === "fallback" &&
        persistCheckpoint.files.length > 0
      ) {
        savedPersistFiles = persistCheckpoint.files;
      }
      if (myFilesCheckpoint.files.length > 0) {
        savedMyFiles = myFilesCheckpoint.files;
      }

      try {
        const data = rawPhp.readFileAsBuffer(effectiveDbPath);
        if (!data || data.byteLength === 0) {
          throw new Error("DB snapshot is empty");
        }
        savedDbSnapshot = {
          path: effectiveDbPath,
          data: new Uint8Array(data),
        };
        postShell({
          kind: "trace",
          detail: `[snapshot] saved DB (${data.byteLength} bytes)`,
        });
      } catch (err) {
        clearSavedState();
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read DB: ${err.message}; using the last persisted checkpoint`,
        });
        return { captured: false, reason: "db-read-failed" };
      }

      if (installedAddonDirs.size > 0) {
        const allFiles = [];
        for (const dir of installedAddonDirs) {
          try {
            if (!rawPhp.fileExists(dir)) continue;
            const files = collectFiles(rawPhp, dir);
            if (files.length > 0) {
              allFiles.push(...files);
            }
          } catch (err) {
            postShell({
              kind: "error",
              detail: `[snapshot] failed to read addon dir ${dir}: ${err.message}`,
            });
          }
        }
        if (allFiles.length > 0) {
          savedAddonFiles = allFiles;
          postShell({
            kind: "trace",
            detail: `[snapshot] saved ${allFiles.length} addon files`,
          });
        }
      }

      return {
        captured: true,
        persistMode: persistCheckpoint.mode,
        myFilesMode: myFilesCheckpoint.mode,
      };
    },

    async restore(php) {
      if (
        !savedDbSnapshot &&
        !savedAddonFiles &&
        !savedPersistFiles &&
        !savedMyFiles
      ) {
        return { restored: false, addonsRestored: false };
      }
      const rawPhp = php._php;
      let restored = false;
      let addonsRestored = false;

      if (savedPersistFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedPersistFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} mutable-state fallback files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
        }
        savedPersistFiles = null;
      }

      if (savedDbSnapshot) {
        try {
          rawPhp.writeFile(savedDbSnapshot.path, savedDbSnapshot.data);
          postShell({
            kind: "trace",
            detail: `[snapshot] restored DB (${savedDbSnapshot.data.byteLength} bytes)`,
          });
          restored = true;
        } catch (err) {
          postShell({
            kind: "error",
            detail: `[snapshot] failed to restore DB: ${err.message}`,
          });
        }
        savedDbSnapshot = null;
      }

      if (savedAddonFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedAddonFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} addon files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
          addonsRestored = true;
        }
        savedAddonFiles = null;
      }

      if (savedMyFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedMyFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} MyFiles checkpoint files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
        }
        savedMyFiles = null;
      }

      return { restored, addonsRestored };
    },

    get hasPendingRestore() {
      return (
        savedDbSnapshot !== null ||
        savedAddonFiles !== null ||
        savedPersistFiles !== null ||
        savedMyFiles !== null
      );
    },

    trackAddonDir(dirPath) {
      installedAddonDirs.add(dirPath);
      postShell({
        kind: "trace",
        detail: `[snapshot] tracking installed addon: ${dirPath}`,
      });
    },

    clear() {
      clearSavedState();
    },
  };
}
