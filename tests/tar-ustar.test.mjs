import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
} from "../scripts/lib/tar-ustar.mjs";

const enc = (s) => new TextEncoder().encode(s);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

describe("createUstarTar ↔ readUstarTar round-trip", () => {
  it("recovers short, prefix-split, and GNU-longlink names with byte-identical data", () => {
    // Three name shapes exercise every header path in the writer:
    //  - a short name that fits the 100-byte USTAR `name` field
    //  - a >100-byte path that fits the USTAR prefix/name split at a "/"
    //  - a >100-byte single segment with no usable "/" → GNU `././@LongLink`
    const shortName = "a/b.txt";
    const splitName = `${"d".repeat(120)}/f.txt`;
    const longName = `${"x".repeat(130)}.bin`;

    const fileMap = {
      [shortName]: enc("hello"),
      [splitName]: enc("split-name payload"),
      [longName]: new Uint8Array([0, 1, 2, 3, 4, 5, 255]),
    };

    const tar = createUstarTar(normalizeEntries(fileMap), { mtime: 0 });
    const roundTripped = readUstarTar(tar);

    assert.equal(roundTripped.length, 3, "all three entries survive");

    const byName = new Map(roundTripped.map((e) => [e.name, e.data]));
    for (const name of [shortName, splitName, longName]) {
      assert.ok(byName.has(name), `entry ${name} recovered with its full name`);
      assert.deepEqual(
        Uint8Array.from(byName.get(name)),
        Uint8Array.from(fileMap[name]),
        `entry ${name} bytes match`,
      );
    }
  });

  it("emits a deterministic archive (identical bytes across runs)", () => {
    const fileMap = { "z.txt": enc("z"), "a.txt": enc("a") };
    const a = createUstarTar(normalizeEntries(fileMap), { mtime: 0 });
    const b = createUstarTar(normalizeEntries(fileMap), { mtime: 0 });
    assert.deepEqual(Uint8Array.from(a), Uint8Array.from(b));
    // Byte-wise sort places "a.txt" before "z.txt" regardless of insertion order.
    assert.deepEqual(
      readUstarTar(a).map((e) => e.name),
      ["a.txt", "z.txt"],
    );
  });
});

describe("tar-ustar empty directory preservation", () => {
  // Regression: the files-only tar writer used to drop every directory member, so
  // a semantically-meaningful empty directory (one no file recreates) vanished
  // from the runtime filesystem. The writer now keeps those as typeflag-5 entries
  // while still dropping directories that a file already implies.

  it("preserves an explicit empty directory (no file descendant)", () => {
    const entries = normalizeEntries({
      "emptydir/": enc(""),
      "Core/App.php": enc("<?php"),
    });
    const dir = entries.find((e) => e.name === "emptydir");
    assert.ok(dir, "empty directory member must be preserved");
    assert.equal(dir.type, "dir");
    // Directories implied by a file are NOT emitted as redundant members —
    // the streaming extractor reconstructs them from each file's parent path.
    assert.ok(!entries.some((e) => e.type === "dir" && e.name === "Core"));
  });

  it("drops populated directory members that a file recreates (real fflate shape)", () => {
    // fflate's unzipSync() yields an EXPLICIT trailing-slash member for EVERY
    // directory in a ZIP, including populated ones — this is the real input shape
    // a ZIP-fed packer feeds normalizeEntries(). Only the truly empty "keepme/"
    // must survive; "a/" and "a/b/" are recreated by their file and MUST be
    // dropped (guards the impliedDirs dedup, else the tar gains redundant
    // typeflag-5 entries and both dirCount and the sha256 drift).
    const entries = normalizeEntries({
      "a/": enc(""),
      "a/b/": enc(""),
      "a/b/f.txt": enc("payload"),
      "keepme/": enc(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["keepme"]);
  });

  it("emits a USTAR directory header (typeflag 5, size 0) that round-trips", () => {
    const tar = createUstarTar(
      normalizeEntries({ "emptydir/": enc(""), "a.txt": enc("a") }),
      { mtime: 0 },
    );
    const back = readUstarTar(tar);
    const dir = back.find((e) => e.name === "emptydir");
    assert.ok(dir, "directory entry should round-trip via the reader");
    assert.equal(dir.type, "dir");
    assert.equal(dir.data, undefined);
    // Files still round-trip alongside directories.
    const file = back.find((e) => e.name === "a.txt");
    assert.ok(file && Buffer.from(file.data).equals(Buffer.from(enc("a"))));
  });

  it("does not count directories as files", () => {
    const entries = normalizeEntries({
      "emptydir/": enc(""),
      "a.txt": enc("a"),
      "b.txt": enc("b"),
    });
    assert.equal(entries.filter((e) => e.type !== "dir").length, 2);
    assert.equal(entries.filter((e) => e.type === "dir").length, 1);
  });

  it("skips unsafe directory paths (path traversal)", () => {
    const entries = normalizeEntries({
      "../evil/": enc(""),
      "safe/../../evil/": enc(""),
      "ok/": enc(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["ok"]);
  });

  it("is deterministic with directory entries (stable sha256 across two builds)", () => {
    const map = {
      "emptydir/": enc(""),
      "admin/tool/": enc(""),
      "Core/App.php": enc("<?php"),
      "z.txt": enc("z"),
    };
    const a = createUstarTar(normalizeEntries(map), { mtime: 0 });
    const b = createUstarTar(normalizeEntries(map), { mtime: 0 });
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    assert.equal(sha256(a), sha256(b));
    assert.equal(a.length % 512, 0);
  });
});
