import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWizardScript } from "../src/runtime/bootstrap.js";

const baseConfig = {
  admin: { username: "admin", email: "admin@example.com", password: "admin" },
  install: {
    codpais: "ESP",
    empresa: "Empresa Playground",
    cifnif: "00000014Z",
    tipoidfiscal: "",
    direccion: "",
    codpostal: "",
    ciudad: "",
    provincia: "",
    regimeniva: "General",
    codimpuesto: "",
    defaultplan: true,
    costpricepolicy: "",
    ventasinstock: false,
    updatesupplierprices: true,
  },
};

describe("buildWizardScript", () => {
  it("generates a string starting with <?php", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.startsWith("<?php"));
  });

  it("includes idempotency guard checking Impuesto count", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("$impuesto->count() > 0"));
    assert.ok(script.includes("'skipped' => true"));
  });

  it("includes country defaults loading", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("default.json"));
    assert.ok(script.includes("Codpais"));
  });

  it("initializes all required models", () => {
    const script = buildWizardScript(baseConfig);
    for (const model of [
      "AttachedFile",
      "Diario",
      "EstadoDocumento",
      "FormaPago",
      "Impuesto",
      "Retencion",
      "Serie",
      "Provincia",
    ]) {
      assert.ok(
        script.includes(model),
        `Script should reference model ${model}`,
      );
    }
  });

  it("includes empresa update", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("Empresa Playground"));
    assert.ok(script.includes("00000014Z"));
  });

  it("includes accounting plan import when defaultplan is true", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("AccountingPlanImport"));
    assert.ok(script.includes("plan.csv"));
  });

  it("skips accounting plan import when defaultplan is false", () => {
    const config = {
      ...baseConfig,
      install: { ...baseConfig.install, defaultplan: false },
    };
    const script = buildWizardScript(config);
    // The PHP `if (false)` block will exist but not execute
    assert.ok(script.includes("if (false)"));
  });

  it("properly escapes single quotes in values", () => {
    const config = {
      admin: { username: "admin", email: "", password: "admin" },
      install: {
        ...baseConfig.install,
        empresa: "L'Empresa",
      },
    };
    const script = buildWizardScript(config);
    assert.ok(script.includes("L\\'Empresa"));
    assert.ok(!script.includes("L'Empresa"));
  });

  it("includes second deploy after Dinamic model loading", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(
      script.includes("deploy(true, true)"),
      "Script should include a deploy call after loading Dinamic models",
    );
  });

  it("sets user homepage to Dashboard", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("'Dashboard'"));
  });

  it("includes settings save", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("settingsSave"));
  });

  it("uses correct codpais from config", () => {
    const config = {
      admin: { username: "admin", email: "", password: "admin" },
      install: { ...baseConfig.install, codpais: "MEX" },
    };
    const script = buildWizardScript(config);
    assert.ok(script.includes("'MEX'"));
  });
});
