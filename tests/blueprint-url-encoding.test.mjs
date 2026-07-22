import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  buildBlueprintBootHref,
  decodeBlueprintParam,
  encodeBlueprintParam,
  loadStashedBlueprintPayload,
  MAX_INLINE_BLUEPRINT_URL_LENGTH,
  stashBlueprintPayload,
} from "../src/shared/blueprint.js";

// A repetitive blueprint compresses well, so the gzip branch should win.
const largeBlueprint = {
  siteOptions: {
    title: "FacturaScripts",
    locale: "es_ES",
    timezone: "Europe/Madrid",
  },
  items: Array.from({ length: 40 }, (_, i) => ({
    title: `Documento de ejemplo número ${i}`,
    description:
      "Un recurso de demostración con metadatos repetidos para el playground.",
    creator: "Equipo ATE Educación",
  })),
};

describe("blueprint URL encoding", () => {
  it("round-trips a blueprint through gzip + base64url", async () => {
    const encoded = await encodeBlueprintParam(largeBlueprint);
    assert.equal(typeof encoded, "string");
    // base64url: no +, /, or = padding.
    assert.ok(!/[+/=]/u.test(encoded), "payload must be URL-safe base64url");
    assert.deepEqual(await decodeBlueprintParam(encoded), largeBlueprint);
  });

  it("actually compresses large payloads (gzip magic present, shorter link)", async () => {
    const plain = Buffer.from(JSON.stringify(largeBlueprint), "utf8").toString(
      "base64",
    );
    const encoded = await encodeBlueprintParam(largeBlueprint);
    assert.ok(
      encoded.length < plain.length,
      `gzipped payload (${encoded.length}) should be shorter than plain base64 (${plain.length})`,
    );
    const bytes = Buffer.from(
      encoded.replace(/-/gu, "+").replace(/_/gu, "/"),
      "base64",
    );
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
  });

  it("decodes legacy plain-base64 JSON links (backward compatible)", async () => {
    const legacy = { siteOptions: { title: "Legacy" }, items: [] };
    const legacyParam = Buffer.from(JSON.stringify(legacy), "utf8").toString(
      "base64",
    );
    assert.deepEqual(await decodeBlueprintParam(legacyParam), legacy);
  });

  it("round-trips a tiny blueprint even when gzip would not help", async () => {
    const tiny = { items: [] };
    assert.deepEqual(
      await decodeBlueprintParam(await encodeBlueprintParam(tiny)),
      tiny,
    );
  });

  it("rejects empty and invalid payloads", async () => {
    await assert.rejects(() => decodeBlueprintParam(""), /empty/u);
    const notJson = Buffer.from("not json {", "utf8").toString("base64");
    await assert.rejects(() => decodeBlueprintParam(notJson), /JSON/u);
  });

  it("buildBlueprintBootHref keeps short blueprints inline", async () => {
    const tiny = { siteOptions: { title: "Tiny" }, seed: { products: [] } };
    const boot = await buildBlueprintBootHref(
      "https://example.com/app/?foo=1",
      tiny,
    );
    assert.equal(boot.mode, "inline");
    assert.ok(boot.href.includes("blueprint="));
    assert.ok(!boot.href.includes("blueprint-sid="));
    assert.ok(boot.href.length <= MAX_INLINE_BLUEPRINT_URL_LENGTH);
    assert.ok(boot.href.includes("foo=1"));
  });
});

describe("blueprint session stash", () => {
  it("round-trips a stashed blueprint payload", () => {
    // jsdom-less unit env: polyfill sessionStorage on globalThis.window
    const store = new Map();
    globalThis.window = {
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
          store.set(k, String(v));
        },
        removeItem: (k) => {
          store.delete(k);
        },
      },
    };
    try {
      const payload = { meta: { title: "Stashed" }, seed: { suppliers: [] } };
      const id = stashBlueprintPayload(payload);
      assert.equal(typeof id, "string");
      assert.ok(id.length >= 8);
      assert.deepEqual(loadStashedBlueprintPayload(id), payload);
      assert.equal(loadStashedBlueprintPayload("missing"), null);
    } finally {
      delete globalThis.window;
    }
  });

  it("buildBlueprintBootHref stashes when the inline URL would be too long", async () => {
    const store = new Map();
    globalThis.window = {
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
          store.set(k, String(v));
        },
        removeItem: (k) => {
          store.delete(k);
        },
      },
    };
    try {
      // High-entropy body defeats gzip enough to exceed the soft URL cap.
      const huge = {
        meta: { title: "Huge" },
        seed: {
          products: Array.from({ length: 400 }, (_, i) => ({
            referencia: `SKU-${i}-${Math.random().toString(36).slice(2)}`,
            descripcion: `Producto ${i} ${Math.random().toString(36).repeat(8)}`,
            precio: i * 1.23,
          })),
        },
      };
      const boot = await buildBlueprintBootHref(
        "https://example.com/app/?keep=1",
        huge,
      );
      assert.equal(boot.mode, "stash");
      assert.ok(boot.sid);
      assert.ok(boot.href.includes(`blueprint-sid=${boot.sid}`));
      assert.ok(!boot.href.includes("blueprint="));
      assert.ok(boot.href.includes("keep=1"));
      assert.ok(boot.href.length < 500);
      assert.deepEqual(loadStashedBlueprintPayload(boot.sid).meta, huge.meta);
    } finally {
      delete globalThis.window;
    }
  });
});
