import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
} from "../scripts/lib/tar-ustar.mjs";

const enc = (s) => new TextEncoder().encode(s);

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
