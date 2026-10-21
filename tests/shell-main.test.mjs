// Drives the shell (src/shell/main.js) against the real index.html markup in a
// happy-dom document. The browser boundaries main.js touches — location,
// Service Worker container, BroadcastChannel, fetch, clipboard and the remote
// iframe's contentWindow — are recorded fakes; config, blueprint, storage,
// paths and the blueprint editor run for real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, describe, it, mock } from "node:test";
import { Window } from "happy-dom";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import { SERVICE_WORKER_UNSUPPORTED_MESSAGE } from "../src/shared/service-worker-support.js";

const SHELL_URL = new URL("../src/shell/main.js", import.meta.url).href;
const INDEX_HTML = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const BODY_MARKUP = INDEX_HTML.slice(
  INDEX_HTML.indexOf(">", INDEX_HTML.indexOf("<body")) + 1,
  INDEX_HTML.indexOf("</body>"),
).replace('<script type="module" src="./src/shell/main.js"></script>', "");

// Each scenario imports main.js under a fresh query so its module state
// restarts; config.js memoizes the config fetch, so it is re-instanced too.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || "";
    const resolved = nextResolve(specifier, context);
    if (
      parent.startsWith(`${SHELL_URL}?`) &&
      specifier === "../shared/config.js"
    ) {
      return {
        ...resolved,
        url: `${resolved.url}${parent.slice(SHELL_URL.length)}`,
      };
    }
    return resolved;
  },
});

const BASE_CONFIG = {
  siteTitle: "Shell Test",
  landingPath: "/",
  locale: "es_ES",
  timezone: "Europe/Madrid",
  autologin: true,
  opcache: true,
  admin: { username: "admin", password: "admin", email: "a@example.com" },
  runtimes: [
    { id: "php83", label: "PHP 8.3", phpVersion: "8.3", default: true },
    { id: "php84", label: "PHP 8.4", phpVersion: "8.4" },
  ],
};
const VERSIONS = {
  default: "2025",
  versions: [
    { version: "2025", label: "2025 (stable)" },
    { version: "2024", label: "2024" },
  ],
};

const windows = [];
let sequence = 0;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = async (rounds = 25) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function createLocation(href) {
  const url = new URL(href);
  return {
    assigned: [],
    reloads: 0,
    get href() {
      return url.href;
    },
    set href(value) {
      this.assigned.push(String(value));
    },
    get origin() {
      return url.origin;
    },
    get pathname() {
      return url.pathname;
    },
    reload() {
      this.reloads += 1;
    },
  };
}

class FakeBroadcastChannel {
  static instances = [];
  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.closed = false;
    FakeBroadcastChannel.instances.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  close() {
    this.closed = true;
  }
}

async function bootShell(options = {}) {
  const {
    href = "https://play.test/app/index.html?scope=s1",
    config = BASE_CONFIG,
    versions = VERSIONS,
    session = {},
    serviceWorker = "default",
    contentWindow = true,
    routes = {},
    holdConfig = false,
    wait = true,
  } = options;

  const win = new Window({
    url: href,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
      },
    },
  });
  windows.push(win);
  const doc = win.document;
  doc.body.replaceChildren(
    ...new win.DOMParser().parseFromString(BODY_MARKUP, "text/html").body
      .childNodes,
  );
  for (const [key, value] of Object.entries(session)) {
    win.sessionStorage.setItem(key, value);
  }

  const location = createLocation(href);
  const replaced = [];
  globalThis.window = {
    location,
    sessionStorage: win.sessionStorage,
    history: {
      state: null,
      replaceState(_state, _title, url) {
        replaced.push(String(url));
      },
    },
  };
  globalThis.document = doc;

  const registrations = [];
  const swListeners = [];
  const clipboardWrites = [];
  let swContainer;
  if (serviceWorker === "default" || serviceWorker === "uncontrolled") {
    swContainer = {
      controller: serviceWorker === "default" ? {} : null,
      ready: Promise.resolve(),
      register(url, opts) {
        registrations.push({ url: new URL(String(url)), opts });
        return Promise.resolve({ update: () => Promise.resolve() });
      },
      addEventListener(type, listener) {
        if (type === "message") swListeners.push(listener);
      },
    };
  } else if (serviceWorker === "rejecting") {
    swContainer = {
      register: () => Promise.reject(new Error("boom")),
      addEventListener() {},
    };
  }
  const nav = {
    clipboard: {
      writeText(text) {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  };
  if (swContainer) nav.serviceWorker = swContainer;
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    configurable: true,
    writable: true,
  });

  FakeBroadcastChannel.instances = [];
  globalThis.BroadcastChannel = FakeBroadcastChannel;

  let releaseConfig;
  const configGate = holdConfig
    ? new Promise((resolve) => {
        releaseConfig = resolve;
      })
    : Promise.resolve();
  const fetchCalls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    fetchCalls.push(url.href);
    if (url.pathname.endsWith("/playground.config.json")) {
      await configGate;
      return typeof config === "number"
        ? jsonResponse({}, config)
        : jsonResponse(config);
    }
    if (url.pathname.endsWith("/assets/manifests/versions.json")) {
      return jsonResponse(versions);
    }
    if (routes[url.href]) {
      return jsonResponse(routes[url.href]);
    }
    return jsonResponse({}, 404);
  };

  const posts = [];
  const frame = doc.querySelector("#site-frame");
  const remote = {
    postMessage(message, origin) {
      posts.push({ message, origin });
    },
  };
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => (contentWindow ? remote : null),
  });

  sequence += 1;
  await import(`${SHELL_URL}?scenario=${sequence}`);
  if (wait) await settle();

  const $ = (selector) => doc.querySelector(selector);
  const shell = {
    win,
    doc,
    $,
    location,
    replaced,
    registrations,
    swListeners,
    clipboardWrites,
    fetchCalls,
    posts,
    releaseConfig,
    frameUrl: () => new URL(frame.getAttribute("src") || "about:blank"),
    logText: () => $("#log-panel").textContent,
    channel: () => FakeBroadcastChannel.instances.at(-1),
    emit(message) {
      for (const listener of shell.channel().listeners) {
        listener({ data: message });
      }
    },
    click(selector) {
      $(selector).dispatchEvent(new win.Event("click"));
    },
    change(selector, mutate) {
      const el = $(selector);
      mutate(el);
      el.dispatchEvent(new win.Event("change"));
    },
    async booted() {
      shell.emit({ kind: "ready", bootstrapped: true, path: "/" });
      await settle(2);
    },
  };
  return shell;
}

after(async () => {
  hooks.deregister();
  for (const win of windows) {
    await win.happyDOM.close();
  }
});

describe("shell boot", () => {
  it("registers the classic SW and points the frame at the scoped remote", async () => {
    const shell = await bootShell();

    assert.equal(shell.registrations.length, 1);
    const { url, opts } = shell.registrations[0];
    assert.ok(url.pathname.endsWith("/sw.bundle.js"));
    assert.equal(url.searchParams.get("v"), BUILD_VERSION);
    assert.equal(url.searchParams.get("scope"), "s1");
    assert.equal(url.searchParams.get("runtime"), "php83");
    assert.equal(url.searchParams.get("core"), "2025");
    assert.deepEqual(opts, { scope: "./", updateViaCache: "none" });

    const frameUrl = shell.frameUrl();
    assert.equal(
      frameUrl.href.split("?")[0],
      "https://play.test/app/remote.html",
    );
    assert.equal(frameUrl.searchParams.get("scope"), "s1");
    assert.equal(frameUrl.searchParams.get("runtime"), "php83");
    assert.equal(frameUrl.searchParams.get("path"), "/");
    assert.equal(frameUrl.searchParams.get("core"), "2025");
    assert.equal(frameUrl.searchParams.get("clean"), null);
    const instance = frameUrl.searchParams.get("instance");
    assert.equal(
      shell.channel().name,
      `facturascripts-playground-shell:s1:${instance}`,
    );

    assert.match(shell.logText(), /Playground build /u);
    assert.equal(shell.$("#build-id-value").textContent, BUILD_VERSION);
    assert.equal(
      shell.$("#build-id-chip").title,
      `Copy Playground build ID (${BUILD_VERSION})`,
    );
    assert.equal(shell.$("#runtime-id-value").textContent, "php83");
    assert.deepEqual(
      [...shell.$("#info-php-version").options].map((o) => o.value),
      ["php83", "php84"],
    );
    assert.deepEqual(
      [...shell.$("#info-core-version").options].map((o) => o.textContent),
      ["2025 (stable)", "2024"],
    );
    assert.equal(shell.$("#info-opcache").checked, true);
    assert.equal(shell.$("#address-input").value, "/");
    assert.equal(shell.$("#address-input").disabled, true);
    assert.equal(shell.$("#run-button").disabled, true);
    assert.equal(
      shell.win.sessionStorage.getItem("blueprint-source:s1"),
      "default",
    );
    assert.match(shell.$("#phpinfo-frame").srcdoc, /No PHP diagnostics/u);
    const blueprint = JSON.parse(shell.$("#blueprint-textarea").value);
    assert.equal(blueprint.siteOptions.title, "Shell Test");
  });

  it("reloads once so the Service Worker controls the page", async () => {
    const first = await bootShell({ serviceWorker: "uncontrolled" });
    assert.equal(first.location.reloads, 1);
    assert.equal(
      first.win.sessionStorage.getItem(
        "facturascripts-playground:s1:sw-controlled",
      ),
      "1",
    );
    assert.equal(first.$("#site-frame").getAttribute("src"), null);

    const second = await bootShell({
      serviceWorker: "uncontrolled",
      session: { "facturascripts-playground:s1:sw-controlled": "1" },
    });
    assert.equal(second.location.reloads, 0);
    assert.equal(
      second.win.sessionStorage.getItem(
        "facturascripts-playground:s1:sw-controlled",
      ),
      null,
    );
    assert.equal(second.frameUrl().searchParams.get("runtime"), "php83");
  });

  it("shows a fatal banner when Service Workers are unavailable", async () => {
    const shell = await bootShell({ serviceWorker: "missing" });
    const banner = shell.$("#fatal-error-banner");
    assert.equal(banner.getAttribute("role"), "alert");
    assert.equal(banner.textContent, SERVICE_WORKER_UNSUPPORTED_MESSAGE);
    assert.equal(shell.$("#address-input").disabled, false);
    assert.match(shell.$("#log-panel .error").textContent, /Service Workers/u);
  });

  it("reports a rejected registration and replaces an older banner", async () => {
    const shell = await bootShell({ serviceWorker: "rejecting" });
    assert.equal(shell.doc.querySelectorAll("#fatal-error-banner").length, 1);
    assert.match(
      shell.$("#fatal-error-banner").textContent,
      /registering its Service Worker failed \(boom\)/u,
    );
    // A later frame update re-runs registration and reuses the single banner.
    shell.click("#reset-button");
    await settle();
    assert.equal(shell.doc.querySelectorAll("#fatal-error-banner").length, 1);
  });

  it("keeps the UI locked behind a fatal banner when the config fails to load", async () => {
    const shell = await bootShell({ config: 500 });
    assert.match(
      shell.$("#log-panel .error").textContent,
      /Unable to load playground config: 500/u,
    );
    assert.match(
      shell.$("#fatal-error-banner").textContent,
      /could not start: Unable to load playground config: 500/u,
    );
    assert.equal(shell.$("#address-input").disabled, true);
    assert.equal(shell.$("#reset-button").disabled, true);
    assert.equal(shell.registrations.length, 0);

    // There is no runtime to point at: the toolbar stays inert instead of
    // loading remote.html?runtime=undefined, and Reset does not throw.
    for (const button of ["#home-button", "#refresh-button", "#reset-button"]) {
      shell.click(button);
    }
    await settle();
    assert.equal(shell.$("#site-frame").getAttribute("src"), null);
    assert.equal(shell.registrations.length, 0);
  });

  it("keeps the UI locked when the blueprint fails to load", async () => {
    const shell = await bootShell({
      href: "https://play.test/app/index.html?scope=s1&blueprint-sid=gone",
    });
    assert.match(
      shell.$("#fatal-error-banner").textContent,
      /Stored blueprint not found/u,
    );
    assert.equal(shell.$("#address-input").disabled, true);
    shell.click("#home-button");
    await settle();
    assert.equal(shell.$("#site-frame").getAttribute("src"), null);
  });

  it("refuses to capture PHP info before the config has loaded", async () => {
    const shell = await bootShell({ holdConfig: true, wait: false });
    shell.click("#phpinfo-tab");
    assert.match(
      shell.logText(),
      /Cannot capture PHP info before the playground configuration is loaded/u,
    );
    assert.equal(
      shell.$("#phpinfo-panel").classList.contains("is-hidden"),
      false,
    );
    shell.releaseConfig();
    await settle();
    assert.equal(shell.registrations.length, 1);
  });

  it("restores the previous session runtime, core and path", async () => {
    const shell = await bootShell({
      session: {
        "blueprint-source:s1": "default",
        "facturascripts-playground:s1:state": JSON.stringify({
          runtimeId: "php84",
          coreVersion: "2024",
          path: "/ListCliente",
        }),
      },
    });
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("runtime"), "php84");
    assert.equal(frameUrl.searchParams.get("core"), "2024");
    assert.equal(frameUrl.searchParams.get("path"), "/ListCliente");
    assert.equal(frameUrl.searchParams.get("clean"), null);
    assert.equal(shell.$("#info-php-version").value, "php84");
    assert.equal(shell.$("#info-core-version").value, "2024");
  });

  it("skips a saved /login path when autologin is on and honours URL overrides", async () => {
    const shell = await bootShell({
      href: "https://play.test/app/index.html?scope=s1&version=2024&opcache=0",
      session: {
        "facturascripts-playground:s1:state": JSON.stringify({
          runtimeId: "php84",
          coreVersion: "2025",
          path: "/login",
        }),
      },
    });
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("path"), "/");
    assert.equal(frameUrl.searchParams.get("core"), "2024");
    assert.equal(frameUrl.searchParams.get("opcache"), "0");
    assert.equal(shell.$("#info-opcache").checked, false);
  });

  it("boots clean on the default runtime when the blueprint source changed", async () => {
    const shell = await bootShell({
      href: "https://play.test/app/index.html?scope=s1&blueprint-url=https://bp.test/demo.json",
      routes: {
        "https://bp.test/demo.json": { landingPage: "/Dashboard" },
      },
      session: {
        "blueprint-source:s1": "default",
        "facturascripts-playground:s1:state": JSON.stringify({
          runtimeId: "php84",
          path: "/Old",
        }),
      },
    });
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("clean"), "1");
    assert.equal(frameUrl.searchParams.get("runtime"), "php83");
    assert.equal(frameUrl.searchParams.get("path"), "/Dashboard");
    assert.equal(
      shell.win.sessionStorage.getItem("blueprint-source:s1"),
      "url:https://bp.test/demo.json",
    );
  });

  it("offers the latest build when no core versions are published", async () => {
    const shell = await bootShell({ versions: { versions: [] } });
    const options = [...shell.$("#info-core-version").options];
    assert.deepEqual(
      options.map((o) => [o.value, o.textContent]),
      [["", "Latest build"]],
    );
    assert.equal(shell.frameUrl().searchParams.get("core"), null);
  });
});

describe("shell channel messages", () => {
  it("tracks progress, readiness, navigation and the back stack", async () => {
    const shell = await bootShell();
    shell.emit({ kind: "progress", title: "Boot", detail: "extracting" });
    assert.match(shell.logText(), /Boot: extracting/u);
    assert.equal(shell.$("#address-input").disabled, true);

    await shell.booted();
    assert.equal(shell.$("#address-input").disabled, false);
    assert.deepEqual(shell.posts.at(-1), {
      message: { kind: "navigate-site", path: "/" },
      origin: "https://play.test",
    });

    // First frame load of a boot is the landing redirect: no back entry.
    shell.emit({ kind: "ready", path: "/Dashboard" });
    assert.equal(shell.$("#back-button").disabled, true);
    assert.equal(shell.$("#address-input").value, "/Dashboard");

    shell.emit({ kind: "ready", path: "/ListCliente" });
    assert.equal(shell.$("#back-button").disabled, false);

    shell.emit({ kind: "navigate", path: "/EditCliente" });
    assert.equal(shell.$("#address-input").value, "/EditCliente");
    const state = JSON.parse(
      shell.win.sessionStorage.getItem("facturascripts-playground:s1:state"),
    );
    assert.equal(state.path, "/EditCliente");
    assert.equal(state.runtimeId, "php83");

    shell.emit({ kind: "navigate" });
    assert.equal(shell.$("#address-input").value, "/");

    shell.click("#back-button");
    assert.deepEqual(shell.posts.at(-1).message, {
      kind: "navigate-site",
      path: "/EditCliente",
    });
    assert.equal(shell.$("#address-input").value, "/EditCliente");
  });

  it("shows a dismissible network warning, reusing one banner", async () => {
    const shell = await bootShell();
    shell.emit({
      kind: "wasm-network-error",
      detail: "curl failed",
      path: "/Updater",
    });
    shell.emit({
      kind: "wasm-network-error",
      detail: "curl failed",
      path: "/Updater",
    });
    const banners = shell.doc.querySelectorAll("#wasm-network-warning");
    assert.equal(banners.length, 1);
    assert.match(banners[0].textContent, /"\/Updater" could not load/u);
    assert.match(shell.$("#log-panel .error").textContent, /curl failed/u);
    shell.$(".wasm-warning-banner__close").click();
    assert.equal(shell.$("#wasm-network-warning"), null);
  });

  it("captures PHP info after a runtime error and renders the reply", async () => {
    const shell = await bootShell();
    await shell.booted();
    shell.emit({ kind: "error", detail: "PHP fatal", level: "warning" });
    assert.match(shell.$("#log-panel .error").textContent, /PHP fatal/u);
    assert.deepEqual(shell.posts.at(-1).message, { kind: "capture-phpinfo" });
    assert.match(
      shell.logText(),
      /Requesting PHP runtime diagnostics \(bootstrap-error\)/u,
    );

    shell.emit({
      kind: "phpinfo",
      html: "<html><head><title>i</title></head><body>PHP 8.3</body></html>",
    });
    const srcdoc = shell.$("#phpinfo-frame").srcdoc;
    assert.match(srcdoc, /\.center table/u);
    assert.ok(srcdoc.includes("</style></head><body>PHP 8.3"));
    assert.match(shell.logText(), /Captured PHP runtime diagnostics\./u);

    // With diagnostics present a later error does not request them again.
    const postCount = shell.posts.length;
    shell.emit({ kind: "error", detail: "again" });
    assert.equal(shell.posts.length, postCount);

    shell.emit({ kind: "phpinfo", detail: "custom detail" });
    assert.match(shell.$("#phpinfo-frame").srcdoc, /No PHP diagnostics/u);
    assert.match(shell.logText(), /custom detail/u);
  });

  it("logs flush, trace and SW debug messages and ignores unknown kinds", async () => {
    const shell = await bootShell();
    shell.emit({ kind: "persistence-flushed" });
    shell.emit({ kind: "persistence-flushed", detail: "flushed 3 ops" });
    shell.emit({ kind: "trace" });
    shell.emit({ kind: "trace", detail: "[trace] step" });
    const before = shell.logText();
    shell.emit({ kind: "something-else" });
    assert.equal(shell.logText(), before);
    for (const listener of shell.swListeners) {
      listener({ data: { kind: "sw-debug", detail: "cache hit" } });
      listener({ data: { kind: "other" } });
      listener({ data: null });
    }
    const text = shell.logText();
    assert.match(text, /Persistence journal flushed\./u);
    assert.match(text, /flushed 3 ops/u);
    assert.match(text, /\[trace\]\n/u);
    assert.match(text, /\[trace\] step/u);
    assert.equal((text.match(/\[sw\]/gu) || []).length, 1);
    assert.match(text, /\[sw\] cache hit/u);
  });
});

describe("shell toolbar", () => {
  it("ignores navigation while the UI is locked", async () => {
    const shell = await bootShell();
    shell.click("#home-button");
    shell
      .$("#address-form")
      .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
    shell.click("#export-button");
    shell.click("#reset-button");
    shell.click("#back-button");
    assert.equal(shell.posts.length, 0);
    assert.equal(shell.registrations.length, 1);
  });

  it("navigates inside a booted runtime by message", async () => {
    const shell = await bootShell();
    await shell.booted();
    shell.$("#address-input").value = "/ListProducto";
    const submit = new shell.win.Event("submit", { cancelable: true });
    shell.$("#address-form").dispatchEvent(submit);
    assert.equal(submit.defaultPrevented, true);
    assert.deepEqual(shell.posts.at(-1).message, {
      kind: "navigate-site",
      path: "/ListProducto",
    });
    assert.match(shell.logText(), /Navigating site to \/ListProducto/u);
    assert.equal(shell.$("#back-button").disabled, false);

    shell.$("#address-input").value = "";
    shell
      .$("#address-form")
      .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
    assert.equal(shell.posts.at(-1).message.path, "/");

    shell.click("#refresh-button");
    assert.equal(shell.posts.at(-1).message.path, "/");
    shell.click("#home-button");
    assert.equal(shell.posts.at(-1).message.path, "/");
  });

  it("reloads the frame when the runtime is not booted", async () => {
    const shell = await bootShell();
    shell.emit({ kind: "ready", bootstrapped: true, path: "/" });
    shell.emit({ kind: "error", detail: "crashed" });
    shell.click("#home-button");
    await settle();
    // An errored runtime is no longer booted: navigation re-points the frame.
    assert.equal(shell.frameUrl().searchParams.get("path"), "/");
    assert.equal(FakeBroadcastChannel.instances.length, 2);
    assert.equal(FakeBroadcastChannel.instances[0].closed, true);
  });

  it("switches panels, toggles the side panel and manages logs", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const shell = await bootShell();
      for (const [tab, panel] of [
        ["#logs-tab", "#logs-panel"],
        ["#blueprint-tab", "#blueprint-panel"],
        ["#info-tab", "#info-panel"],
      ]) {
        shell.click(tab);
        assert.equal(shell.$(panel).classList.contains("is-hidden"), false);
        assert.equal(shell.$(tab).getAttribute("aria-selected"), "true");
        assert.equal(shell.$(tab).classList.contains("is-active"), true);
      }
      assert.equal(
        shell.$("#logs-panel").classList.contains("is-hidden"),
        true,
      );

      shell.click("#phpinfo-tab");
      assert.deepEqual(shell.posts.at(-1).message, { kind: "capture-phpinfo" });
      shell.click("#refresh-phpinfo-button");
      assert.equal(shell.posts.length, 2);
      assert.match(shell.logText(), /\(manual\)/u);

      shell.click("#panel-close-button");
      assert.equal(
        shell.$("#side-panel").classList.contains("is-collapsed"),
        true,
      );
      shell.click("#panel-toggle-button");
      assert.equal(
        shell.$("#side-panel").classList.contains("is-collapsed"),
        false,
      );
      assert.equal(
        shell.$("#workspace").classList.contains("is-panel-collapsed"),
        false,
      );
      assert.equal(
        shell.$("#panel-toggle-button").getAttribute("aria-expanded"),
        "true",
      );
      shell.click("#panel-close-button");
      assert.equal(
        shell.$("#side-panel").classList.contains("is-collapsed"),
        true,
      );
      assert.equal(
        shell.$("#panel-toggle-button").getAttribute("aria-expanded"),
        "false",
      );

      const logs = shell.logText();
      const iconHtml = shell.$("#copy-logs-button").innerHTML;
      shell.click("#copy-logs-button");
      await settle(2);
      assert.equal(shell.clipboardWrites.at(-1), logs);
      assert.equal(shell.$("#copy-logs-button").textContent, "✓");
      mock.timers.tick(1200);
      assert.equal(shell.$("#copy-logs-button").innerHTML, iconHtml);

      shell.click("#clear-logs-button");
      assert.equal(shell.logText(), "");
    } finally {
      mock.timers.reset();
    }
  });

  it("reports PHP info capture without a remote frame", async () => {
    const shell = await bootShell({ contentWindow: false });
    shell.click("#refresh-phpinfo-button");
    assert.match(
      shell.$("#log-panel .error").textContent,
      /remote frame not available/u,
    );
    // Without a frame window a booted runtime falls back to a frame reload.
    shell.emit({ kind: "ready", path: "/" });
    shell.click("#home-button");
    await settle();
    assert.equal(shell.registrations.length, 1);
    assert.equal(FakeBroadcastChannel.instances.length, 2);
  });

  it("copies the runtime and build IDs with temporary feedback", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const shell = await bootShell();
      shell.click("#runtime-id-chip");
      assert.equal(shell.clipboardWrites.at(-1), "php83");
      assert.equal(shell.$("#runtime-id-value").textContent, "✓ copied");
      mock.timers.tick(1400);
      assert.equal(shell.$("#runtime-id-value").textContent, "php83");

      shell.click("#build-id-chip");
      assert.equal(shell.clipboardWrites.at(-1), BUILD_VERSION);
      assert.equal(shell.$("#build-id-value").textContent, "✓ copied");
      mock.timers.tick(1400);
      assert.equal(shell.$("#build-id-value").textContent, BUILD_VERSION);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("shell runtime configuration", () => {
  it("marks a PHP version change dirty and resets onto the new runtime", async () => {
    const shell = await bootShell();
    shell.change("#info-php-version", (el) => {
      el.value = "php84";
    });
    assert.match(shell.$("#config-status").textContent, /Unsaved/u);
    assert.equal(shell.$("#config-status").className, "dirty-note");
    assert.equal(
      shell.$("#config-warning").classList.contains("is-hidden"),
      false,
    );
    assert.equal(
      shell.$("#config-reload-note").classList.contains("is-hidden"),
      true,
    );
    assert.equal(shell.$("#config-apply").textContent, "Apply & Reset");
    assert.equal(shell.$("#config-apply").classList.contains("danger"), true);

    shell.change("#info-php-version", (el) => {
      el.value = "php83";
    });
    assert.match(shell.$("#config-status").textContent, /Running/u);
    assert.equal(
      shell.$("#config-apply").classList.contains("is-hidden"),
      true,
    );

    // Nothing differs: Apply is a no-op.
    shell.click("#config-apply");
    await settle();
    assert.equal(shell.registrations.length, 1);

    shell.change("#info-php-version", (el) => {
      el.value = "php84";
    });
    shell.click("#config-apply");
    await settle();
    assert.match(shell.logText(), /Switching runtime to php84/u);
    assert.equal(shell.$("#runtime-id-value").textContent, "php84");
    assert.equal(shell.replaced.length, 1);
    assert.equal(shell.registrations.length, 2);
    assert.equal(
      shell.registrations[1].url.searchParams.get("runtime"),
      "php84",
    );
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("runtime"), "php84");
    assert.equal(frameUrl.searchParams.get("clean"), "1");
    const state = JSON.parse(
      shell.win.sessionStorage.getItem("facturascripts-playground:s1:state"),
    );
    assert.equal(state.runtimeId, "php84");
    assert.ok(state.switchedAt);
  });

  it("navigates the page to switch the core version", async () => {
    const shell = await bootShell();
    shell.change("#info-core-version", (el) => {
      el.value = "2024";
    });
    shell.click("#config-apply");
    await settle();
    assert.equal(shell.location.assigned.length, 1);
    const target = new URL(shell.location.assigned[0]);
    assert.equal(target.searchParams.get("version"), "2024");
    assert.equal(shell.replaced.length, 0);
  });

  it("drops ?version= when switching back to the latest build", async () => {
    const shell = await bootShell({
      href: "https://play.test/app/index.html?scope=s1&version=2024",
      versions: {
        default: "2024",
        versions: [{ version: "2024" }],
      },
    });
    const select = shell.$("#info-core-version");
    const latest = shell.doc.createElement("option");
    latest.value = "";
    select.append(latest);
    shell.change("#info-core-version", (el) => {
      el.value = "";
    });
    shell.click("#config-apply");
    await settle();
    assert.equal(
      new URL(shell.location.assigned[0]).searchParams.has("version"),
      false,
    );
  });

  it("flushes persistence before an OPcache-only restart", async () => {
    const shell = await bootShell();
    await shell.booted();
    shell.change("#info-opcache", (el) => {
      el.checked = false;
    });
    assert.equal(
      shell.$("#config-reload-note").classList.contains("is-hidden"),
      false,
    );
    assert.equal(
      shell.$("#config-warning").classList.contains("is-hidden"),
      true,
    );
    assert.equal(shell.$("#config-apply").textContent, "Apply & Reload");
    assert.equal(shell.$("#config-apply").classList.contains("danger"), false);

    shell.click("#config-apply");
    await settle(2);
    assert.deepEqual(shell.posts.at(-1).message, { kind: "flush-persistence" });
    assert.match(shell.logText(), /OPcache disabled; restarting PHP/u);
    assert.equal(shell.replaced.length, 0);

    shell.emit({ kind: "persistence-flushed" });
    await settle();
    assert.equal(new URL(shell.replaced[0]).searchParams.get("opcache"), "0");
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("opcache"), "0");
    assert.equal(frameUrl.searchParams.get("clean"), null);

    // Re-enabling matches the config default, so ?opcache= is removed.
    shell.change("#info-opcache", (el) => {
      el.checked = true;
    });
    shell.click("#config-apply");
    await settle();
    assert.equal(new URL(shell.replaced[1]).searchParams.has("opcache"), false);
    assert.match(shell.logText(), /OPcache enabled; restarting PHP/u);
  });

  it("restarts anyway when the persistence flush times out", async () => {
    const shell = await bootShell();
    await shell.booted();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      shell.change("#info-opcache", (el) => {
        el.checked = false;
      });
      shell.click("#config-apply");
      await settle(2);
      assert.equal(shell.replaced.length, 0);
      mock.timers.tick(60_000);
      await settle();
      assert.match(
        shell.$("#log-panel .error").textContent,
        /Persistence flush did not finish in time/u,
      );
      assert.equal(shell.replaced.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("skips the flush when the remote frame cannot receive it", async () => {
    const shell = await bootShell({ contentWindow: false });
    shell.emit({ kind: "ready", path: "/" });
    shell.change("#info-opcache", (el) => {
      el.checked = false;
    });
    shell.click("#config-apply");
    await settle();
    assert.match(shell.logText(), /Flushing the persistence journal/u);
    assert.equal(shell.replaced.length, 1);
  });
});

describe("shell blueprint import/export and reset", () => {
  it("exports the current blueprint as a JSON download", async () => {
    const shell = await bootShell();
    await shell.booted();
    const blobs = [];
    const create = mock.method(URL, "createObjectURL", (blob) => {
      blobs.push(blob);
      return "blob:test/1";
    });
    const revoke = mock.method(URL, "revokeObjectURL", () => {});
    const clicks = [];
    const proto = shell.win.HTMLAnchorElement.prototype;
    const originalClick = proto.click;
    proto.click = function recordClick() {
      clicks.push({ href: this.href, download: this.download });
    };
    try {
      shell.click("#export-button");
      assert.deepEqual(clicks, [
        {
          href: "blob:test/1",
          download: "facturascripts-playground.blueprint.json",
        },
      ]);
      assert.equal(revoke.mock.calls[0].arguments[0], "blob:test/1");
      const exported = JSON.parse(await blobs[0].text());
      assert.equal(exported.siteOptions.title, "Shell Test");

      const textarea = shell.$("#blueprint-textarea");
      textarea.value = "{ not json";
      textarea.dispatchEvent(new shell.win.Event("input"));
      shell.click("#export-button");
      assert.equal(clicks.length, 1);
      assert.match(
        shell.$("#log-panel .error").textContent,
        /Cannot export blueprint:/u,
      );
    } finally {
      proto.click = originalClick;
      create.mock.restore();
      revoke.mock.restore();
    }
  });

  const importFile = (shell, files) => {
    const input = shell.$("#import-input");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new shell.win.Event("change"));
  };
  const fakeFile = (name, text) => ({ name, text: async () => text });

  it("imports a snapshot into the running runtime", async () => {
    const shell = await bootShell();
    importFile(shell, [
      fakeFile(
        "snap.json",
        JSON.stringify({
          version: 1,
          runtimeId: "php84",
          path: "/ListAlbaran",
        }),
      ),
    ]);
    await settle();
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("runtime"), "php84");
    assert.equal(frameUrl.searchParams.get("path"), "/ListAlbaran");
    assert.equal(shell.$("#address-input").value, "/ListAlbaran");
    assert.match(shell.logText(), /Imported configuration from snap\.json/u);
    const state = JSON.parse(
      shell.win.sessionStorage.getItem("facturascripts-playground:s1:state"),
    );
    assert.ok(state.importedAt);

    importFile(shell, [fakeFile("snap2.json", JSON.stringify({ version: 1 }))]);
    await settle();
    assert.equal(shell.frameUrl().searchParams.get("runtime"), "php84");
    assert.equal(shell.frameUrl().searchParams.get("path"), "/");
  });

  it("reboots the page with an imported blueprint", async () => {
    const shell = await bootShell();
    importFile(shell, [
      fakeFile("bp.json", JSON.stringify({ landingPage: "/Imported" })),
    ]);
    await settle();
    assert.equal(shell.location.assigned.length, 1);
    const target = new URL(shell.location.assigned[0]);
    assert.ok(target.searchParams.get("blueprint"));
  });

  it("logs an unreadable import and ignores an empty selection", async () => {
    const shell = await bootShell();
    importFile(shell, [fakeFile("bad.json", "{")]);
    await settle();
    assert.match(shell.$("#log-panel .error").textContent, /JSON/u);
    assert.equal(shell.$("#import-input").value, "");

    const before = shell.logText();
    importFile(shell, []);
    await settle();
    assert.equal(shell.logText(), before);
  });

  it("resets the playground to a clean default boot", async () => {
    const shell = await bootShell({
      session: {
        "facturascripts-playground:s1:active-blueprint": "{}",
      },
    });
    await shell.booted();
    shell.emit({ kind: "ready", path: "/Dashboard" });
    shell.emit({ kind: "ready", path: "/ListCliente" });
    assert.equal(shell.$("#back-button").disabled, false);

    const textarea = shell.$("#blueprint-textarea");
    textarea.value = '{"meta":{"title":"Edited"}}';
    textarea.dispatchEvent(new shell.win.Event("input"));

    shell.click("#reset-button");
    await settle();
    assert.equal(
      shell.win.sessionStorage.getItem("facturascripts-playground:s1:state"),
      null,
    );
    assert.equal(shell.$("#back-button").disabled, true);
    assert.equal(shell.$("#address-input").value, "/");
    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.searchParams.get("clean"), "1");
    assert.equal(frameUrl.searchParams.get("path"), "/");
    assert.equal(shell.registrations.length, 2);
    assert.equal(JSON.parse(textarea.value).meta.title, "Shell Test Blueprint");
    assert.match(shell.$("#phpinfo-frame").srcdoc, /No PHP diagnostics/u);
  });

  it("keeps a URL-supplied blueprint across a reset", async () => {
    const shell = await bootShell({
      href: "https://play.test/app/index.html?scope=s1&blueprint-url=https://bp.test/keep.json",
      routes: {
        "https://bp.test/keep.json": {
          landingPage: "/Kept",
          meta: { title: "Kept" },
        },
      },
    });
    await shell.booted();
    shell.click("#reset-button");
    await settle();
    assert.equal(shell.frameUrl().searchParams.get("path"), "/Kept");
    assert.equal(
      JSON.parse(shell.$("#blueprint-textarea").value).meta.title,
      "Kept",
    );
  });
});
