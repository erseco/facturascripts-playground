import {
  __private__dont__use,
  PHP,
  setPhpIniEntries,
} from "@php-wasm/universal";
import { loadWebRuntime } from "@php-wasm/web";
import { FS_ROOT } from "./bootstrap.js";
import { wrapPhpInstance } from "./php-compat.js";

const PERSIST_ROOT = "/persist";
const TEMP_ROOT = "/tmp";
const CONFIG_ROOT = "/config";
const DEFAULT_PHP_VERSION = "8.3";

// Block slow outbound PHP calls to facturascripts.com (Forja builds/plugins, telemetry).
// PHP WASM routes curl/file_get_contents through globalThis.fetch; intercepting here
// returns empty JSON immediately instead of waiting for the 3–10 s curl timeout.
if (!globalThis.__playgroundOriginalFetch) {
  globalThis.__playgroundOriginalFetch = globalThis.fetch.bind(globalThis);
  const _blockedPrefixes = [
    "https://facturascripts.com/DownloadBuild",
    "https://facturascripts.com/PluginInfoList",
    "https://facturascripts.com/Telemetry",
  ];
  globalThis.fetch = function playgroundFetch(input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input?.url ?? "");
    if (_blockedPrefixes.some((p) => url.startsWith(p))) {
      return Promise.resolve(
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return globalThis.__playgroundOriginalFetch(input, init);
  };
}

export function createPhpRuntime(
  _runtime,
  { appBaseUrl, phpVersion, webRoot, scopeId, forceCleanBoot } = {},
) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  let wrapped = null;

  const deferred = {
    async refresh() {
      const runtimeId = await loadWebRuntime(resolvedPhpVersion);
      const php = new PHP(runtimeId);
      const FS = php[__private__dont__use].FS;

      try {
        FS.mkdirTree(TEMP_ROOT);
      } catch {}
      try {
        FS.mkdirTree(FS_ROOT);
      } catch {}
      try {
        FS.mkdirTree(PERSIST_ROOT);
      } catch {}
      try {
        FS.mkdirTree(CONFIG_ROOT);
      } catch {}

      // Replay/start fs-journal persistence for mutable paths.
      if (scopeId) {
        const { clearJournal, clearOpcacheJournal, initFsPersistence } =
          await import("./fs-persistence.js");
        if (forceCleanBoot) {
          await clearJournal(scopeId);
          await clearOpcacheJournal(resolvedPhpVersion);
        } else {
          await initFsPersistence(php, scopeId, resolvedPhpVersion);
        }
      }

      // The default auto_prepend_file at /internal/shared/auto_prepend_file.php
      // is written by bootstrap.js with the playground prepend (Forja cache,
      // $_SERVER vars, etc.). Do NOT empty it here.

      await setPhpIniEntries(php, {
        memory_limit: "256M",
        max_execution_time: "0",
        display_errors: "On",
        error_reporting: "E_ALL",
        "session.save_path": "/persist/mutable/session",
        upload_tmp_dir: "/tmp",
        default_socket_timeout: "1",
        "date.timezone": "UTC",
        // OPcache tuning — defaults cap at 1000 files and use file_cache_only
        // which reads bytecode from MEMFS on every request.  Switch to the
        // in-memory cache with a higher file limit and no timestamp checks
        // (the readonly bundle never changes within a session).
        "opcache.enable": "1",
        "opcache.file_cache": "/internal/shared/opcache",
        "opcache.file_cache_only": "1",
        "opcache.max_accelerated_files": "10000",
        "opcache.memory_consumption": "128",
        "opcache.interned_strings_buffer": "32",
        "opcache.validate_timestamps": "0",
        "opcache.file_cache_consistency_checks": "0",
      });

      try {
        FS.mkdirTree("/internal/shared/preload");
      } catch {}

      const absoluteUrl = (appBaseUrl || "http://localhost:8080").replace(
        /\/$/u,
        "",
      );
      wrapped = wrapPhpInstance(php, {
        syncFs: null,
        absoluteUrl,
        webRoot: webRoot || FS_ROOT,
      });

      for (const key of Object.keys(wrapped)) {
        if (key !== "refresh") {
          deferred[key] = wrapped[key];
        }
      }

      Object.defineProperty(deferred, "binary", {
        get() {
          return wrapped.binary;
        },
        configurable: true,
      });
      Object.defineProperty(deferred, "_php", {
        get() {
          return wrapped._php;
        },
        configurable: true,
      });
    },
    async request() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async analyzePath() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async mkdir() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async writeFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async readFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async run() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return deferred;
}
