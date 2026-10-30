import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  fetchBootAsset,
  fetchBundleWithCache,
  fetchManifest,
  fetchWithProgress,
  resolveBootstrapArchive,
} from "../lib/facturascripts-loader.js";

const realFetch = globalThis.fetch;
const realCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realCaches) Object.defineProperty(globalThis, "caches", realCaches);
  else delete globalThis.caches;
});

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const MANIFEST = {
  _manifestUrl: "https://example.test/assets/manifests/latest.json",
  bundle: { path: "../facturascripts/core.tar.zst", sha256: SHA },
};
const BUNDLE_URL = "https://example.test/assets/facturascripts/core.tar.zst";

function fakeCaches({ stored, openFails = false, putFails = false } = {}) {
  const log = [];
  const store = new Map(stored ? [[BUNDLE_URL, stored]] : []);
  globalThis.caches = {
    async open(name) {
      log.push(["open", name]);
      if (openFails) throw new Error("no cache api");
      return {
        async match(url) {
          const bytes = store.get(url);
          return bytes ? new Response(bytes) : undefined;
        },
        async delete(url) {
          log.push(["delete", url]);
          store.delete(url);
        },
        async put(url, response) {
          if (putFails) throw new Error("quota");
          log.push(["put", url, response.headers.get("content-type")]);
          store.set(url, new Uint8Array(await response.arrayBuffer()));
        },
      };
    },
  };
  return { log, store };
}

function serveBytes(bytes, { lengthHeader = true } = {}) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(bytes, {
      headers: lengthHeader ? { "content-length": String(bytes.length) } : {},
    });
  };
  return urls;
}

describe("fetchBootAsset", () => {
  it("describes a non-Error rejection by its string value", async () => {
    globalThis.fetch = async () => {
      throw "offline";
    };
    await assert.rejects(
      fetchBootAsset("https://example.test/a.json?v=1", undefined, "manifest"),
      {
        message:
          "Network error while fetching manifest (https://example.test/a.json): offline",
      },
    );
  });
});

describe("fetchWithProgress", () => {
  it("streams a sized body and reports monotonic progress", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    globalThis.fetch = async () =>
      new Response(body, { headers: { "content-length": "4" } });
    const progress = [];
    const bytes = await fetchWithProgress("https://example.test/b", (p) =>
      progress.push(p),
    );
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.deepEqual(progress, [
      { loaded: 2, total: 4, ratio: 0.5 },
      { loaded: 4, total: 4, ratio: 1 },
    ]);
  });

  it("buffers a body without content-length and reports completion", async () => {
    serveBytes(BYTES, { lengthHeader: false });
    const progress = [];
    const bytes = await fetchWithProgress("https://example.test/b", (p) =>
      progress.push(p),
    );
    assert.deepEqual([...bytes], [...BYTES]);
    assert.deepEqual(progress, [{ loaded: 5, total: 5, ratio: 1 }]);
  });

  it("rejects HTTP errors with the status", async () => {
    globalThis.fetch = async () => new Response("", { status: 404 });
    await assert.rejects(fetchWithProgress("https://example.test/b"), {
      message: "Failed to fetch https://example.test/b: 404",
    });
  });
});

describe("fetchManifest", () => {
  it("loads JSON with no-cache and records the manifest URL", async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push([url, init]);
      return Response.json({ bundle: { path: "x" } });
    };
    const manifest = await fetchManifest("https://example.test/m.json");
    assert.deepEqual(seen, [
      ["https://example.test/m.json", { cache: "no-cache" }],
    ]);
    assert.equal(manifest._manifestUrl, "https://example.test/m.json");
    assert.deepEqual(manifest.bundle, { path: "x" });
  });

  it("defaults to the project latest.json manifest", async () => {
    let seen;
    globalThis.fetch = async (url) => {
      seen = url;
      return Response.json({});
    };
    const manifest = await fetchManifest();
    assert.match(seen, /\/assets\/manifests\/latest\.json$/);
    assert.equal(manifest._manifestUrl, seen);
  });

  it("rejects a failed manifest response", async () => {
    globalThis.fetch = async () => new Response("", { status: 500 });
    await assert.rejects(fetchManifest("https://example.test/m.json"), {
      message: "Unable to load manifest: 500",
    });
  });
});

describe("fetchBundleWithCache", () => {
  it("requires a bundle path in the manifest", async () => {
    await assert.rejects(
      fetchBundleWithCache({ _manifestUrl: "https://example.test/" }),
      {
        message: "Manifest does not describe a bundle.",
      },
    );
  });

  it("returns a cached bundle whose hash matches without fetching", async () => {
    fakeCaches({ stored: BYTES });
    const urls = serveBytes(new Uint8Array([9]));
    const progress = [];
    const bytes = await fetchBundleWithCache(MANIFEST, (p) => progress.push(p));
    assert.deepEqual([...bytes], [...BYTES]);
    assert.deepEqual(urls, []);
    assert.deepEqual(progress, [{ loaded: 5, total: 5, ratio: 1 }]);
  });

  it("trusts a cached bundle when the manifest has no hash", async () => {
    fakeCaches({ stored: new Uint8Array([7, 7]) });
    const urls = serveBytes(BYTES);
    const progress = [];
    const manifest = { ...MANIFEST, bundle: { path: MANIFEST.bundle.path } };
    const bytes = await fetchBundleWithCache(manifest, (p) => progress.push(p));
    assert.deepEqual([...bytes], [7, 7]);
    assert.deepEqual(urls, []);
    assert.deepEqual(progress, [{ loaded: 2, total: 2, ratio: 1 }]);
  });

  it("discards a corrupt cached bundle, re-downloads and re-caches it", async () => {
    const { log, store } = fakeCaches({ stored: new Uint8Array([0]) });
    const urls = serveBytes(BYTES);
    const bytes = await fetchBundleWithCache(MANIFEST);
    assert.deepEqual([...bytes], [...BYTES]);
    assert.deepEqual(urls, [BUNDLE_URL]);
    assert.deepEqual(log, [
      ["open", "facturascripts-playground-bundles"],
      ["delete", BUNDLE_URL],
      ["put", BUNDLE_URL, "application/octet-stream"],
    ]);
    assert.deepEqual([...store.get(BUNDLE_URL)], [...BYTES]);
  });

  it("rejects a downloaded bundle with the wrong hash and does not cache it", async () => {
    const { store } = fakeCaches();
    serveBytes(new Uint8Array([6, 6]));
    await assert.rejects(
      fetchBundleWithCache(MANIFEST),
      /Bundle SHA-256 mismatch: expected/,
    );
    assert.equal(store.size, 0);
  });

  it("refetches past the HTTP cache when the downloaded bytes mismatch", async () => {
    const { store } = fakeCaches();
    // A deploy rebuilt the bundle at the same URL: the HTTP cache still holds
    // the previous build while the manifest already advertises the new sha256.
    const inits = [];
    globalThis.fetch = async (_url, init) => {
      inits.push(init);
      const body = init?.cache === "reload" ? BYTES : new Uint8Array([6, 6]);
      return new Response(body, {
        headers: { "content-length": String(body.length) },
      });
    };

    const bytes = await fetchBundleWithCache(MANIFEST);
    assert.deepEqual([...bytes], [...BYTES]);
    assert.equal(inits.length, 2, "one retry");
    assert.equal(inits[1]?.cache, "reload", "retry bypasses the HTTP cache");
    assert.deepEqual([...store.get(BUNDLE_URL)], [...BYTES]);
  });

  it("falls back to the network when the Cache API is unavailable", async () => {
    const { log } = fakeCaches({ openFails: true });
    const urls = serveBytes(BYTES);
    const bytes = await fetchBundleWithCache(MANIFEST);
    assert.deepEqual([...bytes], [...BYTES]);
    assert.deepEqual(urls, [BUNDLE_URL]);
    assert.deepEqual(log, [["open", "facturascripts-playground-bundles"]]);
  });

  it("treats a failing cache.put as non-fatal", async () => {
    fakeCaches({ putFails: true });
    serveBytes(BYTES);
    const bytes = await fetchBundleWithCache(MANIFEST);
    assert.deepEqual([...bytes], [...BYTES]);
  });
});

describe("resolveBootstrapArchive", () => {
  it("reuses a supplied manifest without fetching it again", async () => {
    fakeCaches();
    const urls = serveBytes(BYTES);
    const result = await resolveBootstrapArchive({ manifest: MANIFEST });
    assert.equal(result.manifest, MANIFEST);
    assert.deepEqual([...result.bytes], [...BYTES]);
    assert.deepEqual(urls, [BUNDLE_URL]);
  });

  it("fetches the manifest from manifestUrl when none is supplied", async () => {
    fakeCaches({ openFails: true });
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return String(url).endsWith(".json")
        ? Response.json({ bundle: { path: "core.tar.zst" } })
        : new Response(BYTES);
    };
    const result = await resolveBootstrapArchive({
      manifestUrl: "https://example.test/m/latest.json",
    });
    assert.deepEqual(urls, [
      "https://example.test/m/latest.json",
      "https://example.test/m/core.tar.zst",
    ]);
    assert.deepEqual([...result.bytes], [...BYTES]);
  });
});
