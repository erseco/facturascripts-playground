import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import {
  createDecodedTarStream,
  extractTarStreamToPhp,
  StreamingTarParser,
} from "../lib/streaming-tar-extract.js";

const BLOCK = 512;

// Header with a caller-controlled raw size field, to exercise octal parsing.
function header(name, { sizeField, type = "0" } = {}) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  if (sizeField) h.write(sizeField, 124, 12, "ascii");
  h.write(type, 156, 1, "ascii");
  return h;
}

function file(name, data, sizeField) {
  const body = Buffer.from(data);
  const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return Buffer.concat([
    header(name, { sizeField: sizeField ?? `${body.length.toString(8)}\0` }),
    body,
    Buffer.alloc(pad),
  ]);
}

const tarOf = (...parts) => Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]);

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("StreamingTarParser edge cases", () => {
  it("parses space-padded octal sizes and treats a blank size as empty", () => {
    const entries = [];
    const parser = new StreamingTarParser({ onEntry: (e) => entries.push(e) });
    parser.push(
      tarOf(
        file("a.txt", "hello", "     5 "),
        header("empty.txt", { sizeField: "" }),
      ),
    );
    parser.end();
    assert.deepEqual(
      entries.map((e) => [e.path, Buffer.from(e.data).toString()]),
      [
        ["a.txt", "hello"],
        ["empty.txt", ""],
      ],
    );
  });

  it("skips symlinks and entries that sanitize to nothing", () => {
    const parser = new StreamingTarParser();
    parser.push(
      tarOf(
        header("link", { type: "2" }),
        header("./", { type: "5" }),
        file("keep.php", "<?php"),
      ),
    );
    assert.deepEqual(parser.end(), {
      fileCount: 1,
      dirCount: 0,
      phpCount: 1,
      bytesWritten: 5,
      maxBuffered: parser.maxBuffered,
    });
  });
});

describe("createDecodedTarStream", () => {
  const payload = Buffer.from("tar bytes ".repeat(100));

  it("decodes gzip through the native DecompressionStream", async () => {
    const stream = await createDecodedTarStream(gzipSync(payload), "gzip");
    assert.deepEqual(await readAll(stream), payload);
  });

  it("decodes zstd with the bundled zstddec decoder", async () => {
    const stream = await createDecodedTarStream(
      zstdCompressSync(payload),
      "zstd",
    );
    assert.deepEqual(await readAll(stream), payload);
  });

  it("rejects a codec no decoder supports", async () => {
    await assert.rejects(createDecodedTarStream(new Uint8Array(), "lzma"), {
      message: 'No streaming decoder available for codec "lzma".',
    });
  });

  it("maps the br alias to brotli before asking the native decoder", async () => {
    const original = globalThis.DecompressionStream;
    const formats = [];
    globalThis.DecompressionStream = class extends TransformStream {
      constructor(format) {
        super();
        formats.push(format);
      }
    };
    try {
      const stream = await createDecodedTarStream(payload, "br");
      assert.deepEqual(await readAll(stream), payload);
      assert.deepEqual(formats, ["brotli"]);
    } finally {
      globalThis.DecompressionStream = original;
    }
  });
});

describe("extractTarStreamToPhp", () => {
  it("writes at the filesystem root and reports progress every 1000 files", async () => {
    const parts = [];
    for (let i = 0; i < 1000; i += 1) parts.push(file(`f${i}.txt`, "x"));
    const tar = tarOf(...parts);
    const dirs = [];
    const written = [];
    const php = {
      _php: {
        mkdirTree: (d) => dirs.push(d),
        writeFile: (p) => written.push(p),
      },
    };
    const progress = [];
    const stats = await extractTarStreamToPhp(
      new Response(tar).body,
      php,
      "/",
      { onProgress: (p) => progress.push(p) },
    );
    assert.deepEqual(dirs, []);
    assert.equal(written.length, 1000);
    assert.equal(written[0], "/f0.txt");
    assert.deepEqual(progress, [{ fileCount: 1000, bytes: 1000 }]);
    assert.equal(stats.fileCount, 1000);
  });
});
