// Drives php-worker.js end to end through its message/bridge protocol. The PHP
// runtime (php-loader.js) and the FacturaScripts bootstrap (bootstrap.js) are
// replaced, for the worker only, by harness-controlled fakes; config, manifest,
// protocol and crash-recovery run for real against a stubbed fetch.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, describe, it } from "node:test";
import { PLAYGROUND_DB_PATH } from "../src/runtime/bootstrap-paths.js";

const bootstrapPathsUrl = new URL(
  "../src/runtime/bootstrap-paths.js",
  import.meta.url,
).href;
const dataModule = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS = {
  "./src/runtime/php-loader.js": dataModule(
    "export const createPhpRuntime = (...a) => globalThis.__workerHarness.createPhpRuntime(...a);",
  ),
  "./src/runtime/bootstrap.js": dataModule(
    `export { PLAYGROUND_DB_PATH } from ${JSON.stringify(bootstrapPathsUrl)};
     export const bootstrapFacturaScripts = (o) => globalThis.__workerHarness.bootstrap(o);
     export const startCoreArchivePrefetch = (o) => globalThis.__workerHarness.prefetch(o);`,
  ),
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/php-worker.js") && STUBS[specifier]) {
      return { url: STUBS[specifier], shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const CONFIG = {
  landingPath: "/landing",
  phpCorsProxyUrl: "https://proxy.test/?url=",
  opcache: true,
  runtimes: [
    { id: "php83", label: "PHP 8.3", phpVersion: "8.3" },
    { id: "php84", label: "PHP 8.4", phpVersionLabel: "8.4" },
  ],
};

const shell = [];
const responses = new Map();
const workerMessages = [];
const runtimes = [];
const bootstraps = [];
let bridge = null;
let nextId = 0;

// Per-test knobs read by the fakes.
const h = {
  manifest: { bundle: { sha256: "sha-1" } },
  refreshError: null,
  bootstrapError: null,
  bootstrapResult: { readyPath: "/ready" },
  handle: async () => new Response("ok"),
  serveStatic: () => null,
  run: async () => ({ text: "" }),
  flush: async () => ({ enabled: false, ok: true }),
  failBridgePost: null,
};

function createRawPhp() {
  const files = new Map([[PLAYGROUND_DB_PATH, new Uint8Array([1, 2, 3])]]);
  return {
    files,
    readFileAsBuffer(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    writeFile: (path, data) => files.set(path, data),
    mkdirTree() {},
    fileExists: () => false,
    isDir: () => false,
    listFiles: () => [],
  };
}

globalThis.__workerHarness = {
  createPhpRuntime(runtime, options) {
    const requests = [];
    const php = {
      runtime,
      options,
      requests,
      _php: createRawPhp(),
      async refresh() {
        if (h.refreshError) throw h.refreshError;
      },
      async request(request) {
        requests.push(request);
        return h.handle(request);
      },
      serveStatic: (path) => h.serveStatic(path),
      run: (code) => h.run(code),
      flushPersistence: (opts) => h.flush(opts),
    };
    runtimes.push(php);
    return php;
  },
  async bootstrap(options) {
    bootstraps.push(options);
    options.publish("Installing", 0.2);
    options.publish("Untimed step");
    if (h.bootstrapError) throw h.bootstrapError;
    return h.bootstrapResult;
  },
  prefetch({ onProgress }) {
    onProgress({ loaded: 5, total: 10, ratio: 0.5 });
    onProgress({});
    onProgress(undefined);
    // A failed prefetch must not surface as an unhandled rejection.
    return Promise.reject(new Error("prefetch failed"));
  },
};

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const originals = {};
before(async () => {
  for (const key of ["self", "BroadcastChannel", "fetch", "__APP_ROOT__"]) {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith("playground.config.json")) return json(CONFIG);
    if (pathname.includes("/assets/manifests/")) return json(h.manifest);
    return new Response("missing", { status: 404 });
  };
  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      this.closed = false;
      if (name.startsWith("facturascripts-playground-php:")) bridge = this;
    }
    postMessage(message) {
      if (this.name.startsWith("facturascripts-playground-shell:")) {
        shell.push({ channel: this.name, ...message });
        return;
      }
      if (h.failBridgePost?.(message)) throw new Error("bridge closed");
      responses.set(message.id, message);
    }
    close() {
      this.closed = true;
    }
  };
  const worker = new EventTarget();
  worker.location = new URL("https://example.test/php-worker.js?scope=boot");
  worker.postMessage = (message) => workerMessages.push(message);
  globalThis.self = worker;
  await import("../php-worker.js");
});

after(() => {
  hooks.deregister();
  delete globalThis.__workerHarness;
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function until(read, label) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispatch(target, data) {
  target.dispatchEvent(new MessageEvent("message", { data }));
}

function post(request, extra = {}) {
  const id = `req-${++nextId}`;
  dispatch(bridge, {
    kind: "http-request",
    id,
    request: { method: "GET", headers: {}, ...request },
    ...extra,
  });
  return id;
}

async function send(request, extra) {
  const id = post(request, extra);
  const message = await until(() => responses.get(id), id);
  return {
    ...message.response,
    text: new TextDecoder().decode(message.response.body),
  };
}

const shellSince = (mark) => shell.slice(mark);
const fatal = (message = "memory access out of bounds") => new Error(message);

// Sends successful requests until the worker has handled at least ten since the
// last rotation, the minimum before a crash may restart the runtime.
async function pump(count = 10) {
  const previous = h.handle;
  h.handle = async () => new Response("pump");
  const ids = Array.from({ length: count }, () =>
    post({ url: "https://example.test/pump" }),
  );
  await until(() => responses.get(ids.at(-1)), "pump");
  h.handle = previous;
}

// Fails the next PHP request with `error`, then lets later ones succeed.
function crashOnce(error) {
  let thrown = false;
  h.handle = async () => {
    if (thrown) return new Response("recovered");
    thrown = true;
    throw error;
  };
}

describe("php-worker request pipeline", () => {
  it("only accepts configure-blueprint from the host", () => {
    dispatch(globalThis.self, { kind: "unrelated" });
    dispatch(globalThis.self, null);
    assert.equal(workerMessages.length, 0);
    assert.equal(bridge, null);

    dispatch(globalThis.self, {
      kind: "configure-blueprint",
      runtimeParams: {
        scopeId: "s1",
        runtimeId: "php84",
        instanceId: "i1",
        coreVersion: "2025.5",
        opcacheParam: "0",
      },
      blueprint: { landingPage: "/bp-landing" },
      clean: true,
    });
    assert.deepEqual(workerMessages, [
      { kind: "worker-ready", scopeId: "s1", runtimeId: "php84" },
    ]);
    assert.equal(bridge.name, "facturascripts-playground-php:s1");
  });

  it("ignores bridge messages that are not HTTP requests", async () => {
    dispatch(bridge, { kind: "http-response", id: "x" });
    dispatch(bridge, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responses.size, 0);
    assert.equal(runtimes.length, 0, "no boot without a request");
  });

  it("boots on the first request and serves it through PHP", async () => {
    h.handle = async (request) =>
      new Response(`${request.method} ${new URL(request.url).pathname}`, {
        status: 201,
        statusText: "Created",
        headers: { "x-test": "yes" },
      });
    const response = await send({
      url: "https://example.test/index.php?token=secret",
      headers: { accept: "text/html" },
    });

    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");
    assert.equal(response.headers["x-test"], "yes");
    assert.equal(response.text, "GET /index.php");

    const [php] = runtimes;
    assert.equal(php.runtime.id, "php84");
    assert.equal(php.requests[0].headers.get("accept"), "text/html");
    assert.deepEqual(php.options, {
      appBaseUrl: "https://example.test/",
      coreIdentity: "sha-1",
      phpVersion: "8.4",
      scopeId: "s1",
      forceCleanBoot: true,
      phpCorsProxyUrl: "https://proxy.test/?url=",
      opcache: false,
    });

    const [boot] = bootstraps;
    assert.equal(boot.php, php);
    assert.equal(boot.clean, true);
    assert.equal(boot.coreVersion, "2025.5");
    assert.equal(boot.runtimeId, "php84");
    assert.deepEqual(boot.blueprint, { landingPage: "/bp-landing" });
    assert.ok(boot.corePrefetch instanceof Promise);

    const progress = shell.filter((m) => m.kind === "progress");
    assert.equal(progress[0].detail, "Resolving FacturaScripts 2025.5.");
    assert.ok(
      progress.some((m) => m.detail === "Downloading FacturaScripts core: 50%"),
    );
    const values = progress.map((m) => m.progress);
    assert.deepEqual(
      values,
      [...values].sort((a, b) => a - b),
      "progress never goes backward",
    );
    const ready = shell.find((m) => m.kind === "ready");
    assert.equal(ready.path, "/ready");
    assert.equal(ready.detail, "FacturaScripts bootstrapped for PHP 8.4.");
    assert.equal(ready.channel, "facturascripts-playground-shell:s1:i1");
  });

  it("does not restart after a crash in the first requests", async () => {
    // Fewer than ten requests have reached PHP since boot.
    const mark = shell.length;
    const bootsBefore = runtimes.length;
    crashOnce(fatal());
    const response = await send({ url: "https://example.test/early" });
    assert.equal(response.status, 500);
    // The early-crash guard declined, not the restart limit (#181).
    assert.doesNotMatch(response.text, /restart limit reached/);
    assert.match(
      response.text,
      /crashed after only \d requests \(minimum 10\)/,
    );
    const messages = shellSince(mark);
    assert.ok(
      messages.some((m) => m.detail.includes("[snapshot] saved DB (3 bytes)")),
      "the DB is snapshotted before deciding",
    );
    assert.ok(
      messages.some((m) =>
        /crashed after only \d requests \(minimum 10\)/.test(m.detail),
      ),
    );
    assert.equal(runtimes.length, bootsBefore, "no reboot was attempted");
  });

  it("forwards request bodies only for methods that carry one", async () => {
    const seen = [];
    h.handle = async (request) => {
      seen.push([request.method, await request.text()]);
      return new Response("ok");
    };
    await send({ method: "POST", url: "https://example.test/a", body: "x=1" });
    await send({ method: "POST", url: "https://example.test/b" });
    await send({ method: "HEAD", url: "https://example.test/c", body: "x" });
    assert.deepEqual(seen, [
      ["POST", "x=1"],
      ["POST", ""],
      ["HEAD", ""],
    ]);
  });

  it("serves existing static files without queueing behind PHP", async () => {
    const php = runtimes.at(-1);
    const before = php.requests.length;
    const asked = [];
    h.serveStatic = (path) => {
      asked.push(path);
      if (path === "/style.css") {
        return new Response("body{}", {
          headers: { "content-type": "text/css" },
        });
      }
      if (path === "/throws.css") throw new Error("ENOENT");
      if (path === "/broken.css") {
        return { arrayBuffer: () => Promise.reject(new Error("read")) };
      }
      return null;
    };
    h.handle = async () => new Response("from php");

    const css = await send({ url: "https://example.test/style.css?v=2" });
    assert.equal(css.text, "body{}");
    assert.equal(css.headers["content-type"], "text/css");
    assert.equal(php.requests.length, before, "PHP is not involved");

    const broken = await send({ url: "https://example.test/broken.css" });
    assert.equal(broken.status, 500);
    assert.match(broken.text, /Static fast-path failed\./);

    for (const path of ["/missing.css", "/throws.css"]) {
      const fallback = await send({ url: `https://example.test${path}` });
      assert.equal(fallback.text, "from php");
    }
    const posted = await send({
      method: "POST",
      url: "https://example.test/style.css",
    });
    assert.equal(posted.text, "from php");
    assert.deepEqual(asked, [
      "/style.css",
      "/broken.css",
      "/missing.css",
      "/throws.css",
    ]);
    h.serveStatic = () => null;
  });

  it("answers ordinary PHP errors with an escaped 500 page", async () => {
    const mark = shell.length;
    h.handle = async () => {
      throw new Error("<b>boom</b>");
    };
    const response = await send({ url: "https://example.test/x.php?sid=1" });
    assert.equal(response.status, 500);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.text, /&lt;b&gt;boom&lt;\/b&gt;/);
    assert.doesNotMatch(response.text, /<b>boom/);
    const [error] = shellSince(mark);
    assert.equal(error.kind, "error");
    assert.equal(error.path, "/x.php");
    assert.match(error.detail, /<b>boom<\/b>/);

    // An unparsable URL also fails as a plain request error.
    const invalid = await send({ url: "not a url" });
    assert.equal(invalid.status, 500);
  });

  it("keeps the queue alive when answering an error throws", async () => {
    const mark = shell.length;
    h.handle = async () => {
      throw new Error("first");
    };
    h.failBridgePost = () => true;
    post({ url: "https://example.test/lost" });
    const failure = await until(
      () =>
        shellSince(mark).find((m) =>
          m.detail.startsWith("[worker] request handler failed"),
        ),
      "handler failure",
    );
    assert.equal(
      failure.detail,
      "[worker] request handler failed: bridge closed",
    );
    h.failBridgePost = null;
    h.handle = async () => new Response("next");
    assert.equal(
      (await send({ url: "https://example.test/next" })).text,
      "next",
    );
  });

  it("captures phpinfo output and failures for the shell", async () => {
    const capture = async () => {
      const mark = shell.length;
      dispatch(globalThis.self, { kind: "capture-phpinfo" });
      return until(
        () => shellSince(mark).find((m) => m.kind === "phpinfo"),
        "phpinfo",
      );
    };
    const codes = [];
    h.run = async (code) => {
      codes.push(code);
      return { text: "<h1>PHP</h1>" };
    };
    const info = await capture();
    assert.equal(info.html, "<h1>PHP</h1>");
    assert.match(codes[0], /phpinfo\(\)/);

    h.run = async () => ({});
    assert.equal((await capture()).html, "");

    h.run = async () => {
      throw new Error("<no php>");
    };
    const failed = await capture();
    assert.match(failed.detail, /^Failed to capture PHP info: Error: <no php>/);
    assert.match(failed.html, /&lt;no php&gt;/);
  });

  it("flushes the persistence journal on request", async () => {
    const flush = async () => {
      const mark = shell.length;
      dispatch(globalThis.self, { kind: "flush-persistence" });
      return until(
        () => shellSince(mark).find((m) => m.kind === "persistence-flushed"),
        "flush",
      );
    };
    let calls = 0;
    h.flush = async () => {
      calls += 1;
      return { enabled: true, ok: true };
    };
    assert.equal((await flush()).detail, "Persistence journal flushed.");
    assert.equal(calls, 1);

    h.flush = async () => {
      throw new Error("quota");
    };
    assert.match(
      (await flush()).detail,
      /^Persistence flush failed: Error: quota/,
    );
    h.flush = async () => ({ enabled: true, ok: true, flushedOps: 2 });
  });

  it("rotates the runtime and replays an idempotent request", async () => {
    await pump();
    globalThis.__APP_ROOT__ = "https://app.test/base/";
    h.manifest = { release: "2025.6" };
    h.bootstrapResult = {};
    const mark = shell.length;
    const crashed = runtimes.at(-1);
    crashOnce(fatal("RuntimeError: unreachable"));

    const response = await send({ url: "https://example.test/replay" });
    assert.equal(response.status, 200);
    assert.equal(response.text, "recovered");

    const fresh = runtimes.at(-1);
    assert.notEqual(fresh, crashed);
    assert.equal(fresh.options.appBaseUrl, "https://app.test/base/");
    assert.equal(fresh.options.coreIdentity, "2025.6");
    assert.deepEqual(
      fresh._php.files.get(PLAYGROUND_DB_PATH),
      new Uint8Array([1, 2, 3]),
      "the crashed DB snapshot is restored onto the new runtime",
    );
    const messages = shellSince(mark);
    assert.ok(
      messages.some(
        (m) =>
          m.title === "Runtime rotation" &&
          m.detail.startsWith("[runtime] restart (") &&
          m.detail.includes("fatal WASM error: RuntimeError: unreachable"),
      ),
    );
    assert.ok(messages.some((m) => m.title === "Crash recovery"));
    assert.ok(
      messages.some(
        (m) => m.detail === "[snapshot] restored state onto fresh runtime",
      ),
    );
    assert.equal(
      messages.find((m) => m.kind === "ready").path,
      "/bp-landing",
      "falls back to the blueprint landing page",
    );
  });

  it("gives up when the replay crashes again", async () => {
    await pump();
    h.manifest = {};
    let calls = 0;
    h.handle = async () => {
      calls += 1;
      throw fatal();
    };
    const response = await send({ url: "https://example.test/twice" });
    assert.equal(calls, 2);
    assert.equal(response.status, 503);
    assert.match(response.text, /Runtime crashed again on retry/);
    assert.equal(runtimes.at(-1).options.coreIdentity, "2025.5");

    await pump();
    calls = 0;
    h.handle = async () => {
      calls += 1;
      throw calls === 1 ? fatal() : new Error("plain failure");
    };
    const second = await send({ url: "https://example.test/twice" });
    assert.equal(second.status, 503);
    assert.match(second.text, /plain failure/);
  });

  it("answers a request that already was a retry without replaying", async () => {
    await pump();
    let calls = 0;
    h.handle = async () => {
      calls += 1;
      throw fatal();
    };
    const response = await send(
      { url: "https://example.test/retried" },
      { _retried: true },
    );
    assert.equal(calls, 1);
    assert.equal(response.status, 503);
    assert.match(response.text, /Manual reload required/);
  });

  it("never replays a POST but boots the replacement runtime", async () => {
    await pump();
    const mark = shell.length;
    const bootsBefore = runtimes.length;
    h.bootstrapError = new Error("bootstrap broke");
    let calls = 0;
    h.handle = async () => {
      calls += 1;
      throw fatal();
    };
    const response = await send({
      method: "POST",
      url: "https://example.test/save",
      body: "a=1",
    });
    assert.equal(calls, 1, "the POST is not sent again");
    assert.equal(response.status, 503);
    assert.match(response.text, /Non-idempotent request was not retried/);
    await until(
      () =>
        shellSince(mark).find((m) =>
          m.detail.startsWith(
            "Runtime recovery failed: Error: bootstrap broke",
          ),
        ),
      "recovery failure",
    );
    assert.equal(runtimes.length, bootsBefore + 1);
    h.bootstrapError = null;
  });

  it("retries the boot after it fails before bootstrapping", async () => {
    // The failed bootstrap above cleared the runtime; this boot crashes in
    // php.refresh(), outside bootstrapFacturaScripts() (#181).
    h.refreshError = fatal("unreachable executed");
    const first = await send({ url: "https://example.test/boot-crash" });
    assert.equal(first.status, 500);

    // The failed boot is not cached: the very next request boots again.
    h.refreshError = null;
    h.handle = async () => new Response("booted");
    const recovered = await send({ url: "https://example.test/boot-crash" });
    assert.equal(recovered.text, "booted");
  });

  it("warns the shell about outbound network failures", async () => {
    await pump();
    const mark = shell.length;
    const networkError = Object.assign(new Error("connect failed"), {
      errno: 23,
    });
    crashOnce(networkError);
    const response = await send({ url: "https://example.test/dashboard?x=1" });
    assert.equal(response.text, "recovered");
    const warning = shellSince(mark).find(
      (m) => m.kind === "wasm-network-error",
    );
    assert.equal(warning.path, "/dashboard");
    assert.match(warning.detail, /^Page "\/dashboard" failed/);
  });

  it("flags a runtime that reaches the request high watermark", async () => {
    await pump(9);
    crashOnce(fatal());
    await send({ url: "https://example.test/rotate" });
    const mark = shell.length;
    await pump(1500);
    const trace = shellSince(mark).filter((m) =>
      m.detail.startsWith("[perf] Request count reached 1500."),
    );
    assert.equal(trace.length, 1);
  });

  it("stops rotating once the restart limit is reached", async () => {
    let limit = null;
    for (let i = 0; i < 25 && !limit; i += 1) {
      const mark = shell.length;
      await pump();
      crashOnce(fatal());
      const response = await send({ url: "https://example.test/loop" });
      limit = shellSince(mark).find((m) =>
        m.detail.includes("restart limit reached (20/20)"),
      );
      if (limit) {
        assert.equal(response.status, 500);
        assert.match(
          response.text,
          /Runtime restart limit reached \(20\/20\)\./,
        );
      }
    }
    assert.ok(limit, "the twentieth restart is the last one");
  });

  it("rebinds the bridge when configured again", async () => {
    const previous = bridge;
    dispatch(globalThis.self, { kind: "configure-blueprint" });
    assert.equal(previous.closed, true);
    assert.notEqual(bridge, previous);
    assert.deepEqual(workerMessages.at(-1), {
      kind: "worker-ready",
      scopeId: "s1",
      runtimeId: "php84",
    });

    dispatch(globalThis.self, {
      kind: "configure-blueprint",
      runtimeParams: { scopeId: "s2", runtimeId: "php83", instanceId: null },
    });
    assert.equal(bridge.name, "facturascripts-playground-php:s2");
    h.handle = async () => new Response("still served");
    assert.equal(
      (await send({ url: "https://example.test/after" })).text,
      "still served",
    );
  });
});
