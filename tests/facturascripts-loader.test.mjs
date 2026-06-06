import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeArchivePath } from "../lib/facturascripts-loader.js";
import { buildCoreExtractScript } from "../src/runtime/core-extract-script.js";

describe("sanitizeArchivePath", () => {
  it("rejects ZIP-slip entries containing '..'", () => {
    assert.equal(sanitizeArchivePath("../evil.php"), null);
    assert.equal(sanitizeArchivePath("a/../../evil"), null);
  });

  it("strips leading slashes and '.' segments, normalizes backslashes", () => {
    assert.equal(sanitizeArchivePath("/index.php"), "index.php");
    assert.equal(sanitizeArchivePath("./Core/Kernel.php"), "Core/Kernel.php");
    assert.equal(
      sanitizeArchivePath("Core\\Base\\Controller.php"),
      "Core/Base/Controller.php",
    );
  });

  it("returns null for empty / root-only paths", () => {
    assert.equal(sanitizeArchivePath(""), null);
    assert.equal(sanitizeArchivePath("/"), null);
  });
});

describe("buildCoreExtractScript", () => {
  const script = buildCoreExtractScript(
    "/tmp/facturascripts-core.zip",
    "/tmp/facturascripts-core-stage",
    "/www/facturascripts",
  );

  it("extracts the core with PHP ZipArchive into the target root", () => {
    assert.match(script, /new ZipArchive\(\)/);
    assert.match(script, /->extractTo\(\$stage\)/);
    assert.match(script, /\$zipPath = '\/tmp\/facturascripts-core\.zip'/);
    assert.match(script, /\$target = '\/www\/facturascripts'/);
  });

  it("descends into a lone wrapping folder, then moves it into place", () => {
    assert.match(script, /count\(\$top\) === 1 && is_dir/);
    assert.match(script, /@rename\(\$src, \$target\)/);
  });

  it("declares the sentinel contract and probes ext/zip", () => {
    assert.match(script, /class_exists\('ZipArchive'\)/);
    assert.match(script, /return 'NO_ZIP_EXT'/);
    assert.match(script, /return 'INSTALL_OK ' \. \$count/);
    assert.match(script, /INSTALL_ERR/);
  });

  it("escapes single quotes in paths to keep the PHP literal safe", () => {
    const evil = buildCoreExtractScript("/tmp/a'b.zip", "/tmp/s", "/www/x");
    assert.match(evil, /\/tmp\/a\\'b\.zip'/);
  });
});
