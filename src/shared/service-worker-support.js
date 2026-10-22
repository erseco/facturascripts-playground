import { BUILD_VERSION } from "../generated/build-version.js";

// Service Worker availability probe.
//
// `navigator.serviceWorker` is undefined in iOS Safari private browsing, in a
// non-secure context, and wherever the API is disabled by policy. Reading it
// unguarded threw "undefined is not an object (evaluating
// 'navigator.serviceWorker.register')" and left the user on a blank page, so
// every boot-path access is gated on this probe first.

export const SERVICE_WORKER_UNSUPPORTED_ERROR_NAME =
  "ServiceWorkerUnsupportedError";

export const SERVICE_WORKER_UNSUPPORTED_MESSAGE =
  "Service Workers are unavailable in this browser context. Private browsing " +
  "on iOS Safari disables them, and the playground cannot run without one.";

/** True when this context exposes a usable Service Worker registration API. */
export function isServiceWorkerSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof navigator.serviceWorker?.register === "function"
  );
}

/**
 * The error thrown at each registration site when the API is missing. Callers
 * match on `name` to report it as an environment limitation (warning) instead
 * of a runtime regression (exception).
 */
export function createServiceWorkerUnsupportedError() {
  const error = new Error(SERVICE_WORKER_UNSUPPORTED_MESSAGE);
  error.name = SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
  return error;
}

export function isServiceWorkerUnsupportedError(error) {
  return error?.name === SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
}

// Firefox before 147 (ESR 128/140 included) cannot run module Service Workers:
// sw.js's `import` lines made registration fail with "threw an exception during
// script evaluation". The build bundles sw.js into this classic script at the
// site root (a Service Worker's maximum scope is its own directory).
export const SERVICE_WORKER_SCRIPT = "sw.bundle.js";

/**
 * The worker script URL, versioned only by the build. sw.js reads no query
 * parameter, and a per-scope or per-runtime one gave each tab a different
 * script, so opening a new scope replaced the worker of every open tab.
 * `appRootUrl` is the app's base directory URL (where sw.bundle.js lives).
 */
export function serviceWorkerScriptUrl(appRootUrl) {
  const url = new URL(SERVICE_WORKER_SCRIPT, appRootUrl);
  url.searchParams.set("v", BUILD_VERSION);
  return url;
}

/** Register the runtime Service Worker as a classic script for scope "./". */
export async function registerClassicServiceWorker(swUrl) {
  if (!isServiceWorkerSupported()) {
    throw createServiceWorkerUnsupportedError();
  }

  const registration = await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    updateViaCache: "none",
  });
  try {
    await registration?.update();
  } catch {
    // Offline or a transient fetch error: the installed worker keeps serving.
  }
  return registration;
}

// Cross-origin requests go straight to the network: Firefox never settles a
// respondWith(fetch(event.request)) pass-through whose response is a
// cross-origin redirect, which hung blueprint downloads from the PHP worker.
// See CHANGELOG-TECHNICAL.md "Service Worker skips cross-origin requests".
export function shouldInterceptRequest(url, swOrigin) {
  return url.origin === swOrigin;
}
