import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

// The real @php-wasm packages need a browser WASM runtime. Swap them (and the
// IndexedDB-backed journal) for in-process stubs; node --test runs each test
// file in its own process, so these hooks stay local to this file.
const PRIVATE = Symbol("__private__dont__use");
const stub = {
  PRIVATE,
  calls: [],
  certificates: 0,
};
globalThis.__phpLoaderStub = stub;

const STUBS = {
  "@php-wasm/universal": `
    const s = globalThis.__phpLoaderStub;
    export const __private__dont__use = s.PRIVATE;
    export class PHP { constructor(id) { return s.createPhp(id); } }
    export async function setPhpIniEntries(php, entries) {
      s.calls.push(["ini", entries]);
    }`,
  "@php-wasm/web": `
    const s = globalThis.__phpLoaderStub;
    export async function generateCertificate(spec) {
      s.certificates += 1;
      s.calls.push(["certificate", spec]);
      return { certificate: "CERT" };
    }
    export function certificateToPEM(cert) { return "PEM:" + cert; }
    export async function loadWebRuntime(version, options) {
      s.calls.push(["loadWebRuntime", version, options]);
      return "runtime-" + version;
    }`,
  "./fs-persistence.js": `
    const s = globalThis.__phpLoaderStub;
    export async function clearJournal(scope) { s.calls.push(["clearJournal", scope]); }
    export function dropLegacyOpcacheJournals(version, identity) {
      s.calls.push(["dropLegacyOpcacheJournals", version, identity]);
    }
    export async function initFsPersistence(php, scope) {
      s.calls.push(["initFsPersistence", scope]);
      return { flushNow: async (options) => ({ ok: true, flushedOps: 3, options }) };
    }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = STUBS[specifier];
    if (
      source &&
      (specifier.startsWith("@") ||
        context.parentURL?.endsWith("/php-loader.js"))
    ) {
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { createPhpRuntime, OPCACHE_SAPI_NAME } = await import(
  "../src/runtime/php-loader.js"
);

function fakePhp(id) {
  const files = new Map();
  const dirs = [];
  return {
    id,
    files,
    dirs,
    sapi: null,
    async setSapiName(name) {
      this.sapi = name;
    },
    writeFile(path, data) {
      files.set(path, data);
    },
    [PRIVATE]: {
      FS: {
        mkdirTree(path) {
          dirs.push(path);
          // Exercise the "already exists" tolerance on every directory.
          throw new Error("EEXIST");
        },
      },
    },
  };
}

beforeEach(() => {
  stub.calls = [];
  stub.phps = [];
  stub.createPhp = (id) => {
    const php = fakePhp(id);
    stub.phps.push(php);
    return php;
  };
});

describe("createPhpRuntime", () => {
  it("rejects PHP calls and reports disabled persistence before refresh()", async () => {
    const runtime = createPhpRuntime(null);
    for (const method of [
      "request",
      "analyzePath",
      "mkdir",
      "writeFile",
      "readFile",
      "run",
    ]) {
      await assert.rejects(runtime[method](), /not initialized/u, method);
    }
    assert.equal(runtime.addEventListener(), undefined);
    assert.equal(runtime.removeEventListener(), undefined);
    assert.deepEqual(await runtime.flushPersistence(), {
      enabled: false,
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
  });

  it("boots the default PHP without OPcache SAPI or journaling", async () => {
    const runtime = createPhpRuntime(null);
    await runtime.refresh();

    const [php] = stub.phps;
    assert.equal(php.id, "runtime-8.3");
    assert.equal(php.sapi, null);
    const load = stub.calls.find(([kind]) => kind === "loadWebRuntime");
    assert.equal(load[1], "8.3");
    assert.deepEqual(load[2].tcpOverFetch, { CAroot: { certificate: "CERT" } });
    assert.deepEqual(load[2].emscriptenOptions, {
      INITIAL_MEMORY: 128 * 1024 * 1024,
      ALLOW_MEMORY_GROWTH: 1,
    });
    assert.equal(
      php.files.get("/internal/shared/playground-ca.pem"),
      "PEM:CERT\n",
    );
    assert.equal(
      php.files.get("/internal/shared/opcache-blacklist.txt"),
      "/internal/eval.php\n",
    );
    for (const dir of [
      "/tmp",
      "/www/facturascripts",
      "/persist",
      "/config",
      "/internal/shared/preload",
    ]) {
      assert.ok(php.dirs.includes(dir), dir);
    }
    assert.equal(
      stub.calls.find(([kind]) => kind === "ini")[1]["opcache.enable"],
      "1",
    );
    assert.equal(
      stub.calls.some(([kind]) => kind === "initFsPersistence"),
      false,
    );
    // The wrapped instance replaces the "not initialized" placeholders.
    assert.equal(runtime._php, php);
    assert.equal(typeof runtime.request, "function");
    assert.equal(
      (await runtime.flushPersistence()).enabled,
      false,
      "no scope means no journal",
    );
  });

  it("sets the OPcache SAPI, clears the journal on clean boot and flushes it", async () => {
    const runtime = createPhpRuntime(null, {
      phpVersion: "8.4",
      scopeId: "scope-1",
      coreIdentity: "core-abc",
      forceCleanBoot: true,
      phpCorsProxyUrl: "https://proxy.test/?",
      opcache: true,
    });
    await runtime.refresh();

    const [php] = stub.phps;
    assert.equal(php.sapi, OPCACHE_SAPI_NAME);
    const load = stub.calls.find(([kind]) => kind === "loadWebRuntime");
    assert.equal(load[1], "8.4");
    assert.equal(load[2].tcpOverFetch.corsProxyUrl, "https://proxy.test/?");
    assert.deepEqual(
      stub.calls
        .filter(([kind]) =>
          [
            "clearJournal",
            "dropLegacyOpcacheJournals",
            "initFsPersistence",
          ].includes(kind),
        )
        .map((call) => call.join(":")),
      [
        "clearJournal:scope-1",
        "dropLegacyOpcacheJournals:8.4:core-abc",
        "initFsPersistence:scope-1",
      ],
    );
    assert.deepEqual(await runtime.flushPersistence({ force: true }), {
      enabled: true,
      ok: true,
      flushedOps: 3,
      options: { force: true },
    });
  });

  it("keeps the journal on a normal boot and reuses the generated CA", async () => {
    const before = stub.certificates;
    const runtime = createPhpRuntime(null, {
      scopeId: "scope-2",
      corsProxyUrl: "https://cors.test/",
      appBaseUrl: "https://app.test/base/",
      webRoot: "/www/custom",
    });
    await runtime.refresh();
    assert.equal(stub.certificates, before, "CA generated once per worker");
    assert.equal(
      stub.calls.some(([kind]) => kind === "clearJournal"),
      false,
    );
    assert.equal(
      stub.calls.find(([kind]) => kind === "loadWebRuntime")[2].tcpOverFetch
        .corsProxyUrl,
      "https://cors.test/",
    );
    assert.equal(runtime.binary, stub.phps[0][PRIVATE]);
    assert.deepEqual(await runtime.flushPersistence(), {
      enabled: true,
      ok: true,
      flushedOps: 3,
      options: {},
    });
  });
});
