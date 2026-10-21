import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as blueprint from "../src/shared/blueprint.js";
import {
  buildEffectivePlaygroundConfig,
  getDefaultRuntime,
  normalizeBlueprint,
} from "../src/shared/config.js";
import {
  loadCoreVersions,
  normalizeCoreVersions,
} from "../src/shared/core-versions.js";
import {
  createShellChannel,
  createWorkerRequestId,
  formatErrorDetail,
} from "../src/shared/protocol.js";

const CONFIG = {
  siteTitle: "FS",
  locale: "es_ES",
  timezone: "UTC",
  admin: { username: "admin", email: "a@example.test", password: "pw" },
};

describe("config helpers", () => {
  it("picks the runtime flagged as default, else the first one", () => {
    const runtimes = [{ id: "a" }, { id: "b", default: true }];
    assert.equal(getDefaultRuntime({ runtimes }).id, "b");
    assert.equal(
      getDefaultRuntime({ runtimes: [{ id: "a" }, { id: "b" }] }).id,
      "a",
    );
  });

  it("delegates blueprint normalization to the blueprint module", () => {
    const input = { siteOptions: { title: "Mine" } };
    assert.deepEqual(
      normalizeBlueprint(input, CONFIG),
      blueprint.normalizeBlueprint(input, CONFIG),
    );
    const effective = buildEffectivePlaygroundConfig(CONFIG, input);
    assert.equal(effective.siteTitle, "Mine");
    assert.equal(effective.admin.email, "a@example.test");
  });
});

describe("core versions", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips invalid entries and channels and defaults to the first version", () => {
    assert.deepEqual(
      normalizeCoreVersions({
        default: "1999",
        versions: [
          null,
          { version: "2025", label: "" },
          { version: "2024", channels: "dev" },
        ],
      }),
      {
        defaultVersion: "2025",
        versions: [
          { version: "2025", channels: [], label: "2025" },
          { version: "2024", channels: [], label: "2024" },
        ],
      },
    );
    assert.deepEqual(normalizeCoreVersions({ versions: "x" }), {
      defaultVersion: "",
      versions: [],
    });
  });

  it("loads versions.json without caching", async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          default: "2025",
          versions: [{ version: "2025", channels: ["stable"] }],
        }),
      );
    };
    const result = await loadCoreVersions();
    assert.equal(result.defaultVersion, "2025");
    assert.deepEqual(result.versions[0].channels, ["stable"]);
    assert.match(calls[0].url, /\/assets\/manifests\/versions\.json$/u);
    assert.deepEqual(calls[0].options, { cache: "no-store" });
  });

  it("returns an empty list on HTTP or network failure", async () => {
    const empty = { defaultVersion: "", versions: [] };
    globalThis.fetch = async () => new Response("", { status: 404 });
    assert.deepEqual(await loadCoreVersions(), empty);
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    assert.deepEqual(await loadCoreVersions(), empty);
  });
});

describe("protocol helpers", () => {
  it("omits the instance suffix when there is no instance id", () => {
    assert.equal(createShellChannel("s"), "facturascripts-playground-shell:s");
  });

  it("creates unique UUID request ids", () => {
    const id = createWorkerRequestId();
    assert.match(id, /^[0-9a-f-]{36}$/u);
    assert.notEqual(id, createWorkerRequestId());
  });

  it("falls back to String() for values JSON cannot serialize", () => {
    const circular = {};
    circular.self = circular;
    assert.equal(formatErrorDetail(circular), "[object Object]");
    assert.equal(formatErrorDetail({ code: 1 }), '{\n  "code": 1\n}');
  });
});
