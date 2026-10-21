import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildEvent,
  captureException,
  captureMessage,
  createMonitoringClient,
  initMonitoring,
  parseStackFrames,
} from "../src/shared/monitoring.js";

const DSN = "https://abc@o1.ingest.sentry.io/42";

function overrideGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  };
}

const restores = [];
afterEach(() => {
  while (restores.length) restores.pop()();
});

function capturing() {
  const events = [];
  const fetchImpl = (_url, init) => {
    events.push(JSON.parse(init.body.trim().split("\n")[2]));
    return Promise.resolve();
  };
  return { events, fetchImpl };
}

describe("parseStackFrames limits", () => {
  it("keeps at most 50 frames", () => {
    const stack = Array.from(
      { length: 60 },
      (_, i) => `at f${i} (app.js:${i + 1}:1)`,
    ).join("\n");
    const frames = parseStackFrames(stack);
    assert.equal(frames.length, 50);
    assert.equal(frames[0].function, "f49");
    assert.equal(frames.at(-1).function, "f0");
  });
});

describe("buildEvent environment and request context", () => {
  it("falls back to a random hex id without crypto.randomUUID", () => {
    restores.push(overrideGlobal("crypto", {}));
    const event = buildEvent({ message: "m", environment: "x" });
    assert.match(event.event_id, /^[0-9a-f]{32}$/);
  });

  it("detects development hosts and attaches page URL and user agent", () => {
    restores.push(
      overrideGlobal("location", {
        hostname: "fs.local",
        href: "http://fs.local/app",
      }),
      overrideGlobal("navigator", { userAgent: "TestAgent/1" }),
    );
    const event = buildEvent({ message: "m" });
    assert.equal(event.environment, "development");
    assert.deepEqual(event.request, {
      url: "http://fs.local/app",
      headers: { "User-Agent": "TestAgent/1" },
    });
  });

  it("reports production and omits headers without a user agent", () => {
    restores.push(
      overrideGlobal("location", {
        hostname: "example.org",
        href: "https://example.org/",
      }),
      overrideGlobal("navigator", {}),
    );
    const event = buildEvent({ error: { message: "plain" } });
    assert.equal(event.environment, "production");
    assert.deepEqual(event.request, { url: "https://example.org/" });
    assert.equal(event.exception.values[0].type, "Error");
    assert.equal(event.exception.values[0].stacktrace, undefined);
  });
});

describe("client resilience", () => {
  it("swallows errors raised while building an exception or message event", () => {
    const { events, fetchImpl } = capturing();
    const client = createMonitoringClient({ dsn: DSN, fetchImpl });
    const hostile = new Error("x");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("stack getter");
      },
    });
    assert.doesNotThrow(() => client.captureException(hostile));
    assert.doesNotThrow(() =>
      client.captureMessage({
        toString() {
          throw new Error("toString");
        },
      }),
    );
    assert.equal(events.length, 0);
  });
});

describe("module-level capture helpers", () => {
  it("routes message-only window errors and helpers through the active client", () => {
    const { events, fetchImpl } = capturing();
    const handlers = new Map();
    initMonitoring({
      dsn: DSN,
      fetchImpl,
      environment: "test",
      scope: { addEventListener: (name, fn) => handlers.set(name, fn) },
    });
    handlers.get("error")({ message: "Script error." });
    handlers.get("error")({});
    handlers.get("unhandledrejection")(undefined);
    captureException(new Error("helper"), { a: 1 });
    captureMessage("note");
    assert.deepEqual(
      events.map((e) => e.message?.formatted ?? e.exception.values[0].value),
      ["Script error.", "Unhandled rejection", "helper", "note"],
    );
    assert.equal(events[0].level, "error");
    assert.deepEqual(events[0].extra, { source: "window.onerror" });
    assert.equal(events[3].level, "info");
  });
});
