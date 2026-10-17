import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPCACHE_SAPI_NAME } from "../src/runtime/php-loader.js";
import { isOpcacheEnabled } from "../src/shared/config.js";
import { resolveRemoteUrl } from "../src/shared/paths.js";

describe("isOpcacheEnabled", () => {
  it("defaults to the config key, off when absent", () => {
    assert.equal(isOpcacheEnabled(null, {}), false);
    assert.equal(isOpcacheEnabled(null, { opcache: false }), false);
    assert.equal(isOpcacheEnabled(null, { opcache: true }), true);
    assert.equal(isOpcacheEnabled("", { opcache: true }), true);
  });

  it("lets the URL parameter override the config in both directions", () => {
    assert.equal(isOpcacheEnabled("1", { opcache: false }), true);
    assert.equal(isOpcacheEnabled("true", {}), true);
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      assert.equal(isOpcacheEnabled(off, { opcache: true }), false, off);
    }
  });
});

describe("opcache runtime plumbing", () => {
  it("reports a SAPI name on PHP's OPcache whitelist that FacturaScripts never branches on", () => {
    // Every php_sapi_name()/PHP_SAPI check in Core/ and vendor/ compares
    // against "cli" (or strpos(..., "cli")): the name must not contain it and
    // must not be a cgi* variant (Status: header path).
    assert.equal(OPCACHE_SAPI_NAME, "uwsgi");
    assert.ok(!OPCACHE_SAPI_NAME.includes("cli"));
    assert.ok(!OPCACHE_SAPI_NAME.startsWith("cgi"));
  });

  it("forwards the opcache parameter to the runtime host only when set", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { href: "https://example.com/playground/index.html" },
      },
      configurable: true,
      writable: true,
    });
    try {
      const withFlag = resolveRemoteUrl(
        "scope-1",
        "php83",
        "/",
        "2026.51",
        "1",
      );
      assert.equal(withFlag.searchParams.get("opcache"), "1");
      const without = resolveRemoteUrl("scope-1", "php83", "/", "2026.51");
      assert.equal(without.searchParams.has("opcache"), false);
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "window", original);
      } else {
        delete globalThis.window;
      }
    }
  });
});
