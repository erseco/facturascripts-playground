import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDefaultBlueprint,
  buildEffectivePlaygroundConfig,
  normalizeBlueprint,
  normalizeInstall,
} from "../src/shared/blueprint.js";

const baseConfig = {
  siteTitle: "Test Playground",
  locale: "es_ES",
  timezone: "Europe/Madrid",
  admin: { username: "admin", email: "test@example.com", password: "admin" },
  landingPath: "/",
};

describe("normalizeInstall", () => {
  it("returns all defaults when called with undefined", () => {
    const result = normalizeInstall(undefined);
    assert.equal(result.codpais, "ESP");
    assert.equal(result.empresa, "Empresa Playground");
    assert.equal(result.cifnif, "00000014Z");
    assert.equal(result.regimeniva, "General");
    assert.equal(result.defaultplan, true);
    assert.equal(result.ventasinstock, false);
    assert.equal(result.updatesupplierprices, true);
  });

  it("returns all defaults when called with null", () => {
    const result = normalizeInstall(null);
    assert.equal(result.codpais, "ESP");
    assert.equal(result.defaultplan, true);
  });

  it("preserves custom values", () => {
    const result = normalizeInstall({
      codpais: "MEX",
      empresa: "Mi Empresa",
      ventasinstock: true,
      defaultplan: false,
    });
    assert.equal(result.codpais, "MEX");
    assert.equal(result.empresa, "Mi Empresa");
    assert.equal(result.ventasinstock, true);
    assert.equal(result.defaultplan, false);
    // Defaults for unspecified keys
    assert.equal(result.regimeniva, "General");
    assert.equal(result.updatesupplierprices, true);
  });

  it("strips unknown keys", () => {
    const result = normalizeInstall({
      codpais: "ESP",
      unknownKey: "should not appear",
      anotherUnknown: 42,
    });
    assert.equal(result.codpais, "ESP");
    assert.equal(result.unknownKey, undefined);
    assert.equal(result.anotherUnknown, undefined);
  });

  it("coerces boolean fields correctly", () => {
    const result = normalizeInstall({
      defaultplan: "truthy string",
      ventasinstock: 1,
      updatesupplierprices: false,
    });
    // Only `true` should be truthy for booleans
    assert.equal(result.defaultplan, false);
    assert.equal(result.ventasinstock, false);
    assert.equal(result.updatesupplierprices, false);
  });
});

describe("normalizeBlueprint with install", () => {
  it("includes install section with defaults", () => {
    const result = normalizeBlueprint({}, baseConfig);
    assert.ok(result.install);
    assert.equal(result.install.codpais, "ESP");
    assert.equal(result.install.empresa, "Empresa Playground");
    assert.equal(result.install.defaultplan, true);
  });

  it("preserves custom install values", () => {
    const result = normalizeBlueprint(
      {
        install: { codpais: "FRA", empresa: "Test Co" },
      },
      baseConfig,
    );
    assert.equal(result.install.codpais, "FRA");
    assert.equal(result.install.empresa, "Test Co");
    assert.equal(result.install.regimeniva, "General");
  });
});

describe("buildDefaultBlueprint with install", () => {
  it("includes install section", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.ok(result.install);
    assert.equal(result.install.codpais, "ESP");
    assert.equal(result.install.defaultplan, true);
  });
});

describe("buildEffectivePlaygroundConfig with install", () => {
  it("includes install in effective config", () => {
    const blueprint = normalizeBlueprint(
      { install: { codpais: "DEU" } },
      baseConfig,
    );
    const effective = buildEffectivePlaygroundConfig(baseConfig, blueprint);
    assert.ok(effective.install);
    assert.equal(effective.install.codpais, "DEU");
  });
});
