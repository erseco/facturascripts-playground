import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";
import { mountReadonlyCore } from "../src/runtime/vfs.js";

const enc = (s) => new TextEncoder().encode(s);
const TAR = createUstarTar(
  normalizeEntries({
    "index.php": enc("<?php echo 1;"),
    "Core/a.php": enc("a"),
  }),
);

function fakePhp() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    _php: {
      mkdirTree: (dir) => dirs.add(dir),
      writeFile: (path, data) =>
        files.set(path, new TextDecoder().decode(data)),
    },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mountReadonlyCore", () => {
  it("extracts pre-downloaded zstd bytes into the root and reports the count", async () => {
    const php = fakePhp();
    const progress = [];
    const manifest = { bundle: { fileCount: 2 } };
    const result = await mountReadonlyCore(php, manifest, {
      root: "/www/fs",
      bytes: new Uint8Array(zstdCompressSync(TAR)),
      publish: (msg, ratio) => progress.push([msg, ratio]),
    });
    assert.deepEqual(result, { manifest, entries: 2 });
    assert.equal(php.files.get("/www/fs/index.php"), "<?php echo 1;");
    assert.equal(php.files.get("/www/fs/Core/a.php"), "a");
    assert.deepEqual(progress, [["Extracting FacturaScripts core…", 0.45]]);
  });

  it("downloads the bundle when no bytes are given and maps progress", async () => {
    const body = gzipSync(TAR);
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(body, {
        headers: { "content-length": String(body.byteLength) },
      });
    };
    const php = fakePhp();
    const progress = [];
    const result = await mountReadonlyCore(
      php,
      {
        _manifestUrl: "https://example.test/assets/manifests/latest.json",
        bundle: { path: "../fs/core.tar.gz", codec: "gzip" },
      },
      { publish: (msg, ratio) => progress.push([msg, ratio]) },
    );
    assert.equal(result.entries, 2);
    assert.deepEqual(requested, ["https://example.test/assets/fs/core.tar.gz"]);
    assert.equal(
      php.files.get("/www/facturascripts/index.php"),
      "<?php echo 1;",
    );
    const [message, ratio] = progress.at(-2);
    assert.equal(message, "Downloading FacturaScripts bundle: 100%");
    assert.ok(Math.abs(ratio - 0.45) < 1e-9);
    assert.equal(progress.at(-1)[0], "Extracting FacturaScripts core…");
  });

  it("downloads silently without a publish callback", async () => {
    const body = gzipSync(TAR);
    globalThis.fetch = async () => new Response(body);
    const result = await mountReadonlyCore(fakePhp(), {
      _manifestUrl: "https://example.test/m.json",
      bundle: { path: "core.tar.gz", codec: "gzip" },
    });
    assert.equal(result.entries, 2);
  });

  it("fails loudly when the streamed file count disagrees with the manifest", async () => {
    await assert.rejects(
      mountReadonlyCore(
        fakePhp(),
        { bundle: { fileCount: 3 } },
        {
          bytes: new Uint8Array(zstdCompressSync(TAR)),
        },
      ),
      /core tar file-count parity mismatch: 2 != 3/,
    );
  });
});
