import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeArchivePath } from "../lib/facturascripts-loader.js";

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
