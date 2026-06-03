import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FS_ROOT } from "../src/runtime/bootstrap-paths.js";
import { buildPhpPrepend } from "../src/runtime/php-prepend.js";

describe("buildPhpPrepend", () => {
  it("generates a PHP script starting with <?php", () => {
    const script = buildPhpPrepend();
    assert.ok(script.startsWith("<?php"));
  });

  it("pre-populates the Forja cache to avoid network calls and the Forja.php crash", () => {
    // Regression for: "Cannot access offset of type string on string in
    // Core/Internal/Forja.php:72". Without a valid cached value, Forja::builds()
    // reaches facturascripts.com through the CORS proxy and parses a non-array
    // response, crashing Dashboard. Pre-populating an empty array keeps the
    // playground offline-safe.
    const script = buildPhpPrepend();

    // Both Forja cache keys must be seeded (builds + plugin list).
    assert.match(script, /'forja_builds',\s*'forja_plugins'/);

    // Seeded into FacturaScripts' FileCache directory.
    assert.ok(script.includes(`${FS_ROOT}/MyFiles/Tmp/FileCache`));

    // Seeded with a serialized empty array (PHP `serialize([])`), which
    // unserialize() turns back into [] so Forja::builds() never iterates a
    // malformed value and canUpdateCore() stays false without any curl call.
    assert.ok(script.includes("a:0:{}"));

    // The .cache extension FacturaScripts' Cache::filename() expects.
    assert.ok(script.includes(".cache"));
  });

  it("writes the Forja cache on every request so it survives Cache::clear() and expiry", () => {
    // The prepend runs before every PHP request, so the cache is re-seeded even
    // after AdminPlugins triggers Cache::clear() or the 3600s expiry elapses.
    const script = buildPhpPrepend();
    assert.match(script, /file_put_contents\(.+\.cache.+,\s*'a:0:\{\}'\)/);
  });
});
