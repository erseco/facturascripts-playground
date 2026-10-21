// Boot/crash error handling of php-worker.js (#181). The PHP runtime and the
// FacturaScripts bootstrap are replaced, for the worker only, by fakes; config,
// manifest and crash-recovery run for real against a stubbed fetch.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, describe, it } from "node:test";

const pathsUrl = new URL("../src/runtime/bootstrap-paths.js", import.meta.url)
  .href;
const dataModule = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS = {
  "./src/runtime/php-loader.js": dataModule(
    "export const createPhpRuntime = () => globalThis.__bootHarness.createPhp();",
  ),
  "./src/runtime/bootstrap.js": dataModule(
    `export { PLAYGROUND_DB_PATH } from ${JSON.stringify(pathsUrl)};
     export const bootstrapFacturaScripts = async () => ({ readyPath: "/" });
     export const startCoreArchivePrefetch = () => Promise.resolve();`,
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

const CONFIG = { landingPath: "/", runtimes: [{ id: "php83", label: "PHP" }] };
const responses = new Map();
let bridge = null;
let nextId = 0;
const h = { refreshFailures: 0, handle: async () => new Response("ok") };

globalThis.__bootHarness = {
  createPhp: () => ({
    _php: null,
    async refresh() {
      if (h.refreshFailures > 0) {
        h.refreshFailures -= 1;
        throw new Error("transient refresh failure");
      }
    },
    request: (request) => h.handle(request),
  }),
};

const originals = {};
before(async () => {
  for (const key of ["self", "BroadcastChannel", "fetch"]) {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (url) =>
    String(url).includes("playground.config.json")
      ? json(CONFIG)
      : json({ release: "test" });
  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      if (name.startsWith("facturascripts-playground-php:")) bridge = this;
    }
    postMessage(message) {
      if (message?.kind === "http-response") responses.set(message.id, message);
    }
    close() {}
  };
  const worker = new EventTarget();
  worker.location = new URL("https://example.test/php-worker.js?scope=boot");
  worker.postMessage = () => {};
  globalThis.self = worker;
  await import("../php-worker.js");
  worker.dispatchEvent(
    new MessageEvent("message", {
      data: {
        kind: "configure-blueprint",
        runtimeParams: { scopeId: "s", runtimeId: "php83", instanceId: "i" },
      },
    }),
  );
});

after(() => {
  hooks.deregister();
  delete globalThis.__bootHarness;
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

async function send() {
  const id = `req-${++nextId}`;
  bridge.dispatchEvent(
    new MessageEvent("message", {
      data: {
        kind: "http-request",
        id,
        request: { method: "GET", url: "https://example.test/", headers: {} },
      },
    }),
  );
  const deadline = Date.now() + 5000;
  while (!responses.has(id)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const { response } = responses.get(id);
  return {
    status: response.status,
    text: new TextDecoder().decode(response.body),
  };
}

// Fails every PHP request with a fatal WASM error.
const crashing = async () => {
  throw new Error("memory access out of bounds");
};

describe("php-worker boot recovery (#181)", () => {
  it("retries the boot after a failure outside bootstrapFacturaScripts", async () => {
    h.refreshFailures = 1;
    const failed = await send();
    assert.equal(failed.status, 500);
    assert.match(failed.text, /transient refresh failure/);

    const recovered = await send();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.text, "ok");
  });

  it("says the crash came too early, not that the restart limit was reached", async () => {
    h.handle = crashing;
    const response = await send();
    h.handle = async () => new Response("ok");
    assert.equal(response.status, 500);
    assert.doesNotMatch(response.text, /restart limit reached/);
    assert.match(response.text, /only \d+ requests \(minimum 10\)/);
  });

  it("reports the restart limit once MAX_REACTIVE_RESTARTS rotations happened", async () => {
    // Each rotation needs 10 requests since the previous one; a crash on the
    // 10th rotates the runtime and replays the GET on the fresh one.
    for (let restart = 0; restart < 20; restart += 1) {
      for (let i = 0; i < 9; i += 1) await send();
      let crashed = false;
      h.handle = async () => {
        if (crashed) return new Response("ok");
        crashed = true;
        throw new Error("memory access out of bounds");
      };
      assert.equal((await send()).status, 200);
      h.handle = async () => new Response("ok");
    }
    for (let i = 0; i < 10; i += 1) await send();

    h.handle = crashing;
    const response = await send();
    h.handle = async () => new Response("ok");
    assert.equal(response.status, 500);
    assert.match(response.text, /Runtime restart limit reached/);
  });
});
