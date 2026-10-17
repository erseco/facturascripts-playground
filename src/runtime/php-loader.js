import {
  __private__dont__use,
  PHP,
  setPhpIniEntries,
} from "@php-wasm/universal";
import {
  certificateToPEM,
  generateCertificate,
  loadWebRuntime,
} from "@php-wasm/web";
import { FS_ROOT } from "./bootstrap.js";
import { wrapPhpInstance } from "./php-compat.js";

const PERSIST_ROOT = "/persist";
const TEMP_ROOT = "/tmp";
const CONFIG_ROOT = "/config";
const DEFAULT_PHP_VERSION = "8.3";

const TCP_OVER_FETCH_CA_PATH = "/internal/shared/playground-ca.pem";
let cachedTcpOverFetchCaPromise = null;

async function getTcpOverFetchOptions(corsProxyUrl) {
  if (!cachedTcpOverFetchCaPromise) {
    cachedTcpOverFetchCaPromise = generateCertificate({
      subject: {
        commonName: "FacturaScripts Playground CA",
        organizationName: "FacturaScripts Playground",
        countryName: "ES",
      },
      basicConstraints: { ca: true },
    });
  }
  return {
    CAroot: await cachedTcpOverFetchCaPromise,
    ...(corsProxyUrl ? { corsProxyUrl } : {}),
  };
}

// Scripts OPcache must never cache. php.run({ code }) writes every snippet to
// the same /internal/eval.php, so a stored .bin would be served for a later,
// different snippet. The blacklist is honoured on store in file-cache-only mode.
// Ported from moodle-playground ADR-0038:
// https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0038-opcache-file-cache-timestamp-validation.md
const OPCACHE_BLACKLIST_PATH = "/internal/shared/opcache-blacklist.txt";
const OPCACHE_BLACKLIST = "/internal/eval.php\n";

const PHP_INI_ENTRIES = {
  memory_limit: "256M",
  max_execution_time: "0",
  display_errors: "On",
  error_reporting: "E_ALL",
  "session.save_path": "/persist/mutable/session",
  upload_tmp_dir: "/tmp",
  default_socket_timeout: "1",
  "date.timezone": "UTC",
  "openssl.cafile": TCP_OVER_FETCH_CA_PATH,
  "curl.cainfo": TCP_OVER_FETCH_CA_PATH,
  // OPcache tuning — compiled bytecode is kept in /internal/shared/opcache
  // (file cache only; not journaled, rebuilt every session).
  // Timestamps ARE validated: PHP <= 8.4 never starts OPcache under the `wasm`
  // SAPI (see OPCACHE_SAPI_NAME), but PHP 8.5 dropped the SAPI whitelist and
  // runs this cache for real, and PHP files do change within a session
  // (Plugins::deploy rewrites Dinamic/, plugin installs). In file-cache-only
  // mode opcache_reset() and opcache_invalidate() are no-ops, so the mtime
  // check (whole seconds, with PHP's default 2 s file_update_protection) is
  // the only invalidation. max_accelerated_files / memory_consumption /
  // interned_strings_buffer are inert without a shared memory segment and are
  // kept for the day one becomes available.
  "opcache.enable": "1",
  "opcache.jit": "0",
  "opcache.file_cache": "/internal/shared/opcache",
  "opcache.file_cache_only": "1",
  "opcache.max_accelerated_files": "10000",
  "opcache.memory_consumption": "96",
  "opcache.interned_strings_buffer": "16",
  "opcache.validate_timestamps": "1",
  "opcache.revalidate_freq": "0",
  "opcache.blacklist_filename": OPCACHE_BLACKLIST_PATH,
  "opcache.file_cache_consistency_checks": "0",
};

// PHP reads opcache.blacklist_filename at startup, so the file has to exist
// before the first request.
function writeOpcacheBlacklist(php, FS) {
  try {
    FS.mkdirTree("/internal/shared");
  } catch {
    /* exists */
  }
  php.writeFile(OPCACHE_BLACKLIST_PATH, OPCACHE_BLACKLIST);
}

// Experimental OPcache activation (`?opcache=1` / playground.config.json
// "opcache", default off). php-src <= 8.4 only starts OPcache for whitelisted
// SAPI names; `uwsgi` is on that list and nothing shipped in the FacturaScripts
// bundle branches on it: every php_sapi_name()/PHP_SAPI check in Core/ and
// vendor/ compares against `cli` (audit in CHANGELOG-TECHNICAL.md, "OPcache
// file cache validation and experimental activation"). Reported to PHP as
// php_sapi_name(); php-wasm itself ignores the value. Ported from
// moodle-playground ADR-0039:
// https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0039-experimental-opcache-via-sapi-name.md
export const OPCACHE_SAPI_NAME = "uwsgi";

export const __testing = { PHP_INI_ENTRIES, writeOpcacheBlacklist };

export function createPhpRuntime(
  _runtime,
  {
    appBaseUrl,
    coreIdentity,
    phpVersion,
    webRoot,
    scopeId,
    forceCleanBoot,
    corsProxyUrl,
    phpCorsProxyUrl,
    opcache = false,
  } = {},
) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  let wrapped = null;
  let persistenceController = null;

  const deferred = {
    async refresh() {
      const resolvedCorsProxyUrl = corsProxyUrl ?? phpCorsProxyUrl ?? null;
      const tcpOverFetch = await getTcpOverFetchOptions(resolvedCorsProxyUrl);
      const runtimeId = await loadWebRuntime(resolvedPhpVersion, {
        emscriptenOptions: {
          INITIAL_MEMORY: 128 * 1024 * 1024,
          ALLOW_MEMORY_GROWTH: 1,
        },
        tcpOverFetch,
      });
      const php = new PHP(runtimeId);
      if (opcache) {
        // Must precede the first request: PHP reads the SAPI name once at
        // startup. php-wasm re-applies it on runtime hot-swap.
        await php.setSapiName(OPCACHE_SAPI_NAME);
      }
      const FS = php[__private__dont__use].FS;
      persistenceController = null;

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

      php.writeFile(
        TCP_OVER_FETCH_CA_PATH,
        `${certificateToPEM(tcpOverFetch.CAroot.certificate)}\n`,
      );

      // Replay/start fs-journal persistence for mutable paths.
      if (scopeId) {
        const { clearJournal, dropLegacyOpcacheJournals, initFsPersistence } =
          await import("./fs-persistence.js");
        // On a clean boot (reset / blueprint change), wipe the old journal
        // first; then ALWAYS start journaling so the fresh env persists on later
        // reloads (a same-blueprint reload then reuses it, no reinstall).
        if (forceCleanBoot) {
          await clearJournal(scopeId);
        }
        // OPcache bytecode is no longer persisted; drop stores older sessions left.
        dropLegacyOpcacheJournals(resolvedPhpVersion, coreIdentity);
        persistenceController = await initFsPersistence(php, scopeId);
      }

      // The default auto_prepend_file at /internal/shared/auto_prepend_file.php
      // is written by bootstrap.js with the playground prepend (Forja cache,
      // $_SERVER vars, etc.). Do NOT empty it here.

      writeOpcacheBlacklist(php, FS);
      await setPhpIniEntries(php, PHP_INI_ENTRIES);

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
    async flushPersistence() {
      return {
        enabled: false,
        ok: true,
        flushedOps: 0,
        hydratedBytes: 0,
        estimatedBytes: 0,
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  deferred.flushPersistence = async (options = {}) => {
    if (!persistenceController) {
      return {
        enabled: false,
        ok: true,
        flushedOps: 0,
        hydratedBytes: 0,
        estimatedBytes: 0,
      };
    }

    return {
      enabled: true,
      ...(await persistenceController.flushNow(options)),
    };
  };

  return deferred;
}
