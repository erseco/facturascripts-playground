import { BUILD_VERSION } from "../generated/build-version.js";
import { loadActiveBlueprint } from "../shared/blueprint.js";
import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { buildScopedSitePath } from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import { acquireScopeOwnership } from "../shared/scope-ownership.js";
import {
  createServiceWorkerUnsupportedError,
  isServiceWorkerSupported,
  isServiceWorkerUnsupportedError,
  registerClassicServiceWorker,
  SERVICE_WORKER_UNSUPPORTED_MESSAGE,
  serviceWorkerScriptUrl,
} from "../shared/service-worker-support.js";
import { saveSessionState } from "../shared/storage.js";

const overlayEl = document.querySelector(".remote-boot__card");
const statusEl = document.querySelector("#remote-status");
const progressFillEl = document.querySelector("#progress-fill");
const progressPercentEl = document.querySelector("#progress-percent");
const frameEl = document.querySelector("#remote-frame");
let phpWorker;
const instanceId =
  new URL(window.location.href).searchParams.get("instance") ||
  globalThis.crypto.randomUUID();
let releaseScope;
let disposed = false;
let bootstrapTask;
window.addEventListener("pagehide", () => {
  disposed = true;
  phpWorker?.terminate();
  bootstrapTask.then(
    () => releaseScope?.(),
    () => releaseScope?.(),
  );
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
let _activeScopeId;
let _activeRuntimeId;
let activePath = "/";
let forceCleanBoot = false;

function setOverlayVisible(isVisible) {
  overlayEl?.classList.toggle("is-hidden", !isVisible);
}

function setRemoteProgress(detail, progress = null) {
  if (statusEl && detail) {
    statusEl.textContent = detail;
  }
  if (typeof progress === "number") {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (progressFillEl) {
      progressFillEl.style.width = `${pct}%`;
    }
    if (progressPercentEl) {
      progressPercentEl.textContent = `${pct}%`;
    }
  }
}

function emit(scopeId, message) {
  if (message?.kind === "progress") {
    setRemoteProgress(message.detail, message.progress);
  }
  if (message?.kind === "error") {
    setRemoteProgress(message.detail);
  }

  const channel = new BroadcastChannel(createShellChannel(scopeId, instanceId));
  channel.postMessage(message);
  channel.close();
}

async function registerRuntimeServiceWorker() {
  // Probe before touching the API: `navigator.serviceWorker` is undefined in
  // iOS Safari private browsing and in non-secure contexts.
  if (!isServiceWorkerSupported()) {
    throw createServiceWorkerUnsupportedError();
  }

  if (navigator.serviceWorker?.controller) {
    return navigator.serviceWorker.ready;
  }

  const registration = await registerClassicServiceWorker(
    serviceWorkerScriptUrl(new URL("../../", import.meta.url)),
  );

  await navigator.serviceWorker?.ready;
  return registration;
}

async function waitForServiceWorkerControl() {
  // Bound to a local so a missing container short-circuits instead of hanging
  // forever on a "controllerchange" listener that can never be attached.
  const container = navigator.serviceWorker;
  if (container && !container.controller) {
    await new Promise((resolve) => {
      container.addEventListener("controllerchange", resolve, { once: true });
    });
  }
}

async function waitForPhpWorkerReady(scopeId, runtimeId, worker) {
  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          `Timed out while waiting for php-worker readiness for ${runtimeId}.`,
        ),
      );
    }, 15000);

    const handleReady = (message) => {
      if (message?.kind !== "worker-ready") {
        return false;
      }

      if (message.scopeId !== scopeId || message.runtimeId !== runtimeId) {
        return false;
      }

      window.clearTimeout(timeoutId);
      worker.removeEventListener("message", onWorkerMessage);
      resolve();
      return true;
    };

    const onWorkerMessage = (event) => {
      handleReady(event.data);
    };

    worker.addEventListener("message", onWorkerMessage);
  });
}

function extractUnscopedPath(locationLike, scopeId, runtimeId) {
  const url = new URL(String(locationLike), window.location.origin);
  const match = url.pathname.match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (match && match[1] === scopeId && match[2] === runtimeId) {
    return `${match[3] || "/"}${url.search}${url.hash}`;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function emitNavigation(scopeId, runtimeId, href) {
  emit(scopeId, {
    kind: "navigate",
    path: extractUnscopedPath(href, scopeId, runtimeId),
  });
}

function buildEntryUrl(scopeId, runtimeId, path) {
  return new URL(
    buildScopedSitePath(scopeId, runtimeId, path),
    window.location.origin,
  );
}

function navigateFrame(scopeId, runtimeId, path) {
  const entryUrl = buildEntryUrl(scopeId, runtimeId, path);
  activePath = path;

  if (frameEl.src !== entryUrl.toString()) {
    frameEl.src = entryUrl.toString();
  } else if (frameEl.contentWindow) {
    frameEl.contentWindow.location.href = entryUrl.toString();
  }
}

function bindFrameNavigation(scopeId, runtimeId) {
  frameEl.addEventListener("load", () => {
    let path = activePath;
    try {
      if (frameEl.contentWindow?.location?.href) {
        path = extractUnscopedPath(
          frameEl.contentWindow.location.href,
          scopeId,
          runtimeId,
        );
      }
    } catch {
      // Ignore transient about:blank/cross-context timing during iframe swaps.
    }

    activePath = path;
    setOverlayVisible(false);
    emit(scopeId, {
      kind: "ready",
      detail: `Iframe loaded for ${runtimeId}.`,
      path,
    });
    emitNavigation(
      scopeId,
      runtimeId,
      frameEl.contentWindow?.location?.href ||
        buildEntryUrl(scopeId, runtimeId, path).toString(),
    );
  });
}

function bindShellCommands(scopeId, runtimeId) {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (message?.kind === "navigate-site") {
      navigateFrame(scopeId, runtimeId, message.path || "/");
      return;
    }

    if (message?.kind === "capture-phpinfo" && phpWorker) {
      phpWorker.postMessage({ kind: "capture-phpinfo" });
      return;
    }

    if (message?.kind === "flush-persistence" && phpWorker) {
      phpWorker.postMessage({ kind: "flush-persistence" });
      return;
    }
  });
}

async function bootstrapRemote() {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  releaseScope = await acquireScopeOwnership(scopeId);
  if (disposed) {
    releaseScope();
    return;
  }
  const requestedRuntimeId = url.searchParams.get("runtime");
  const coreVersion = url.searchParams.get("core") || "";
  const requestedPath = url.searchParams.get("path") || "/";
  forceCleanBoot = url.searchParams.get("clean") === "1";
  const opcacheParam = url.searchParams.get("opcache") || null;
  _activeScopeId = scopeId;
  _activeRuntimeId = requestedRuntimeId;
  activePath = requestedPath;
  const config = await loadPlaygroundConfig();
  const blueprint = loadActiveBlueprint(scopeId);
  const runtime =
    config.runtimes.find((entry) => entry.id === requestedRuntimeId) ||
    getDefaultRuntime(config);
  setOverlayVisible(true);

  setRemoteProgress(
    "Registering the Service Worker and bootstrapping the PHP CGI worker.",
    0.08,
  );
  emit(scopeId, {
    kind: "progress",
    title: "Preparing runtime",
    detail: `Registering service worker for ${runtime.label}.`,
    progress: 0.08,
  });

  await registerRuntimeServiceWorker();
  await waitForServiceWorkerControl();
  setRemoteProgress("Service Worker ready and controlling this tab.", 0.12);

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      kind: "configure-service-worker",
      addonProxyUrl: config.addonProxyUrl || null,
    });
  }

  if (forceCleanBoot && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({
      kind: "clear-static-cache",
    });
  }

  if (disposed) return;
  if (!phpWorker) {
    const workerUrl = new URL(
      "../../dist/php-worker.bundle.js",
      import.meta.url,
    );
    // Cache-bust the worker bundle (fixed filename, not SW-cached) so a redeploy
    // never serves a stale runtime from the browser HTTP cache.
    workerUrl.searchParams.set("v", BUILD_VERSION);
    workerUrl.searchParams.set("scope", scopeId);
    workerUrl.searchParams.set("instance", instanceId);
    workerUrl.searchParams.set("runtime", runtime.id);
    workerUrl.searchParams.set("core", coreVersion);
    if (opcacheParam) {
      workerUrl.searchParams.set("opcache", opcacheParam);
    }
    phpWorker = new Worker(workerUrl, { type: "module" });
    phpWorker.addEventListener("error", (event) => {
      const detail =
        event.message || "php-worker failed before signalling readiness.";
      setRemoteProgress(detail);
      emit(scopeId, {
        kind: "error",
        detail,
      });
    });
    phpWorker.addEventListener("messageerror", () => {
      const detail = "php-worker posted a malformed message.";
      setRemoteProgress(detail);
      emit(scopeId, {
        kind: "error",
        detail,
      });
    });
    const workerReadyPromise = waitForPhpWorkerReady(
      scopeId,
      runtime.id,
      phpWorker,
    );
    phpWorker.postMessage({
      kind: "configure-blueprint",
      runtimeParams: {
        scopeId,
        runtimeId: runtime.id,
        instanceId,
        coreVersion,
        opcacheParam,
      },
      blueprint,
      clean: forceCleanBoot,
    });
    await workerReadyPromise;
  }
  setRemoteProgress(`php-worker ready for ${runtime.id}.`, 0.16);

  saveSessionState(scopeId, {
    coreVersion,
    runtimeId: runtime.id,
    path: requestedPath,
  });

  // Listen to the shell channel so bootstrap progress from the PHP worker
  // (0.2 → 0.95) updates the loading overlay in real time.
  const shellChannel = new BroadcastChannel(
    createShellChannel(scopeId, instanceId),
  );
  let bootstrapDone = false;
  shellChannel.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.kind === "progress") {
      setRemoteProgress(msg.detail, msg.progress);
      if (msg.detail?.includes("is ready")) {
        bootstrapDone = true;
      }
    }
  });

  // Show progress while the iframe loads static assets after bootstrap.
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.kind === "sw-debug" && bootstrapDone) {
      setRemoteProgress("Loading page assets\u2026", 0.97);
    }
  });

  bindShellCommands(scopeId, runtime.id);
  bindFrameNavigation(scopeId, runtime.id);
  navigateFrame(scopeId, runtime.id, requestedPath);
  setRemoteProgress(
    "Runtime host registered. Waiting for the PHP worker to finish bootstrap.",
    0.18,
  );

  emit(scopeId, {
    kind: "progress",
    title: "Runtime host ready",
    detail: "The embedded FacturaScripts iframe is loading.",
    progress: 0.18,
  });
}

bootstrapTask = bootstrapRemote();
bootstrapTask.catch((error) => {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  // A browser without Service Workers (iOS Safari private browsing, insecure
  // context) is an environment limitation, not a runtime regression: the shell
  // reports it as a warning under its own source so it groups separately.
  const unsupported = isServiceWorkerUnsupportedError(error);
  const detail = unsupported
    ? SERVICE_WORKER_UNSUPPORTED_MESSAGE
    : [String(error?.message || error), error?.stack]
        .filter(Boolean)
        .join("\n");
  setOverlayVisible(true);
  setRemoteProgress(
    unsupported
      ? SERVICE_WORKER_UNSUPPORTED_MESSAGE
      : String(error?.message || error),
  );
  emit(scopeId, {
    kind: "error",
    detail,
    level: unsupported ? "warning" : "error",
    source: unsupported ? "service-worker-unsupported" : "runtime",
  });
});
