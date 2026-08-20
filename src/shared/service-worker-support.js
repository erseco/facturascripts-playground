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
