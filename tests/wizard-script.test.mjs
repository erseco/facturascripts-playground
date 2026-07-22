import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWizardScript } from "../src/runtime/wizard-script.js";

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

  it("includes require_once for config and autoload", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("require_once"));
    assert.ok(script.includes("config.php"));
    assert.ok(script.includes("autoload.php"));
  });

  it("initializes core models (Empresa, Almacen, Pais, User)", () => {
    const script = buildWizardScript(baseConfig);
    for (const model of ["Empresa", "Almacen", "Pais", "User"]) {
      assert.ok(
        script.includes(model),
        `Script should reference model ${model}`,
      );
    }
  });

  it("includes empresa creation with configured name", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("Empresa Playground"));
  });

  it("does not include deploy call (handled by bootstrap)", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(!script.includes("deploy(true, true)"));
  });

  it("sets user homepage to Dashboard", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("'Dashboard'"));
  });

  it("includes settingsSave", () => {
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

  it("includes database connection", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("DataBase"));
    assert.ok(script.includes("connect"));
  });

  it("creates admin user with configured username", () => {
    const config = {
      admin: {
        username: "testuser",
        email: "test@test.com",
        password: "testpass",
      },
      install: baseConfig.install,
    };
    const script = buildWizardScript(config);
    assert.ok(script.includes("'testuser'"));
  });

  it("outputs JSON response", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("json_encode"));
    assert.ok(script.includes("application/json"));
  });

  it("initializes core billing models (taxes, payment methods, series)", () => {
    const script = buildWizardScript(baseConfig);
    for (const model of ["Impuesto", "FormaPago", "Serie", "Ejercicio"]) {
      assert.ok(
        script.includes(model),
        `Script should reference model ${model}`,
      );
    }
  });

  it("imports accounting plan when defaultplan is true", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("AccountingPlanImport"));
    assert.ok(script.includes("defaultPlan.csv"));
    assert.ok(script.includes("$defaultplan = true"));
  });

  it("applies codimpuesto and company address from install", () => {
    const config = {
      ...baseConfig,
      install: {
        ...baseConfig.install,
        codimpuesto: "IGIC7",
        ciudad: "Santa Cruz de Tenerife",
        provincia: "Santa Cruz de Tenerife",
        cifnif: "125478938W",
      },
    };
    const script = buildWizardScript(config);
    assert.ok(script.includes("IGIC7"));
    assert.ok(script.includes("Santa Cruz de Tenerife"));
    assert.ok(script.includes("125478938W"));
  });

  it("can disable accounting plan import", () => {
    const config = {
      ...baseConfig,
      install: { ...baseConfig.install, defaultplan: false },
    };
    const script = buildWizardScript(config);
    assert.ok(script.includes("$defaultplan = false"));
  });

  it("ensures default serie and open exercise for today", () => {
    const script = buildWizardScript(baseConfig);
    assert.ok(script.includes("loadFromDate"));
    assert.ok(script.includes("codserierec"));
    assert.ok(script.includes("user->codserie = $codserie"));
    assert.ok(script.includes("'codejercicio'"));
  });
});
