import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchBootAsset } from "../lib/facturascripts-loader.js";
import { describeDownloadFailure } from "../src/runtime/addons.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchBootAsset", () => {
  it("passes a successful response through untouched", async () => {
    const expected = new Response("ok");
    globalThis.fetch = async () => expected;
    assert.equal(
      await fetchBootAsset("https://example.com/x.json", undefined, "manifest"),
      expected,
    );
  });

  it("forwards url and init to fetch", async () => {
    const seen = {};
    globalThis.fetch = async (url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response("ok");
    };
    await fetchBootAsset(
      "https://example.com/x.json",
      { cache: "no-cache" },
      "manifest",
    );
    assert.equal(seen.url, "https://example.com/x.json");
    assert.deepEqual(seen.init, { cache: "no-cache" });
  });

  // WebKit reports a network-level failure as a bare "Load failed", Firefox as
  // "NetworkError when attempting to fetch resource" — no URL, no boot phase.
  it("names the phase and the query-less URL on a network failure", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };

    await assert.rejects(
      fetchBootAsset(
        "https://example.com/assets/core.tar.zst?v=abc123",
        undefined,
        "core bundle",
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Network error while fetching core bundle " +
            "(https://example.com/assets/core.tar.zst): Load failed",
        );
        assert.ok(!error.message.includes("v=abc123"));
        assert.equal(error.cause?.message, "Load failed");
        return true;
      },
    );
  });

  it("keeps the original error as the cause for Firefox wording", async () => {
    const original = new TypeError(
      "NetworkError when attempting to fetch resource.",
    );
    globalThis.fetch = async () => {
      throw original;
    };

    await assert.rejects(
      fetchBootAsset("https://example.com/latest.json", undefined, "manifest"),
      (error) => {
        assert.match(
          error.message,
          /^Network error while fetching manifest \(/,
        );
        assert.equal(error.cause, original);
        return true;
      },
    );
  });
});

describe("describeDownloadFailure", () => {
  const url = "https://zip-proxy.example.dev/?url=https%3A%2F%2Fgithub.com%2Fx";

  // The proxy used to flatten an upstream 404 into 502, so a deleted branch
  // looked like a proxy outage. It now passes 404 through — say what it means.
  it("explains a 404 in plain language", () => {
    const message = describeDownloadFailure(url, 404);
    assert.ok(message.startsWith(`Failed to fetch ${url}: 404`));
    assert.match(
      message,
      /not found \(the repository, branch or release may have been renamed or deleted\)/,
    );
  });

  it("explains a 410 the same way", () => {
    assert.match(describeDownloadFailure(url, 410), /410 not found/);
  });

  it("explains rate limiting", () => {
    assert.match(
      describeDownloadFailure(url, 403),
      /rate limited or forbidden/,
    );
    assert.match(
      describeDownloadFailure(url, 429),
      /rate limited or forbidden/,
    );
  });

  it("falls back to the bare status for anything else", () => {
    assert.equal(
      describeDownloadFailure(url, 502),
      `Failed to fetch ${url}: 502`,
    );
  });
});
