import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildBlueprintBootHref,
  buildDefaultBlueprint,
  clearActiveBlueprint,
  decodeBlueprintParam,
  encodeBlueprintParam,
  exportBlueprintPayload,
  loadActiveBlueprint,
  loadStashedBlueprintPayload,
  normalizeBlueprint,
  normalizeInstall,
  parseImportedBlueprintPayload,
  resolveBlueprintForShell,
  saveActiveBlueprint,
  stashBlueprintPayload,
} from "../src/shared/blueprint.js";
import { SNAPSHOT_VERSION } from "../src/shared/protocol.js";

const CONFIG = {
  siteTitle: "FS",
  locale: "es_ES",
  timezone: "Europe/Madrid",
  landingPath: "/home",
  admin: { username: "admin", email: "a@example.test", password: "secret" },
};

const ACTIVE_KEY = "facturascripts-playground:blueprint:scope1";

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function base64Url(text) {
  return Buffer.from(text).toString("base64url");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("blueprint helpers without a window", () => {
  it("cannot stash and has no stored blueprints", async () => {
    assert.throws(() => stashBlueprintPayload({}), /requires a browser window/);
    assert.equal(loadStashedBlueprintPayload("abc"), null);
    saveActiveBlueprint("scope1", { a: 1 });
    clearActiveBlueprint("scope1");
    assert.equal(loadActiveBlueprint("scope1"), null);
    assert.deepEqual(
      await resolveBlueprintForShell("scope1", CONFIG),
      buildDefaultBlueprint(CONFIG),
    );
  });

  it("keeps plugin URLs as given", () => {
    const { plugins } = normalizeBlueprint(
      { plugins: [{ source: { url: "plugins/x.zip" } }] },
      CONFIG,
    );
    assert.deepEqual(plugins, [
      {
        name: "",
        source: { type: "url", url: "plugins/x.zip" },
        state: "activate",
      },
    ]);
  });
});

describe("blueprint helpers with a window", () => {
  let storage;
  let originalFetch;
  let originalWarn;
  let fetchCalls;
  let warnings;

  function setLocation(href) {
    globalThis.window.location.href = href;
  }

  beforeEach(() => {
    storage = fakeStorage();
    globalThis.window = {
      location: { href: "https://play.test/app/" },
      sessionStorage: storage,
    };
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    fetchCalls = [];
    warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
  });

  afterEach(() => {
    delete globalThis.window;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  function stubFetch(response) {
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return response;
    };
  }

  it("absolutizes relative plugin URLs and keeps unparsable ones", () => {
    const { plugins } = normalizeBlueprint(
      {
        plugins: [
          { source: { type: "url", url: "plugins/x.zip" } },
          { source: { url: "http://[" } },
        ],
      },
      CONFIG,
    );
    assert.deepEqual(
      plugins.map((plugin) => plugin.source.url),
      ["https://play.test/app/plugins/x.zip", "http://["],
    );
  });

  it("stashes and reloads payloads by id", () => {
    const id = stashBlueprintPayload({ meta: { title: "Big" } });
    assert.match(id, /^[0-9a-f]{16}$/u);
    assert.deepEqual(loadStashedBlueprintPayload(` ${id} `), {
      meta: { title: "Big" },
    });
    assert.equal(loadStashedBlueprintPayload(""), null);
    assert.equal(loadStashedBlueprintPayload("missing"), null);
    storage.setItem("facturascripts-playground:blueprint-stash:bad", "{");
    assert.equal(loadStashedBlueprintPayload("bad"), null);
  });

  it("falls back to a time-based stash id without crypto.randomUUID", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
    });
    try {
      const id = stashBlueprintPayload({ a: 1 });
      assert.match(id, /^[0-9a-z]+$/u);
      assert.deepEqual(loadStashedBlueprintPayload(id), { a: 1 });
    } finally {
      Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });

  it("stashes blueprints whose inline URL would be too long", async () => {
    const noise = Array.from({ length: 12000 }, () =>
      Math.floor(Math.random() * 36).toString(36),
    ).join("");
    const blueprint = { meta: { description: noise } };
    const result = await buildBlueprintBootHref(
      "https://play.test/app/?blueprint=old&blueprint-url=x&blueprint-data=y&scope=s",
      blueprint,
    );
    assert.equal(result.mode, "stash");
    const url = new URL(result.href);
    assert.equal(url.searchParams.get("blueprint-sid"), result.sid);
    assert.equal(url.searchParams.get("scope"), "s");
    for (const name of ["blueprint", "blueprint-url", "blueprint-data"]) {
      assert.equal(url.searchParams.has(name), false);
    }
    assert.deepEqual(loadStashedBlueprintPayload(result.sid), blueprint);
  });

  it("saves, loads and clears the active blueprint per scope", () => {
    assert.equal(loadActiveBlueprint("scope1"), null);
    saveActiveBlueprint("scope1", { a: 1 });
    assert.equal(storage.getItem(ACTIVE_KEY), '{"a":1}');
    assert.deepEqual(loadActiveBlueprint("scope1"), { a: 1 });
    clearActiveBlueprint("scope1");
    assert.equal(loadActiveBlueprint("scope1"), null);
  });

  it("resolves ?blueprint-sid= from the stash", async () => {
    const sid = stashBlueprintPayload({ meta: { title: "Stashed" } });
    setLocation(`https://play.test/app/?blueprint-sid=${sid}`);
    const payload = await resolveBlueprintForShell("scope1", CONFIG);
    assert.equal(payload.meta.title, "Stashed");
    assert.deepEqual(loadActiveBlueprint("scope1"), payload);
  });

  it("rejects an expired ?blueprint-sid=", async () => {
    setLocation("https://play.test/app/?blueprint-sid=gone");
    await assert.rejects(
      resolveBlueprintForShell("scope1", CONFIG),
      /Stored blueprint not found/,
    );
  });

  it("fetches a remote ?blueprint= URL without caching", async () => {
    stubFetch(jsonResponse({ landingPage: "admin" }));
    setLocation("https://play.test/app/?blueprint=https://cdn.test/bp.json");
    const payload = await resolveBlueprintForShell("scope1", CONFIG);
    assert.equal(payload.landingPage, "/admin");
    assert.deepEqual(fetchCalls, [
      { url: "https://cdn.test/bp.json", options: { cache: "no-store" } },
    ]);
    assert.deepEqual(loadActiveBlueprint("scope1"), payload);
  });

  it("reports the status of a failed remote ?blueprint= URL", async () => {
    stubFetch(new Response("", { status: 404 }));
    setLocation("https://play.test/app/?blueprint=http://cdn.test/bp.json");
    await assert.rejects(
      resolveBlueprintForShell("scope1", CONFIG),
      /Unable to load blueprint from http:\/\/cdn\.test\/bp\.json: 404/,
    );
  });

  it("decodes an inline ?blueprint= payload", async () => {
    const encoded = await encodeBlueprintParam({ meta: { title: "Inline" } });
    setLocation(`https://play.test/app/?blueprint=${encoded}`);
    const payload = await resolveBlueprintForShell("scope1", CONFIG);
    assert.equal(payload.meta.title, "Inline");
    assert.deepEqual(loadActiveBlueprint("scope1"), payload);
  });

  it("fetches ?blueprint-url= relative to the page", async () => {
    stubFetch(jsonResponse({ meta: { title: "Remote" } }));
    setLocation("https://play.test/app/?blueprint-url=demo/bp.json");
    const payload = await resolveBlueprintForShell("scope1", CONFIG);
    assert.equal(payload.meta.title, "Remote");
    assert.equal(fetchCalls[0].url, "https://play.test/app/demo/bp.json");
  });

  it("reports a failed ?blueprint-url=", async () => {
    stubFetch(new Response("", { status: 500 }));
    setLocation("https://play.test/app/?blueprint-url=demo/bp.json");
    await assert.rejects(
      resolveBlueprintForShell("scope1", CONFIG),
      /Unable to load blueprint from demo\/bp\.json: 500/,
    );
  });

  it("accepts the deprecated ?blueprint-data= alias with a warning", async () => {
    setLocation(
      `https://play.test/app/?blueprint-data=${base64Url('{"meta":{"title":"Legacy"}}')}`,
    );
    const payload = await resolveBlueprintForShell("scope1", CONFIG);
    assert.equal(payload.meta.title, "Legacy");
    assert.match(warnings[0], /blueprint-data= is deprecated/);
  });

  it("loads the configured default blueprint", async () => {
    stubFetch(jsonResponse({ meta: { title: "Default" } }));
    const payload = await resolveBlueprintForShell("scope1", {
      ...CONFIG,
      defaultBlueprintUrl: "assets/default.json",
    });
    assert.equal(payload.meta.title, "Default");
    assert.equal(
      fetchCalls[0].url,
      "https://play.test/app/assets/default.json",
    );
    assert.deepEqual(loadActiveBlueprint("scope1"), payload);
  });

  it("reports a failed default blueprint", async () => {
    stubFetch(new Response("", { status: 503 }));
    await assert.rejects(
      resolveBlueprintForShell("scope1", {
        ...CONFIG,
        defaultBlueprintUrl: "assets/default.json",
      }),
      /Unable to load default blueprint: 503/,
    );
  });

  it("falls back to the built-in default and stores it", async () => {
    const payload = await resolveBlueprintForShell("scope1", CONFIG);
    assert.deepEqual(payload, buildDefaultBlueprint(CONFIG));
    assert.deepEqual(loadActiveBlueprint("scope1"), payload);
  });
});

describe("blueprint payload encoding", () => {
  it("falls back to plain base64url when compression fails", async () => {
    const original = globalThis.CompressionStream;
    globalThis.CompressionStream = class {
      constructor() {
        throw new Error("no gzip");
      }
    };
    try {
      const blueprint = { meta: { title: "x".repeat(200) } };
      const encoded = await encodeBlueprintParam(blueprint);
      assert.equal(
        Buffer.from(encoded, "base64url").toString(),
        JSON.stringify(blueprint),
      );
    } finally {
      globalThis.CompressionStream = original;
    }
  });

  it("rejects empty, non-base64, non-UTF-8 and non-JSON payloads", async () => {
    await assert.rejects(decodeBlueprintParam(""), /payload is empty/);
    await assert.rejects(decodeBlueprintParam("!!!"), /not valid base64/);
    await assert.rejects(
      decodeBlueprintParam(Buffer.from([0xff, 0xfe]).toString("base64url")),
      /not valid UTF-8/,
    );
    await assert.rejects(
      decodeBlueprintParam(base64Url("{")),
      /not valid JSON/,
    );
  });
});

describe("blueprint plugin normalization", () => {
  const plugins = (list) =>
    normalizeBlueprint({ plugins: list }, CONFIG).plugins;

  it("normalizes string entries to bundled names or URL sources", () => {
    assert.deepEqual(plugins([" Ventas ", "", "https://cdn.test/p.zip"]), [
      { name: "Ventas", source: { type: "bundled" }, state: "activate" },
      {
        name: "",
        source: { type: "url", url: "https://cdn.test/p.zip" },
        state: "activate",
      },
    ]);
    assert.deepEqual(plugins("Ventas"), []);
  });

  it("rejects string names that are not a single path segment", () => {
    for (const name of ["a/b", "a\\b", ".", ".."]) {
      assert.throws(() => plugins([name]), /must be a single path segment/);
    }
  });

  it("rejects duplicate string entries case-insensitively", () => {
    assert.throws(
      () => plugins(["Ventas", "ventas"]),
      /duplicate entry "ventas"/,
    );
    assert.throws(
      () => plugins(["https://cdn.test/P.zip", "https://cdn.test/p.zip"]),
      /duplicate entry ""/,
    );
  });

  it("normalizes object entries", () => {
    assert.deepEqual(
      plugins([
        { name: "A", state: "install" },
        { name: "B", source: [] },
        { name: "C", source: { type: "BUNDLED" } },
        { source: {} },
        null,
      ]),
      [
        { name: "A", source: { type: "bundled" }, state: "install" },
        { name: "B", source: { type: "bundled" }, state: "activate" },
        { name: "C", source: { type: "bundled" }, state: "activate" },
      ],
    );
  });

  it("rejects invalid object entries", () => {
    assert.throws(() => plugins([{ name: "../x" }]), /single path segment/);
    assert.throws(
      () => plugins([{ name: "A" }, { name: "a" }]),
      /duplicate entry "a"/,
    );
    assert.throws(
      () =>
        plugins([
          { source: { url: "https://cdn.test/p.zip" } },
          { source: { url: "https://cdn.test/P.zip" } },
        ]),
      /duplicate entry "https:\/\/cdn\.test\/P\.zip"/,
    );
    assert.throws(
      () => plugins([{ name: "A", source: { type: "url" } }]),
      /requires source\.url/,
    );
    assert.throws(
      () => plugins([{ name: "A", source: { type: "git" } }]),
      /Unsupported blueprint plugin source type "git"/,
    );
  });
});

describe("blueprint normalization edge cases", () => {
  it("treats a non-object blueprint as empty", () => {
    assert.deepEqual(
      normalizeBlueprint(["x"], CONFIG),
      buildDefaultBlueprint(CONFIG),
    );
  });

  it("prefixes relative landing pages and ignores non-string ones", () => {
    assert.equal(
      normalizeBlueprint({ landingPath: "admin" }, CONFIG).landingPage,
      "/admin",
    );
    assert.equal(
      normalizeBlueprint({ landingPage: 5 }, CONFIG).landingPage,
      "/",
    );
  });

  it("rejects seed entries that are not objects", () => {
    assert.throws(
      () => normalizeBlueprint({ seed: { products: ["x"] } }, CONFIG),
      /seed\.referencia entries must be objects/,
    );
  });

  it("keeps the default for null install values", () => {
    assert.equal(
      normalizeInstall({ empresa: null }).empresa,
      "Empresa Playground",
    );
  });

  it("exports the normalized payload", () => {
    assert.deepEqual(
      exportBlueprintPayload(CONFIG, { landingPage: "x" }),
      normalizeBlueprint({ landingPage: "x" }, CONFIG),
    );
  });
});

describe("parseImportedBlueprintPayload", () => {
  it("recognizes snapshot payloads and normalizes their path", () => {
    assert.deepEqual(
      parseImportedBlueprintPayload(
        { version: SNAPSHOT_VERSION, runtimeId: "php83", path: "admin" },
        CONFIG,
      ),
      { type: "snapshot", runtimeId: "php83", path: "/admin" },
    );
    assert.equal(
      parseImportedBlueprintPayload({ version: SNAPSHOT_VERSION }, CONFIG).path,
      "/home",
    );
    assert.equal(
      parseImportedBlueprintPayload({ version: SNAPSHOT_VERSION }, {}).path,
      "/",
    );
  });

  it("normalizes anything else as a blueprint", () => {
    assert.deepEqual(
      parseImportedBlueprintPayload({ landingPage: "x" }, CONFIG),
      {
        type: "blueprint",
        blueprint: normalizeBlueprint({ landingPage: "x" }, CONFIG),
      },
    );
  });
});
