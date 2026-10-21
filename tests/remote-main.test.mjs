// Boots src/remote/main.js inside a happy-dom window built from remote.html,
// with fake Service Worker container, Web Locks, Worker and BroadcastChannel.
// Each scenario imports a fresh module instance and asserts what the runtime
// host renders and posts to the shell, the Service Worker and the PHP worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import { createShellChannel } from "../src/shared/protocol.js";
import { SERVICE_WORKER_UNSUPPORTED_MESSAGE } from "../src/shared/service-worker-support.js";

const ORIGIN = "https://app.test";
const MAIN_URL = new URL("../src/remote/main.js", import.meta.url).href;
const REMOTE_BODY = readFileSync(
  new URL("../remote.html", import.meta.url),
  "utf8",
)
  .match(/<body[^>]*>([\s\S]*)<\/body>/u)[1]
  .replace(/<script[\s\S]*?<\/script>/gu, "");
const CONFIG = {
  addonProxyUrl: "https://proxy.test/",
  runtimes: [
    { id: "php83", label: "PHP 8.3", phpVersion: "8.3" },
    { id: "php84", label: "PHP 8.4", phpVersion: "8.4", default: true },
  ],
};
let importCounter = 0;
let env;

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.handlers = [];
    env.channels.push(this);
  }
  addEventListener(type, handler) {
    if (type === "message") this.handlers.push(handler);
  }
  postMessage(message) {
    env.broadcasts.push({ channel: this.name, message });
  }
  close() {
    this.closed = true;
  }
}

class FakeWorker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.posted = [];
    this.listeners = new Map();
    this.terminated = false;
    env.workers.push(this);
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== handler),
    );
  }
  emit(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
  postMessage(message) {
    this.posted.push(message);
    env.onWorkerPost?.(this, message);
  }
  terminate() {
    this.terminated = true;
  }
}

function createServiceWorkerContainer({ controlled }) {
  const controller = {
    posted: [],
    postMessage(message) {
      this.posted.push(message);
    },
  };
  const container = {
    controller: controlled ? controller : null,
    ready: Promise.resolve({ active: true }),
    registrations: [],
    handlers: [],
    async register(url, options) {
      container.registrations.push({ url, options });
      return { update: async () => {} };
    },
    addEventListener(type, handler) {
      if (type === "controllerchange") {
        env.controllerChange = () => {
          container.controller = controller;
          handler();
        };
        if (env.autoControl) queueMicrotask(env.controllerChange);
        return;
      }
      if (type === "message") container.handlers.push(handler);
    },
  };
  return { container, controller };
}

function readyReply(worker, message) {
  if (message.kind !== "configure-blueprint") return;
  const { scopeId, runtimeId } = message.runtimeParams;
  queueMicrotask(() => {
    worker.emit("message", { data: { kind: "other" } });
    worker.emit("message", {
      data: { kind: "worker-ready", scopeId: "other", runtimeId },
    });
    worker.emit("message", {
      data: { kind: "worker-ready", scopeId, runtimeId },
    });
  });
}

function setup({
  query = "scope=s1&runtime=php83&path=/Dashboard&core=2025.1&instance=i1",
  serviceWorker = "uncontrolled",
  locks = "available",
  autoControl = true,
  onWorkerPost = readyReply,
  blueprint = null,
} = {}) {
  const window = new Window({
    url: `${ORIGIN}/remote.html?${query}`,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  window.document.body.innerHTML = REMOTE_BODY;
  env = {
    window,
    channels: [],
    broadcasts: [],
    workers: [],
    onWorkerPost,
    autoControl,
    released: 0,
    lockCallback: null,
  };
  let sw = null;
  if (serviceWorker !== "none") {
    sw = createServiceWorkerContainer({
      controlled: serviceWorker === "controlled",
    });
  }
  env.sw = sw;
  const navigatorStub = {};
  if (sw) navigatorStub.serviceWorker = sw.container;
  if (locks !== "none") {
    navigatorStub.locks = {
      request: async (_name, _options, callback) => {
        if (locks === "taken") return callback(null);
        if (locks === "deferred") {
          await new Promise((resolve) => {
            env.grantLock = resolve;
          });
        }
        const held = callback({ name: _name });
        // acquireScopeOwnership resolves with the release function; record it.
        return held.then(() => {
          env.released += 1;
        });
      },
    };
  }
  if (blueprint) {
    window.sessionStorage.setItem(
      "facturascripts-playground:blueprint:s1",
      JSON.stringify(blueprint),
    );
  }
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: navigatorStub,
    configurable: true,
  });
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  globalThis.Worker = FakeWorker;
  globalThis.fetch = async () => Response.json(CONFIG);
  return env;
}

async function boot(options) {
  setup(options);
  importCounter += 1;
  await import(`${MAIN_URL}?n=${importCounter}`);
  return env;
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function shellMessages(scopeId = "s1", instanceId = "i1") {
  const channel = createShellChannel(scopeId, instanceId);
  return env.broadcasts
    .filter((entry) => entry.channel === channel)
    .map((entry) => entry.message);
}

function hostReady() {
  return shellMessages().some((m) => m.title === "Runtime host ready");
}

function lastError() {
  return shellMessages().findLast((m) => m.kind === "error");
}

function $(selector) {
  return env.window.document.querySelector(selector);
}

function postFromShell(data, origin = ORIGIN) {
  env.window.dispatchEvent(
    new env.window.MessageEvent("message", { data, origin }),
  );
}

afterEach(async () => {
  await env?.window.happyDOM.close();
});

describe("remote host boot", () => {
  it("registers the Service Worker, starts the PHP worker and loads the site", async () => {
    await boot();
    await waitFor(hostReady, "host ready");

    const registration = env.sw.container.registrations[0];
    assert.ok(registration.url.pathname.endsWith("/sw.bundle.js"));
    assert.equal(registration.url.searchParams.get("v"), BUILD_VERSION);
    assert.equal(registration.url.searchParams.get("scope"), "s1");
    assert.equal(registration.url.searchParams.get("runtime"), "php83");
    assert.equal(registration.url.searchParams.get("core"), "2025.1");
    assert.deepEqual(registration.options, {
      scope: "./",
      updateViaCache: "none",
    });

    assert.deepEqual(env.sw.controller.posted, [
      {
        kind: "configure-service-worker",
        addonProxyUrl: "https://proxy.test/",
      },
    ]);

    const [worker] = env.workers;
    assert.ok(worker.url.pathname.endsWith("/dist/php-worker.bundle.js"));
    assert.equal(worker.url.searchParams.get("instance"), "i1");
    assert.equal(worker.url.searchParams.get("opcache"), null);
    assert.deepEqual(worker.options, { type: "module" });
    assert.deepEqual(worker.posted[0], {
      kind: "configure-blueprint",
      runtimeParams: {
        scopeId: "s1",
        runtimeId: "php83",
        instanceId: "i1",
        coreVersion: "2025.1",
        opcacheParam: null,
      },
      blueprint: null,
      clean: false,
    });
    // The readiness listener detaches once the matching message arrived.
    assert.equal(worker.listeners.get("message").length, 0);

    assert.equal(
      $("#remote-frame").getAttribute("src"),
      `${ORIGIN}/playground/s1/php83/Dashboard`,
    );
    assert.deepEqual(
      JSON.parse(
        env.window.sessionStorage.getItem("facturascripts-playground:s1:state"),
      ),
      { coreVersion: "2025.1", runtimeId: "php83", path: "/Dashboard" },
    );
    assert.match(
      $("#remote-status").textContent,
      /The embedded FacturaScripts iframe is loading\./u,
    );
    assert.equal($("#progress-percent").textContent, "18%");
    assert.equal($("#progress-fill").style.width, "18%");

    const first = shellMessages()[0];
    assert.deepEqual(first, {
      kind: "progress",
      title: "Preparing runtime",
      detail: "Registering service worker for PHP 8.3.",
      progress: 0.08,
    });
    assert.ok(env.channels.filter((c) => c.closed).length >= 2);
  });

  it("reuses a controlling worker and honours clean, opcache and the stored blueprint", async () => {
    const blueprint = { steps: [{ step: "login" }] };
    await boot({
      query: "scope=s1&runtime=missing&clean=1&opcache=0&instance=i1",
      serviceWorker: "controlled",
      blueprint,
    });
    await waitFor(hostReady, "host ready");

    assert.equal(env.sw.container.registrations.length, 0);
    assert.deepEqual(env.sw.controller.posted, [
      {
        kind: "configure-service-worker",
        addonProxyUrl: "https://proxy.test/",
      },
      { kind: "clear-static-cache" },
    ]);
    const [worker] = env.workers;
    assert.equal(worker.url.searchParams.get("opcache"), "0");
    assert.equal(worker.url.searchParams.get("runtime"), "php84");
    assert.equal(worker.url.searchParams.get("core"), "");
    assert.deepEqual(worker.posted[0].blueprint, blueprint);
    assert.equal(worker.posted[0].clean, true);
    assert.equal(
      $("#remote-frame").getAttribute("src"),
      `${ORIGIN}/playground/s1/php84/`,
    );
  });

  it("generates an instance id when none is given", async () => {
    await boot({ query: "scope=s1&runtime=php83" });
    await waitFor(() => env.workers[0]?.posted.length, "worker configured");
    const instanceId = env.workers[0].url.searchParams.get("instance");
    assert.match(instanceId, /^[0-9a-f-]{36}$/u);
  });
});

describe("remote host failures", () => {
  it("reports a missing Service Worker API as a warning", async () => {
    await boot({ serviceWorker: "none" });
    await waitFor(lastError, "error");
    assert.deepEqual(lastError(), {
      kind: "error",
      detail: SERVICE_WORKER_UNSUPPORTED_MESSAGE,
      level: "warning",
      source: "service-worker-unsupported",
    });
    assert.equal(
      $("#remote-status").textContent,
      SERVICE_WORKER_UNSUPPORTED_MESSAGE,
    );
    assert.equal(
      $(".remote-boot__card").classList.contains("is-hidden"),
      false,
    );
  });

  it("reports runtime failures with their stack", async () => {
    await boot({ locks: "none" });
    await waitFor(lastError, "error");
    const error = lastError();
    assert.equal(error.level, "error");
    assert.equal(error.source, "runtime");
    assert.match(error.detail, /^Web Locks are required/u);
    assert.match(error.detail, /\n {4}at /u);
    assert.match($("#remote-status").textContent, /^Web Locks are required/u);
  });

  it("reports a scope already open in another tab", async () => {
    await boot({ locks: "taken" });
    await waitFor(lastError, "error");
    assert.match(lastError().detail, /already open in another tab/u);
  });

  it("reports worker load errors and malformed messages", async () => {
    await boot({ onWorkerPost: () => {} });
    await waitFor(() => env.workers.length, "worker created");
    const [worker] = env.workers;
    worker.emit("error", { message: "SyntaxError in bundle" });
    assert.deepEqual(lastError(), {
      kind: "error",
      detail: "SyntaxError in bundle",
    });
    worker.emit("error", {});
    assert.equal(
      lastError().detail,
      "php-worker failed before signalling readiness.",
    );
    worker.emit("messageerror", {});
    assert.equal(lastError().detail, "php-worker posted a malformed message.");
    assert.equal(
      $("#remote-status").textContent,
      "php-worker posted a malformed message.",
    );
  });

  it("times out when the PHP worker never signals readiness", async () => {
    setup({ onWorkerPost: () => {} });
    const timers = [];
    env.window.setTimeout = (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    };
    importCounter += 1;
    await import(`${MAIN_URL}?n=${importCounter}`);
    await waitFor(() => timers.length, "readiness timer");
    assert.equal(timers[0].delay, 15000);
    timers[0].callback();
    await waitFor(lastError, "error");
    assert.match(
      lastError().detail,
      /^Timed out while waiting for php-worker readiness for php83\./u,
    );
  });
});

describe("remote host lifecycle", () => {
  it("releases the scope without booting when the page hides during the lock wait", async () => {
    await boot({ locks: "deferred" });
    env.window.dispatchEvent(new env.window.Event("pagehide"));
    env.grantLock();
    await waitFor(() => env.released === 1, "scope release");
    assert.equal(env.workers.length, 0);
    assert.equal(env.sw.container.registrations.length, 0);
  });

  it("does not start the PHP worker when the page hides while waiting for control", async () => {
    await boot({ autoControl: false });
    await waitFor(() => env.controllerChange, "controllerchange listener");
    env.window.dispatchEvent(new env.window.Event("pagehide"));
    env.controllerChange();
    await waitFor(() => env.released === 1, "scope release");
    assert.equal(env.workers.length, 0);
  });

  it("terminates the PHP worker and releases the scope on pagehide", async () => {
    await boot();
    await waitFor(hostReady, "host ready");
    env.window.dispatchEvent(new env.window.Event("pagehide"));
    assert.equal(env.workers[0].terminated, true);
    await waitFor(() => env.released === 1, "scope release");
  });

  it("reloads when restored from the back/forward cache", async () => {
    await boot();
    await waitFor(hostReady, "host ready");
    let reloads = 0;
    Object.defineProperty(env.window, "location", {
      value: { ...env.window.location, reload: () => (reloads += 1) },
      configurable: true,
    });
    const notPersisted = new env.window.Event("pageshow");
    env.window.dispatchEvent(notPersisted);
    assert.equal(reloads, 0);
    const persisted = new env.window.Event("pageshow");
    Object.defineProperty(persisted, "persisted", { value: true });
    env.window.dispatchEvent(persisted);
    assert.equal(reloads, 1);
  });
});

describe("remote host commands and navigation", () => {
  async function bootReady() {
    await boot();
    await waitFor(hostReady, "host ready");
    const frame = $("#remote-frame");
    const frameWindow = {
      reloads: 0,
      location: {
        href: `${ORIGIN}/playground/s1/php83/Dashboard`,
        reload() {
          frameWindow.reloads += 1;
        },
      },
    };
    Object.defineProperty(frame, "contentWindow", {
      get: () => frameWindow,
      configurable: true,
    });
    return { frame, frameWindow, worker: env.workers[0] };
  }

  it("navigates, refreshes and relays commands from the shell", async () => {
    const { frame, frameWindow, worker } = await bootReady();

    postFromShell({ kind: "navigate-site", path: "/ListCliente" });
    assert.equal(
      frame.getAttribute("src"),
      `${ORIGIN}/playground/s1/php83/ListCliente`,
    );
    postFromShell({ kind: "navigate-site" });
    assert.equal(frame.getAttribute("src"), `${ORIGIN}/playground/s1/php83/`);
    // Same target again: navigate the live document instead.
    postFromShell({ kind: "navigate-site", path: "/" });
    assert.equal(frameWindow.location.href, `${ORIGIN}/playground/s1/php83/`);

    postFromShell({ kind: "refresh-site" });
    assert.equal(frameWindow.reloads, 1);

    postFromShell({ kind: "capture-phpinfo" });
    postFromShell({ kind: "flush-persistence" });
    postFromShell({ kind: "unknown" });
    assert.deepEqual(worker.posted.slice(1), [
      { kind: "capture-phpinfo" },
      { kind: "flush-persistence" },
    ]);

    postFromShell(
      { kind: "navigate-site", path: "/Evil" },
      "https://evil.test",
    );
    assert.equal(frame.getAttribute("src"), `${ORIGIN}/playground/s1/php83/`);
  });

  it("refreshes by assigning the source when the frame has no window", async () => {
    await boot();
    await waitFor(hostReady, "host ready");
    const frame = $("#remote-frame");
    Object.defineProperty(frame, "contentWindow", {
      get: () => null,
      configurable: true,
    });
    postFromShell({ kind: "navigate-site", path: "/A" });
    postFromShell({ kind: "refresh-site" });
    assert.equal(frame.getAttribute("src"), `${ORIGIN}/playground/s1/php83/A`);
    postFromShell({ kind: "navigate-site", path: "/A" });
    assert.equal(frame.getAttribute("src"), `${ORIGIN}/playground/s1/php83/A`);
  });

  it("reports iframe loads to the shell with the unscoped path", async () => {
    const { frame, frameWindow } = await bootReady();
    frameWindow.location.href = `${ORIGIN}/playground/s1/php83/EditCliente?code=7#t`;
    frame.dispatchEvent(new env.window.Event("load"));
    const messages = shellMessages();
    assert.deepEqual(messages.at(-2), {
      kind: "ready",
      detail: "Iframe loaded for php83.",
      path: "/EditCliente?code=7#t",
    });
    assert.deepEqual(messages.at(-1), {
      kind: "navigate",
      path: "/EditCliente?code=7#t",
    });
    assert.equal($(".remote-boot__card").classList.contains("is-hidden"), true);

    // A page outside this scope keeps its full path.
    frameWindow.location.href = `${ORIGIN}/playground/other/php83/X`;
    frame.dispatchEvent(new env.window.Event("load"));
    assert.equal(shellMessages().at(-1).path, "/playground/other/php83/X");
  });

  it("falls back to the last path when the frame location is unreadable", async () => {
    const { frame } = await bootReady();
    postFromShell({ kind: "navigate-site", path: "/Known" });
    // The first (guarded) read throws as a cross-origin document would;
    // emitNavigation's later read sees a location without an href.
    let reads = 0;
    Object.defineProperty(frame, "contentWindow", {
      get: () => {
        reads += 1;
        if (reads === 1) {
          return {
            get location() {
              throw new Error("cross-origin");
            },
          };
        }
        return { location: {} };
      },
      configurable: true,
    });
    frame.dispatchEvent(new env.window.Event("load"));
    assert.deepEqual(shellMessages().at(-2).path, "/Known");
    assert.deepEqual(shellMessages().at(-1), {
      kind: "navigate",
      path: "/Known",
    });
  });

  it("shows asset loading progress once bootstrap reported readiness", async () => {
    await bootReady();
    const shellChannel = env.channels.find(
      (channel) =>
        channel.name === createShellChannel("s1", "i1") &&
        channel.handlers.length,
    );
    const deliver = (data) => {
      for (const handler of shellChannel.handlers) handler({ data });
    };
    const swMessage = (data) => {
      for (const handler of env.sw.container.handlers) handler({ data });
    };

    swMessage({ kind: "sw-debug" });
    assert.match(
      $("#remote-status").textContent,
      /The embedded FacturaScripts iframe is loading\./u,
    );

    deliver({ kind: "progress", detail: "Installing plugins", progress: 0.5 });
    assert.equal($("#remote-status").textContent, "Installing plugins");
    assert.equal($("#progress-percent").textContent, "50%");
    deliver({ kind: "other" });
    deliver({ kind: "progress", progress: 2 });
    assert.equal($("#progress-percent").textContent, "100%");
    deliver({
      kind: "progress",
      detail: "FacturaScripts is ready",
      progress: 0.95,
    });
    swMessage({ kind: "other" });
    assert.equal($("#remote-status").textContent, "FacturaScripts is ready");
    swMessage({ kind: "sw-debug" });
    assert.equal($("#remote-status").textContent, "Loading page assets…");
    assert.equal($("#progress-percent").textContent, "97%");
  });
});
