import assert from "node:assert/strict";
import { it } from "node:test";

it("reports a listener installation failure to the host and rethrows", async () => {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const messages = [];
  globalThis.self = {
    location: new URL(
      "https://example.test/php-worker.js?scope=s9&runtime=php83",
    ),
    addEventListener() {
      throw new Error("listeners unavailable");
    },
    postMessage: (message) => messages.push(message),
  };
  try {
    await assert.rejects(import("../php-worker.js"), /listeners unavailable/);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, "worker-startup-error");
    assert.equal(messages[0].scopeId, "s9");
    assert.equal(messages[0].runtimeId, "php83");
    assert.match(messages[0].detail, /^Error: listeners unavailable/);
  } finally {
    if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
    else delete globalThis.self;
  }
});
