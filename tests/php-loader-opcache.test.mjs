import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "../src/runtime/php-loader.js";

const { PHP_INI_ENTRIES, writeOpcacheBlacklist } = __testing;

describe("OPcache file cache configuration", () => {
  it("validates script timestamps on every request and keeps the file cache", () => {
    assert.equal(PHP_INI_ENTRIES["opcache.enable"], "1");
    assert.equal(PHP_INI_ENTRIES["opcache.file_cache_only"], "1");
    assert.equal(PHP_INI_ENTRIES["opcache.validate_timestamps"], "1");
    assert.equal(PHP_INI_ENTRIES["opcache.revalidate_freq"], "0");
    // PHP's default 2 s file_update_protection guarantees a stored .bin always
    // predates a rewrite of the same second.
    assert.equal(PHP_INI_ENTRIES["opcache.file_update_protection"], undefined);
    assert.equal(
      PHP_INI_ENTRIES["opcache.blacklist_filename"],
      "/internal/shared/opcache-blacklist.txt",
    );
  });

  it("writes /internal/eval.php into the blacklist before PHP starts", () => {
    const dirs = [];
    const files = new Map();
    writeOpcacheBlacklist(
      { writeFile: (path, data) => files.set(path, data) },
      { mkdirTree: (path) => dirs.push(path) },
    );
    assert.deepEqual(dirs, ["/internal/shared"]);
    assert.deepEqual(
      [...files],
      [["/internal/shared/opcache-blacklist.txt", "/internal/eval.php\n"]],
    );
  });

  it("tolerates an existing /internal/shared directory", () => {
    const files = new Map();
    writeOpcacheBlacklist(
      { writeFile: (path, data) => files.set(path, data) },
      {
        mkdirTree: () => {
          throw new Error("EEXIST");
        },
      },
    );
    assert.equal(files.size, 1);
  });
});
