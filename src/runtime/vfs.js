import { resolveBootstrapArchive } from "../../lib/facturascripts-loader.js";

export async function mountReadonlyCore(
  php,
  manifest,
  { root = "/www/facturascripts", publish, bytes = null } = {},
) {
  // Parallel boot: prefer the core bytes the worker downloaded while the WASM
  // runtime was compiling. Fall back to a lazy download when called without
  // them, where the bundle is served from the Cache API so the fetch is cheap.
  let archiveBytes = bytes;
  if (!archiveBytes) {
    const archive = await resolveBootstrapArchive({ manifest }, (progress) => {
      if (publish && progress.ratio !== undefined) {
        publish(
          `Downloading FacturaScripts bundle: ${Math.round(progress.ratio * 100)}%`,
          0.3 + progress.ratio * 0.15,
        );
      }
    });
    archiveBytes = archive.bytes;
  }

  // Extract the tar.zst core by streaming zstd decode + incremental USTAR
  // parsing, writing each entry straight into MEMFS as it decodes (see
  // lib/streaming-tar-extract.js). The uncompressed tar is never materialized —
  // peak memory is bounded to roughly one file plus a decoded chunk — so this
  // avoids the whole-archive `unzipSync` heap OOM and the per-entry
  // DecompressionStream overhead of the old ZIP path, while working on Chrome and
  // Firefox alike. The install is not cached, so a reload retries; any
  // decode/parse error fails loud (no JS fallback by design).
  publish?.("Extracting FacturaScripts core…", 0.45);
  const { createDecodedTarStream, extractTarStreamToPhp } = await import(
    "../../lib/streaming-tar-extract.js"
  );
  const codec = manifest?.bundle?.codec ?? "zstd";
  const stream = await createDecodedTarStream(archiveBytes, codec);
  // Release our local reference to the compressed buffer. On the native
  // DecompressionStream path this lets the GC reclaim it as the tar streams into
  // MEMFS; on the zstddec fallback the decoder keeps its own reference until
  // extraction finishes, so this is a no-op there.
  archiveBytes = null;
  const stats = await extractTarStreamToPhp(stream, php, root);

  // Parity tripwire: the streamed file count must match the manifest's, or the
  // bundle was truncated / decoded wrong.
  if (
    manifest?.bundle?.fileCount &&
    stats.fileCount !== manifest.bundle.fileCount
  ) {
    throw new Error(
      `core tar file-count parity mismatch: ${stats.fileCount} != ${manifest.bundle.fileCount}`,
    );
  }

  return { manifest, entries: stats.fileCount };
}

export async function fetchArrayBuffer(path, cache = "default") {
  const response = await fetch(path, { cache });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}
