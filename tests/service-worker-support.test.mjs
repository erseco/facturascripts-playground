import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createServiceWorkerUnsupportedError,
  isServiceWorkerSupported,
  isServiceWorkerUnsupportedError,
  registerClassicServiceWorker,
  SERVICE_WORKER_SCRIPT,
  SERVICE_WORKER_UNSUPPORTED_ERROR_NAME,
  SERVICE_WORKER_UNSUPPORTED_MESSAGE,
} from "../src/shared/service-worker-support.js";

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

describe("isServiceWorkerSupported", () => {
  it("is true when the registration API is callable", () => {
    setNavigator({ serviceWorker: { register() {} } });
    assert.equal(isServiceWorkerSupported(), true);
  });

  // iOS Safari private browsing: the property is simply absent.
  it("is false when navigator has no serviceWorker property", () => {
    setNavigator({});
    assert.equal(isServiceWorkerSupported(), false);
  });

  it("is false when serviceWorker is present but undefined", () => {
    setNavigator({ serviceWorker: undefined });
    assert.equal(isServiceWorkerSupported(), false);
  });

  it("is false when register() is not a function", () => {
    setNavigator({ serviceWorker: { register: null } });
    assert.equal(isServiceWorkerSupported(), false);
  });

  it("is false when there is no navigator at all", () => {
    Reflect.deleteProperty(globalThis, "navigator");
    assert.equal(isServiceWorkerSupported(), false);
  });
});

describe("createServiceWorkerUnsupportedError", () => {
  it("carries a stable name and a human-readable message", () => {
    const error = createServiceWorkerUnsupportedError();
    assert.ok(error instanceof Error);
    assert.equal(error.name, SERVICE_WORKER_UNSUPPORTED_ERROR_NAME);
    assert.equal(error.message, SERVICE_WORKER_UNSUPPORTED_MESSAGE);
    assert.match(error.message, /private browsing on iOS Safari/i);
  });

  it("is distinguishable from any other failure", () => {
    assert.equal(
      isServiceWorkerUnsupportedError(createServiceWorkerUnsupportedError()),
      true,
    );
    assert.equal(
      isServiceWorkerUnsupportedError(new TypeError("Rejected")),
      false,
    );
    assert.equal(isServiceWorkerUnsupportedError(undefined), false);
    assert.equal(isServiceWorkerUnsupportedError("Rejected"), false);
  });
});

describe("registerClassicServiceWorker", () => {
  function fakeContainer(registration) {
    const calls = [];
    return {
      calls,
      register(url, options) {
        calls.push({ url, options });
        return Promise.resolve(registration);
      },
    };
  }

  // Sentry 151476400: Firefox < 147 (ESR 128/140) cannot run module Service
  // Workers, so sw.js "threw an exception during script evaluation".
  it("registers the classic sw.bundle.js, not a module worker", async () => {
    const container = fakeContainer({ update: async () => {} });
    setNavigator({ serviceWorker: container });
    await registerClassicServiceWorker(
      new URL(`https://example.test/${SERVICE_WORKER_SCRIPT}`),
    );
    assert.equal(SERVICE_WORKER_SCRIPT, "sw.bundle.js");
    assert.equal(container.calls.length, 1);
    assert.notEqual(container.calls[0].options.type, "module");
    assert.equal(container.calls[0].options.scope, "./");
  });

  // Sentry 151132281: update() failing (offline) or a registration without
  // update() must not abort the boot; the installed worker keeps serving.
  it("tolerates a failing update() and a missing registration", async () => {
    setNavigator({
      serviceWorker: fakeContainer({
        update: () => Promise.reject(new TypeError("Failed to update")),
      }),
    });
    await registerClassicServiceWorker(
      new URL("https://example.test/sw.bundle.js"),
    );
    setNavigator({ serviceWorker: fakeContainer(undefined) });
    await registerClassicServiceWorker(
      new URL("https://example.test/sw.bundle.js"),
    );
  });

  it("throws the unsupported error without the API", async () => {
    setNavigator({});
    await assert.rejects(
      registerClassicServiceWorker(
        new URL("https://example.test/sw.bundle.js"),
      ),
      (error) => isServiceWorkerUnsupportedError(error),
    );
  });
});
