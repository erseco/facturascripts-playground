import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  blueprintSourceKey,
  buildScopedSitePath,
  getBasePathFromPathname,
  hasBlueprintUrlOverride,
  resolveAppUrl,
  resolveConfiguredProxyUrl,
  resolveProjectUrl,
} from "../src/shared/paths.js";

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

const PAGE = "https://example.org/fs/index.html";

describe("resolveProjectUrl", () => {
  it("resolves against the bundler-injected __APP_ROOT__ when present", () => {
    restores.push(overrideGlobal("__APP_ROOT__", "https://cdn.test/app/"));
    assert.equal(
      resolveProjectUrl("assets/manifests/latest.json").href,
      "https://cdn.test/app/assets/manifests/latest.json",
    );
  });
});

describe("getBasePathFromPathname", () => {
  it("treats an empty pathname as the root", () => {
    assert.equal(getBasePathFromPathname(""), "/");
    assert.equal(getBasePathFromPathname(null), "/");
  });
});

describe("hasBlueprintUrlOverride", () => {
  it("parses string locations and defaults to window.location", () => {
    restores.push(
      overrideGlobal("window", {
        location: { href: `${PAGE}?blueprint-sid=1` },
      }),
    );
    assert.equal(hasBlueprintUrlOverride(), true);
    assert.equal(hasBlueprintUrlOverride(""), true);
    assert.equal(hasBlueprintUrlOverride("?blueprint-data=x"), true);
    assert.equal(hasBlueprintUrlOverride("/fs/?foo=1"), false);
  });
});

describe("resolveAppUrl", () => {
  it("returns the current location for an empty path", () => {
    const current = new URL(PAGE);
    assert.equal(resolveAppUrl("", current), current);
    assert.equal(resolveAppUrl(undefined, PAGE).href, PAGE);
  });

  it("falls back to globalThis.location, then localhost", () => {
    assert.equal(resolveAppUrl("proxy").href, "http://localhost/proxy");
    restores.push(overrideGlobal("location", { href: PAGE }));
    assert.equal(resolveAppUrl("proxy").href, "https://example.org/fs/proxy");
  });
});

describe("resolveConfiguredProxyUrl", () => {
  it("uses the proxy path off localhost when no proxy URL is configured", () => {
    assert.equal(
      resolveConfiguredProxyUrl({ addonProxyPath: "/zip-proxy" }, PAGE).href,
      "https://example.org/fs/zip-proxy",
    );
  });

  it("returns null when nothing is configured", () => {
    assert.equal(resolveConfiguredProxyUrl({}, new URL(PAGE)), null);
    assert.equal(resolveConfiguredProxyUrl(), null);
  });

  it("prefers the local proxy path on a dev host from globalThis.location", () => {
    restores.push(
      overrideGlobal("location", { href: "http://127.0.0.1:8085/" }),
    );
    assert.equal(
      resolveConfiguredProxyUrl({
        proxyPath: "/proxy",
        proxyUrl: "https://proxy.example.org/",
      }).href,
      "http://127.0.0.1:8085/proxy",
    );
  });
});

describe("buildScopedSitePath", () => {
  it("adds a leading slash to a relative request path", () => {
    restores.push(
      overrideGlobal("window", { location: { pathname: "/fs/index.html" } }),
    );
    assert.equal(
      buildScopedSitePath("s1", "php83", "admin"),
      "/fs/playground/s1/php83/admin",
    );
    assert.equal(
      buildScopedSitePath("s1", "php83"),
      "/fs/playground/s1/php83/",
    );
  });
});

describe("blueprintSourceKey", () => {
  it("keys a stored blueprint by its sid and defaults to window.location", () => {
    assert.equal(blueprintSourceKey(`${PAGE}?blueprint-sid=abc`), "sid:abc");
    restores.push(overrideGlobal("window", { location: { href: PAGE } }));
    assert.equal(blueprintSourceKey(), "default");
  });
});
