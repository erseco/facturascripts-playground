import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";
import {
  bootstrapFacturaScripts,
  FS_ROOT,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_DB_PATH,
  startCoreArchivePrefetch,
} from "../src/runtime/bootstrap.js";

const decoder = new TextDecoder();
const BUNDLE = gzipSync(
  createUstarTar(normalizeEntries({ "index.php": "<?php echo 'core';" })),
);
const MANIFEST = {
  release: "2025.1",
  generatedAt: "2026-01-01T00:00:00Z",
  bundle: { path: "core.tar.gz", codec: "gzip", fileCount: 1 },
};
const CONFIG = {
  bundleVersion: "test",
  locale: "es_ES",
  timezone: "Europe/Madrid",
  autologin: true,
  resetOnVersionMismatch: true,
  admin: { username: "admin", password: "admin", email: "a@example.com" },
};

const json = (body) => new Response(JSON.stringify(body));

// In-memory stand-in for the wrapped PHP instance: a file map plus a request
// router keyed on the script path.
function createFakePhp(routes = {}) {
  const files = new Map();
  const dirs = new Set();
  const php = {
    files,
    dirs,
    requests: [],
    unlinked: [],
    cookies: {},
    async analyzePath(path) {
      return { exists: files.has(path) || dirs.has(path) };
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async readFile(path) {
      return files.get(path);
    },
    async unlink(path) {
      php.unlinked.push(path);
      files.delete(path);
    },
    setCookie(name, value) {
      php.cookies[name] = value;
    },
    async request(request) {
      const path = new URL(request.url).pathname;
      php.requests.push(path);
      const route = new Map(Object.entries(routes)).get(path);
      if (route) return route();
      if (path === "/_playground_install.php")
        return new Response("INSTALL_OK");
      if (path === "/_playground_wizard.php") return json({ ok: true });
      if (path === "/_playground_autologin.php")
        return json({ ok: true, nick: "admin", logkey: "k3y" });
      return json({ ok: true });
    },
    _php: {
      mkdirTree: (path) => dirs.add(path),
      writeFile: (path, data) => files.set(path, data),
    },
  };
  return php;
}

const text = (php, path) => decoder.decode(php.files.get(path));

function run(php, overrides = {}) {
  const messages = [];
  const promise = bootstrapFacturaScripts({
    config: CONFIG,
    php,
    publish: (message) => messages.push(message),
    runtimeId: "php83",
    corePrefetch: Promise.resolve({ manifest: MANIFEST, bytes: BUNDLE }),
    ...overrides,
  });
  return promise.then((result) => ({ result, messages }));
}

describe("bootstrapFacturaScripts", () => {
  let originalFetch;
  let fetched;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      if (String(url).endsWith(".json")) return json(MANIFEST);
      return new Response(BUNDLE);
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("installs a fresh site: core, config, deploy, wizard, state and autologin", async () => {
    const php = createFakePhp();
    const { result, messages } = await run(php, { corePrefetch: null });

    assert.equal(result.readyPath, "/");
    assert.equal(fetched.length, 2, "manifest and bundle fetched lazily");
    assert.match(fetched[0], /assets\/manifests\/latest\.json$/);
    assert.equal(text(php, `${FS_ROOT}/index.php`), "<?php echo 'core';");
    assert.ok(php.dirs.has(`${FS_ROOT}/Dinamic/XMLView`));
    assert.ok(php.dirs.has("/persist/mutable/session"));

    const configPhp = text(php, `${FS_ROOT}/config.php`);
    assert.match(configPhp, /define\('FS_LANG', 'es_ES'\);/);
    assert.ok(configPhp.includes(`FS_DB_NAME', '${PLAYGROUND_DB_PATH}'`));
    const ini = text(php, "/php.ini");
    assert.match(ini, /date\.timezone = Europe\/Madrid/);
    assert.match(ini, /display_errors = Off/);

    assert.deepEqual(php.requests, [
      "/_playground_install.php",
      "/",
      "/_playground_wizard.php",
      "/_playground_init_models.php",
      "/_playground_autologin.php",
    ]);
    for (const script of ["install", "wizard", "init_models", "autologin"]) {
      assert.ok(php.unlinked.includes(`${FS_ROOT}/_playground_${script}.php`));
      assert.ok(!php.files.has(`${FS_ROOT}/_playground_${script}.php`));
    }

    const state = JSON.parse(text(php, PLAYGROUND_CONFIG_PATH));
    assert.equal(state.manifestVersion, "2025.1:");
    assert.equal(state.runtimeId, "php83");
    assert.deepEqual(state.admin, { username: "admin" });
    assert.deepEqual(php.cookies, { fsNick: "admin", fsLogkey: "k3y" });
    assert.ok(messages.includes("Autologin successful."));
    assert.equal(messages.at(-1), "FacturaScripts is ready.");
  });

  it("fetches a versioned manifest when a core version is requested", async () => {
    await run(createFakePhp(), { corePrefetch: null, coreVersion: "v 1" });
    assert.match(fetched[0], /assets\/manifests\/v%201\.json$/);
  });

  it("skips first-run setup when the persisted state matches the manifest", async () => {
    const php = createFakePhp();
    await run(php);
    php.requests.length = 0;
    const { messages } = await run(php);
    assert.ok(!php.requests.includes("/"));
    assert.ok(!php.requests.includes("/_playground_wizard.php"));
    assert.ok(
      messages.includes(
        "Persistent database matches current version. Skipping table creation.",
      ),
    );
    assert.equal(fetched.length, 0, "prefetched archive reused");
  });

  it("wipes the database and state on a clean boot", async () => {
    const php = createFakePhp();
    await run(php);
    php.files.set(PLAYGROUND_DB_PATH, new Uint8Array([1]));
    const { messages } = await run(php, { clean: true });
    assert.ok(messages.includes("Cleaning previous state."));
    assert.ok(php.unlinked.includes(PLAYGROUND_DB_PATH));
    assert.ok(php.unlinked.includes(PLAYGROUND_CONFIG_PATH));
    assert.ok(php.requests.includes("/_playground_wizard.php"));
  });

  it("resets on a manifest version mismatch only when configured to", async () => {
    const stale = () => {
      const php = createFakePhp();
      php.files.set(
        PLAYGROUND_CONFIG_PATH,
        new TextEncoder().encode(JSON.stringify({ manifestVersion: "old:" })),
      );
      return php;
    };
    const resetting = await run(stale());
    assert.ok(resetting.messages.includes("Cleaning previous state."));

    const keeping = await run(stale(), {
      config: { ...CONFIG, resetOnVersionMismatch: false },
    });
    assert.ok(!keeping.messages.includes("Cleaning previous state."));
  });

  it("honours the blueprint landing page and debug flag", async () => {
    const php = createFakePhp();
    const { result } = await run(php, {
      blueprint: { landingPage: "/ListCliente", debug: { enabled: true } },
    });
    assert.equal(result.readyPath, "/ListCliente");
    assert.match(text(php, "/php.ini"), /display_errors = On/);
  });

  it("fails loudly when the deploy script does not confirm success", async () => {
    const php = createFakePhp({
      "/_playground_install.php": () => new Response("Fatal error: boom"),
    });
    await assert.rejects(
      run(php),
      /FacturaScripts deploy failed:\nFatal error: boom/,
    );
    assert.ok(php.unlinked.includes(`${FS_ROOT}/_playground_install.php`));
  });

  it("fails when the first-run request returns a server error", async () => {
    const php = createFakePhp({
      "/": () => new Response("oops", { status: 503 }),
    });
    await assert.rejects(run(php), /First-run request returned 503:\noops/);
  });

  it("reports a wizard that answers ok:false", async () => {
    const php = createFakePhp({
      "/_playground_wizard.php": () => json({ ok: false, error: "no company" }),
    });
    await assert.rejects(
      run(php),
      /Wizard initialization failed: .*no company/,
    );
    assert.ok(!php.files.has(PLAYGROUND_CONFIG_PATH), "no state saved");
  });

  it("reports a wizard that answers with non-JSON output", async () => {
    const php = createFakePhp({
      "/_playground_wizard.php": () => new Response("<b>Warning</b>"),
    });
    await assert.rejects(
      run(php),
      /Wizard script returned unexpected output:\n<b>Warning<\/b>/,
    );
  });

  it("publishes a warning when autologin cannot find the user", async () => {
    const php = createFakePhp({
      "/_playground_autologin.php": () =>
        json({ ok: false, error: "user not found" }),
    });
    const { messages } = await run(php);
    assert.ok(messages.includes("[warning] Autologin failed: user not found"));
    assert.deepEqual(php.cookies, {});
  });

  it("publishes a warning when autologin output is not JSON", async () => {
    const php = createFakePhp({
      "/_playground_autologin.php": () => new Response("PHP Notice"),
    });
    const { messages } = await run(php);
    assert.ok(
      messages.includes(
        "[warning] Autologin script returned unexpected output: PHP Notice",
      ),
    );
  });

  it("does not sign in when autologin is disabled", async () => {
    const php = createFakePhp();
    await run(php, { config: { ...CONFIG, autologin: false } });
    assert.ok(!php.requests.includes("/_playground_autologin.php"));
  });

  it("tolerates unlink and mkdir failures for temporary scripts", async () => {
    const php = createFakePhp();
    php.unlink = async () => {
      throw new Error("EBUSY");
    };
    php.mkdir = async () => {
      throw new Error("EEXIST");
    };
    const { result } = await run(php);
    assert.equal(result.readyPath, "/");
    assert.ok(php.files.has(`${FS_ROOT}/_playground_install.php`));
  });
});

describe("startCoreArchivePrefetch", () => {
  let originalFetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("downloads the bundle for a provided manifest and reports progress", async () => {
    originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(BUNDLE);
    };
    const progress = [];
    const manifest = {
      ...MANIFEST,
      _manifestUrl: "https://x.test/m/latest.json",
    };
    const result = await startCoreArchivePrefetch({
      manifest,
      onProgress: (p) => progress.push(p.ratio),
    });
    assert.equal(result.manifest, manifest);
    assert.deepEqual([...result.bytes], [...BUNDLE]);
    assert.deepEqual(urls, ["https://x.test/m/core.tar.gz"]);
    assert.deepEqual(progress, [1]);
  });

  it("fetches the manifest itself when none is given", async () => {
    originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return String(url).endsWith(".json")
        ? json(MANIFEST)
        : new Response(BUNDLE);
    };
    const result = await startCoreArchivePrefetch();
    assert.equal(result.manifest.release, "2025.1");
    assert.match(urls[0], /assets\/manifests\/latest\.json$/);
    assert.match(urls[1], /assets\/manifests\/core\.tar\.gz$/);
  });
});
