// Drives sw.js through fake Service Worker globals: the module registers its
// install/activate/message/fetch listeners on a stub `self`, and each scenario
// dispatches synthetic events and asserts the resulting Response, cache and
// PHP-bridge traffic. A fresh module instance per scenario resets sw.js state.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import { PHP_BRIDGE_CHANNEL_PREFIX } from "../src/shared/protocol.js";

const ORIGIN = "https://app.test";
const SW_URL = new URL("../sw.js", import.meta.url).href;
let importCounter = 0;

const harness = {
  listeners: new Map(),
  fetchCalls: [],
  fetchImpl: async () => new Response("network"),
  stores: new Map(),
  deleted: [],
  clients: [],
  posted: [],
  bridgePosts: [],
  bridgeReply: null,
  timers: [],
  claimed: 0,
  skipped: 0,
  cachesOpenError: null,
  channels: [],
};

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.handlers = [];
    harness.channels.push(this);
  }
  addEventListener(type, handler) {
    if (type === "message") this.handlers.push(handler);
  }
  postMessage(message) {
    harness.bridgePosts.push({ channel: this.name, message });
    const reply = harness.bridgeReply?.(message);
    if (reply) {
      queueMicrotask(() => {
        for (const handler of this.handlers) handler({ data: reply });
      });
    }
  }
  deliver(data) {
    for (const handler of this.handlers) handler({ data });
  }
}

function cacheKey(request) {
  return typeof request === "string" ? request : request.url;
}

function openStore(name) {
  if (!harness.stores.has(name)) harness.stores.set(name, new Map());
  const store = harness.stores.get(name);
  return {
    match: async (request) => store.get(cacheKey(request))?.clone(),
    put: async (request, response) => {
      store.set(cacheKey(request), response);
    },
  };
}

globalThis.BroadcastChannel = FakeBroadcastChannel;
globalThis.caches = {
  open: async (name) => {
    if (harness.cachesOpenError) throw harness.cachesOpenError;
    return openStore(name);
  },
  keys: async () => [...harness.stores.keys()],
  delete: async (name) => {
    harness.deleted.push(name);
    return harness.stores.delete(name);
  },
};
globalThis.fetch = async (input, init) => {
  harness.fetchCalls.push({ input, init });
  return harness.fetchImpl(input, init);
};

function installSelf(scope) {
  globalThis.self = {
    registration: { scope },
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => harness.listeners.set(type, handler),
    skipWaiting: async () => {
      harness.skipped += 1;
    },
    setTimeout: (callback, delay) => {
      harness.timers.push({ callback, delay });
      return harness.timers.length;
    },
    clients: {
      matchAll: async () =>
        harness.clients.map((client) => ({
          ...client,
          postMessage: (message) => harness.posted.push(message),
        })),
      get: async (id) => harness.clients.find((client) => client.id === id),
      claim: async () => {
        harness.claimed += 1;
      },
    },
  };
}

async function loadServiceWorker(scope = `${ORIGIN}/`) {
  harness.listeners = new Map();
  installSelf(scope);
  importCounter += 1;
  await import(`${SW_URL}?n=${importCounter}`);
}

function makeRequest(url, { mode, referrer, ...init } = {}) {
  const request = new Request(url, init);
  if (mode) Object.defineProperty(request, "mode", { value: mode });
  Object.defineProperty(request, "referrer", { value: referrer || "" });
  return request;
}

async function dispatchFetch(request, { clientId = "" } = {}) {
  let responded = null;
  harness.listeners.get("fetch")({
    request,
    clientId,
    respondWith: (promise) => {
      responded = promise;
    },
  });
  return responded;
}

function lastBridgeRequest() {
  return harness.bridgePosts.at(-1).message.request;
}

function replyWith(response) {
  harness.bridgeReply = (message) => ({
    kind: "http-response",
    id: message.id,
    response,
  });
}

beforeEach(() => {
  harness.fetchCalls = [];
  harness.fetchImpl = async () => new Response("network");
  harness.stores = new Map();
  harness.deleted = [];
  harness.clients = [];
  harness.posted = [];
  harness.bridgePosts = [];
  harness.bridgeReply = null;
  harness.timers = [];
  harness.claimed = 0;
  harness.skipped = 0;
  harness.cachesOpenError = null;
  harness.channels = [];
});

describe("sw.js lifecycle", () => {
  it("skips waiting on install", async () => {
    await loadServiceWorker();
    let waited;
    harness.listeners.get("install")({ waitUntil: (p) => (waited = p) });
    await waited;
    assert.equal(harness.skipped, 1);
  });

  it("drops caches from older builds on activate and claims clients", async () => {
    await loadServiceWorker();
    for (const name of [
      `fs-dist-${BUILD_VERSION}`,
      "fs-dist-old",
      `fs-static-assets-${BUILD_VERSION}`,
      "fs-static-assets-v1",
      "unrelated",
    ]) {
      harness.stores.set(name, new Map());
    }
    let waited;
    harness.listeners.get("activate")({ waitUntil: (p) => (waited = p) });
    await waited;
    assert.deepEqual(harness.deleted.sort(), [
      "fs-dist-old",
      "fs-static-assets-v1",
    ]);
    assert.equal(harness.claimed, 1);
  });

  it("clears the page-asset cache on request", async () => {
    await loadServiceWorker();
    harness.listeners.get("message")({ data: { kind: "clear-static-cache" } });
    await Promise.resolve();
    assert.deepEqual(harness.deleted, [`fs-static-assets-${BUILD_VERSION}`]);
  });

  it("ignores unrelated messages", async () => {
    await loadServiceWorker();
    harness.listeners.get("message")({ data: { kind: "other" } });
    harness.listeners.get("message")({ data: null });
    assert.deepEqual(harness.deleted, []);
  });
});

describe("sw.js request routing", () => {
  it("leaves cross-origin requests to the browser", async () => {
    await loadServiceWorker();
    const responded = await dispatchFetch(makeRequest("https://other.test/x"));
    assert.equal(responded, null);
  });

  it("passes unscoped static files to the network", async () => {
    await loadServiceWorker();
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/src/shell/main.js`),
    );
    assert.equal(await response.text(), "network");
    assert.equal(harness.fetchCalls.length, 1);
    assert.equal(harness.bridgePosts.length, 0);
  });

  it("passes an unknown path with no scoped context to the network", async () => {
    await loadServiceWorker();
    const response = await dispatchFetch(makeRequest(`${ORIGIN}/other`));
    assert.equal(await response.text(), "network");
  });

  it("forwards a scoped GET to the PHP worker and rewrites the HTML", async () => {
    await loadServiceWorker();
    replyWith({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html", "content-length": "99" },
      body:
        '<html><head lang="es"><title>t</title></head>' +
        '<a href="/EditCliente?code=1&amp;x=2">c</a>' +
        '<a href="#top">t</a><a href="javascript:void(0)">j</a>' +
        '<a href="mailto:a@b.c">m</a><a href="//cdn.test/x.js">p</a>' +
        '<img src="https://other.test/i.png"><img src="">' +
        '<form action="/playground/s1/php83/Login"></form>' +
        '<tr data-href="&#x2F;ListProducto&#47;"></tr>' +
        '<a href="#&#34; onclick=&#39;x&#39;">x</a>' +
        '<a href="http://[bad">u</a>',
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/Dashboard?tab=1`),
    );
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), null);
    assert.match(
      html,
      /<head lang="es"><script>try\{Object\.defineProperty\(window,"parent"/u,
    );
    assert.ok(
      html.includes('href="/playground/s1/php83/EditCliente?code=1&amp;x=2"'),
    );
    assert.ok(html.includes('href="#top"'));
    assert.ok(html.includes('href="javascript:void(0)"'));
    assert.ok(html.includes('href="mailto:a@b.c"'));
    assert.ok(html.includes('href="//cdn.test/x.js"'));
    assert.ok(html.includes('src="https://other.test/i.png"'));
    assert.ok(html.includes('src=""'));
    assert.ok(html.includes('action="/playground/s1/php83/Login"'));
    assert.ok(html.includes('data-href="/playground/s1/php83/ListProducto/"'));
    // A decoded quote is re-escaped so it cannot close the attribute.
    assert.ok(html.includes('href="#&quot; onclick=&#39;x&#39;"'));
    assert.ok(!html.includes('" onclick'));
    // An unparsable URL is left as written.
    assert.ok(html.includes('href="http://[bad"'));

    const bridge = harness.bridgePosts.at(-1);
    assert.equal(bridge.channel, `${PHP_BRIDGE_CHANNEL_PREFIX}:s1`);
    assert.equal(bridge.message.kind, "http-request");
    assert.equal(lastBridgeRequest().url, `${ORIGIN}/Dashboard?tab=1`);
    assert.equal(lastBridgeRequest().method, "GET");
    assert.equal(lastBridgeRequest().body, null);
    assert.equal(harness.timers[0].delay, 180000);
  });

  it("decodes attribute entities once and escapes them once", async () => {
    await loadServiceWorker();
    replyWith({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      body:
        '<a href="/ListCliente?q=&lt;b&gt;">s</a>' +
        '<a href="https://other.test/?q=&lt;b&gt;">o</a>' +
        '<tr data-href="#&amp;lt;x&amp;gt;"></tr>' +
        '<a href="#&amp;quot;">q</a>',
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/Dashboard`),
    );
    const html = await response.text();
    assert.ok(
      html.includes('href="/playground/s1/php83/ListCliente?q=%3Cb%3E"'),
    );
    assert.ok(html.includes('href="https://other.test/?q=&lt;b&gt;"'));
    // An escaped "&" stays one literal "&": its text is not decoded again.
    assert.ok(html.includes('data-href="#&amp;lt;x&amp;gt;"'));
    assert.ok(html.includes('href="#&amp;quot;"'));
  });

  it("leaves same-origin blob: URLs as written", async () => {
    // A blob: URL carries the page origin, but its pathname is the inner URL
    // ("https://…/id"), not a path, so it must not be scoped.
    await loadServiceWorker();
    replyWith({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      body: `<img src="blob:${ORIGIN}/0c1f-id"><a href="/Doc">d</a>`,
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/Dashboard`),
    );
    const html = await response.text();
    assert.ok(html.includes(`src="blob:${ORIGIN}/0c1f-id"`));
    assert.ok(html.includes('href="/playground/s1/php83/Doc"'));
  });

  it("forwards a buffered POST body and rewrites same-origin redirects", async () => {
    await loadServiceWorker();
    replyWith({
      status: 302,
      statusText: "Found",
      headers: { location: "/ListCliente?a=1#h" },
      body: null,
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/EditCliente`, {
        method: "POST",
        body: "name=ACME",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "/playground/s1/php83/ListCliente?a=1#h",
    );
    const forwarded = lastBridgeRequest();
    assert.equal(forwarded.method, "POST");
    assert.equal(new TextDecoder().decode(forwarded.body), "name=ACME");
    assert.equal(
      forwarded.headers["content-type"],
      "application/x-www-form-urlencoded",
    );
  });

  it("leaves cross-origin redirects and non-HTML bodies untouched", async () => {
    await loadServiceWorker();
    replyWith({
      status: 302,
      statusText: "Found",
      headers: {
        location: "https://other.test/x",
        "content-type": "text/plain",
      },
      body: '<a href="/x">',
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/go`),
    );
    assert.equal(response.headers.get("location"), "https://other.test/x");
    assert.equal(await response.text(), '<a href="/x">');
  });

  it("turns a PHP worker error message into an HTML error page", async () => {
    await loadServiceWorker();
    harness.bridgeReply = (message) => ({
      kind: "http-error",
      id: message.id,
      error: "boom <b>",
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/`),
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /<pre>boom &lt;b&gt;<\/pre>/u);
  });

  it("falls back to a generic error when the worker gives no detail", async () => {
    await loadServiceWorker();
    harness.bridgeReply = (message) => ({ kind: "http-error", id: message.id });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/`),
    );
    assert.match(await response.text(), /Unknown PHP worker error\./u);
  });

  it("answers 504 when the PHP worker bridge times out", async () => {
    await loadServiceWorker();
    const pendingResponse = dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/slow`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    harness.timers[0].callback();
    const response = await pendingResponse;
    assert.equal(response.status, 504);
    assert.match(await response.text(), /bridge timed out/u);
  });

  it("ignores bridge messages for unknown or missing request ids", async () => {
    await loadServiceWorker();
    replyWith({ status: 200, statusText: "OK", headers: {}, body: "ok" });
    const first = await dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/a`),
    );
    assert.equal(await first.text(), "ok");
    // The channel is reused per scope; stray replies must be ignored.
    harness.bridgeReply = null;
    const pendingResponse = dispatchFetch(
      makeRequest(`${ORIGIN}/playground/s1/php83/b`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.channels.length, 1);
    harness.channels[0].deliver({ id: "unknown", kind: "http-response" });
    harness.channels[0].deliver(null);
    harness.timers.at(-1).callback();
    assert.equal((await pendingResponse).status, 504);
  });

  it("redirects an unscoped navigation from a scoped referrer", async () => {
    await loadServiceWorker();
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/ListCliente?x=1`, {
        mode: "navigate",
        referrer: `${ORIGIN}/playground/s2/php84/Dashboard`,
      }),
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      `${ORIGIN}/playground/s2/php84/ListCliente?x=1`,
    );
  });

  it("ignores a cross-origin referrer", async () => {
    await loadServiceWorker();
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/ListCliente`, {
        referrer: "https://other.test/playground/s2/php84/",
      }),
    );
    assert.equal(await response.text(), "network");
  });

  it("scopes unscoped subresources through the requesting client", async () => {
    await loadServiceWorker();
    harness.clients = [
      { id: "c1", url: `${ORIGIN}/playground/s3/php83/Dashboard` },
    ];
    replyWith({ status: 200, statusText: "OK", headers: {}, body: "js" });
    const response = await dispatchFetch(makeRequest(`${ORIGIN}/api/x?y=1`), {
      clientId: "c1",
    });
    assert.equal(await response.text(), "js");
    assert.equal(lastBridgeRequest().url, `${ORIGIN}/api/x?y=1`);
    assert.equal(harness.bridgePosts.at(-1).channel.endsWith(":s3"), true);
    assert.deepEqual(harness.posted.at(-1), {
      kind: "sw-debug",
      detail: "[sw-bridge] → worker: GET /api/x?y=1",
    });

    // The client context is remembered even after the client disappears.
    harness.clients = [];
    await dispatchFetch(makeRequest(`${ORIGIN}/api/z`), { clientId: "c1" });
    assert.equal(lastBridgeRequest().url, `${ORIGIN}/api/z`);
  });

  it("does not scope requests from unscoped or foreign clients", async () => {
    await loadServiceWorker();
    harness.clients = [
      { id: "plain", url: `${ORIGIN}/index.html` },
      { id: "foreign", url: "https://other.test/playground/s/r/" },
    ];
    for (const clientId of ["plain", "foreign", "missing"]) {
      const response = await dispatchFetch(makeRequest(`${ORIGIN}/api/x`), {
        clientId,
      });
      assert.equal(await response.text(), "network");
    }
    assert.equal(harness.bridgePosts.length, 0);
  });
});

describe("sw.js static asset cache", () => {
  it("serves a cached static asset and stores fresh ones", async () => {
    await loadServiceWorker();
    harness.clients = [{ id: "shell", url: `${ORIGIN}/index.html` }];
    replyWith({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/css" },
      body: "body{}",
    });
    const url = `${ORIGIN}/playground/s1/php83/Core/Assets/app.css`;
    const fresh = await dispatchFetch(makeRequest(url));
    assert.equal(await fresh.text(), "body{}");
    await Promise.resolve();
    const store = harness.stores.get(`fs-static-assets-${BUILD_VERSION}`);
    assert.ok(store.has(url));
    assert.match(harness.posted.at(-1).detail, /cache miss → worker/u);

    const postsBefore = harness.bridgePosts.length;
    const cached = await dispatchFetch(makeRequest(url));
    assert.equal(await cached.text(), "body{}");
    assert.equal(harness.bridgePosts.length, postsBefore);
  });

  it("does not cache uncacheable static responses", async () => {
    await loadServiceWorker();
    replyWith({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/css", "cache-control": "no-store" },
      body: "x",
    });
    await dispatchFetch(makeRequest(`${ORIGIN}/playground/s1/php83/a.css`));
    await Promise.resolve();
    assert.equal(
      harness.stores.get(`fs-static-assets-${BUILD_VERSION}`).size,
      0,
    );
  });
});

describe("sw.js dist cache", () => {
  it("serves runtime wasm cache-first and stores 200 responses", async () => {
    await loadServiceWorker();
    harness.fetchImpl = async () => new Response("wasm", { status: 200 });
    const url = `${ORIGIN}/dist/php_8_3.wasm`;
    assert.equal(await (await dispatchFetch(makeRequest(url))).text(), "wasm");
    await Promise.resolve();
    const cached = await dispatchFetch(makeRequest(url));
    assert.equal(await cached.text(), "wasm");
    assert.equal(harness.fetchCalls.length, 1);
  });

  it("does not store partial responses", async () => {
    await loadServiceWorker();
    harness.fetchImpl = async () => new Response("part", { status: 206 });
    await dispatchFetch(makeRequest(`${ORIGIN}/dist/intl.so`));
    assert.equal(harness.stores.get(`fs-dist-${BUILD_VERSION}`).size, 0);
  });

  it("falls back to the network when the cache cannot open", async () => {
    await loadServiceWorker();
    harness.cachesOpenError = new Error("denied");
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/dist/php.wasm`),
    );
    assert.equal(await response.text(), "network");
  });

  it("passes range requests through without caching", async () => {
    await loadServiceWorker();
    await dispatchFetch(
      makeRequest(`${ORIGIN}/dist/php.wasm`, {
        headers: { range: "bytes=0-1" },
      }),
    );
    assert.equal(harness.stores.size, 0);
    assert.equal(harness.fetchCalls.length, 1);
  });
});

describe("sw.js addon proxy", () => {
  it("returns 502 when no addon proxy is configured", async () => {
    await loadServiceWorker();
    harness.fetchImpl = async () => new Response("{}", { status: 404 });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/__playground_proxy__?url=x`),
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /No addon proxy configured/u);
  });

  it("proxies through the configured URL with the request search", async () => {
    await loadServiceWorker();
    harness.fetchImpl = async (input) => {
      if (String(input).endsWith("playground.config.json")) {
        return Response.json({ addonProxyUrl: "https://proxy.test/p?old=1" });
      }
      return new Response("zip", {
        status: 201,
        statusText: "Created",
        headers: { "content-length": "3", "cache-control": "max-age=60" },
      });
    };
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/__playground_proxy__?url=a`, {
        method: "POST",
        body: "payload",
      }),
    );
    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(await response.text(), "zip");
    const upstream = harness.fetchCalls.at(-1);
    assert.equal(upstream.input, "https://proxy.test/p?url=a");
    assert.equal(upstream.init.method, "POST");
    assert.equal(new TextDecoder().decode(upstream.init.body), "payload");
    assert.equal(upstream.init.redirect, "follow");
  });

  it("retries the config fetch after a failure", async () => {
    await loadServiceWorker();
    harness.fetchImpl = async () => {
      throw new Error("offline");
    };
    await assert.rejects(
      dispatchFetch(makeRequest(`${ORIGIN}/__playground_proxy__?url=a`)),
      /offline/u,
    );
    harness.fetchImpl = async (input) =>
      String(input).endsWith("playground.config.json")
        ? Response.json({ addonProxyUrl: "https://proxy.test/" })
        : new Response("ok");
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/__playground_proxy__?url=a`),
    );
    assert.equal(await response.text(), "ok");
  });

  it("only lets the remote host override the proxy URL", async () => {
    await loadServiceWorker();
    harness.fetchImpl = async () => Response.json({});
    const message = harness.listeners.get("message");
    message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://evil.test/",
      },
      source: { url: `${ORIGIN}/playground/s/r/page` },
    });
    message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://bad.test/",
      },
      source: null,
    });
    message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://ok.test/",
      },
      source: { url: `${ORIGIN}/remote.html?scope=s` },
    });
    await dispatchFetch(makeRequest(`${ORIGIN}/__playground_proxy__?url=z`));
    assert.equal(harness.fetchCalls.at(-1).input, "https://ok.test/?url=z");

    message({
      data: { kind: "configure-service-worker" },
      source: { url: `${ORIGIN}/remote.html` },
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/__playground_proxy__?url=z`),
    );
    // The override is cleared and the config names no proxy.
    assert.equal(response.status, 502);
  });

  it("does not trust an origin-root remote.html under an app subpath", async () => {
    await loadServiceWorker(`${ORIGIN}/fs-playground/`);
    harness.fetchImpl = async () => Response.json({});
    const message = harness.listeners.get("message");
    const proxyRequest = () =>
      dispatchFetch(
        makeRequest(`${ORIGIN}/fs-playground/__playground_proxy__?url=z`),
      );
    // Another app sharing the origin (e.g. GitHub Pages) at /remote.html.
    message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://evil.test/",
      },
      source: { url: `${ORIGIN}/remote.html` },
    });
    assert.equal((await proxyRequest()).status, 502);

    message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://ok.test/",
      },
      source: { url: `${ORIGIN}/fs-playground/remote.html?scope=s` },
    });
    await proxyRequest();
    assert.equal(harness.fetchCalls.at(-1).input, "https://ok.test/?url=z");
  });
});

describe("sw.js under an app subpath", () => {
  it("scopes, redirects and rewrites inside the base path", async () => {
    await loadServiceWorker(`${ORIGIN}/fs-playground/`);
    harness.fetchImpl = async (input) =>
      String(input).endsWith("playground.config.json")
        ? Response.json({})
        : new Response("network");
    replyWith({
      status: 302,
      statusText: "Found",
      headers: {
        location: "/fs-playground/ListCliente",
        "content-type": "text/html",
      },
      body:
        '<head><a href="/fs-playground/assets/x.css">a</a>' +
        '<a href="/fs-playground">b</a><a href="Rel">r</a>' +
        '<a href="/fs-playground/playground/s1/php83/In">i</a>',
    });
    const response = await dispatchFetch(
      makeRequest(`${ORIGIN}/fs-playground/playground/s1/php83/Edit`),
    );
    assert.equal(
      response.headers.get("location"),
      "/fs-playground/playground/s1/php83/ListCliente",
    );
    const html = await response.text();
    assert.ok(html.includes('href="/fs-playground/assets/x.css"'));
    assert.ok(html.includes('href="/fs-playground"'));
    assert.ok(html.includes('href="/fs-playground/playground/s1/php83/Rel"'));
    assert.ok(html.includes('href="/fs-playground/playground/s1/php83/In"'));
    assert.equal(lastBridgeRequest().url, `${ORIGIN}/Edit`);

    // Static files under the base path are not scoped.
    const staticResponse = await dispatchFetch(
      makeRequest(`${ORIGIN}/fs-playground/remote.html`),
    );
    assert.equal(await staticResponse.text(), "network");

    // A navigation to the bare base path from a scoped referrer redirects.
    const redirect = await dispatchFetch(
      makeRequest(`${ORIGIN}/fs-playground`, {
        mode: "navigate",
        referrer: `${ORIGIN}/fs-playground/playground/s1/php83/`,
      }),
    );
    assert.equal(
      redirect.headers.get("location"),
      `${ORIGIN}/fs-playground/playground/s1/php83/`,
    );

    // A path outside the base path is still handled as-is.
    const outside = await dispatchFetch(makeRequest(`${ORIGIN}/elsewhere`));
    assert.equal(await outside.text(), "network");

    // The remote host check also strips the base path.
    harness.listeners.get("message")({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://p.test/",
      },
      source: { url: `${ORIGIN}/fs-playground/remote.html` },
    });
    await dispatchFetch(
      makeRequest(`${ORIGIN}/fs-playground/__playground_proxy__?u=1`),
    );
    assert.equal(harness.fetchCalls.at(-1).input, "https://p.test/?u=1");
  });
});
