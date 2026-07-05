# Streaming `tar.zst` core bundle

## Status

Accepted (2026). Replaces the ZIP core bundle. There is no ZIP fallback.

## Context

On every cold boot the playground downloads the readonly FacturaScripts core, verifies
its SHA-256, and mounts it into the PHP-WASM MEMFS under `/www/facturascripts`. The
previous format was a `facturascripts-core-<release>.zip` (deflate). At boot the whole
ZIP was written into MEMFS and extracted with PHP's native `ZipArchive::extractTo()`
(`src/runtime/core-extract-script.js`). Native extraction was chosen because the JS
paths (fflate `unzipSync` — decompresses every entry into the JS heap at once — and a
per-entry `DecompressionStream` streamer — far too slow at this file count) either
risked MEMFS OOM or pushed boot past the readiness gate.

A ZIP is compressed **per file** with a 32 KiB window, so it cannot exploit the large
cross-file redundancy in a PHP application tree (vendored libraries, near-identical
templates, translations). A **solid** archive — one compression stream over a `tar` of
the whole tree — with a modern codec (zstd) shrinks the download materially.

## Decision

Replace the ZIP core bundle **entirely** with a single streaming `tar.zst` bundle:

- **Build** (`scripts/build-facturascripts-bundle.sh` → `scripts/build-tar-zst-bundle.mjs`):
  the staged core tree is packed into a deterministic USTAR tar (with the USTAR
  `prefix`/`name` split for long paths and GNU `././@LongLink` for the few that do not
  fit — never PAX) and compressed with `node:zlib` zstd level 19 + long-distance
  matching (windowLog 27). The output is `facturascripts-core-<release>.tar.zst`.
- **Manifest** (`scripts/generate-manifest.mjs`): `format: "tar.zst"`, `container: "tar"`,
  `codec: "zstd"`. `path`, `size`, `sha256` (over the `.tar.zst`) and `fileCount` are
  unchanged. The loader (`lib/facturascripts-loader.js`) is format-agnostic — it fetches
  and SHA-256-verifies the bytes regardless of container — and is kept as-is.
- **Runtime** (`src/runtime/vfs.js`, `mountReadonlyCore`): the compressed bytes are
  decoded by streaming zstd (`createDecodedTarStream`) and parsed incrementally
  (`StreamingTarParser`), writing each entry straight into MEMFS via the raw Emscripten
  module (`php._php.mkdirTree` / `php._php.writeFile`) as it decodes
  (`lib/streaming-tar-extract.js`). The uncompressed tar is **never** materialized: peak
  memory is bounded to roughly one file plus one decoded chunk (a few MiB), not the whole
  archive. A parity tripwire throws if the streamed file count differs from the manifest's
  `bundle.fileCount`.

The old ZIP path is removed: `src/runtime/core-extract-script.js` is deleted and there is
no JavaScript fallback. `fflate` and the plugin/add-on ZIP install path
(`addons.js` → `Plugins::add()` via `ZipArchive`) are untouched — this decision only
concerns the readonly core bundle.

## Why

- **Smaller download → faster cold boot.** `tar.zst` is roughly half the size of the ZIP
  on a real PHP tree, so on a real network the smaller download hides behind the WASM
  compile instead of blocking boot (the sibling moodle-playground experiment measured
  ~3× faster cold boot on Cloudflare — see moodle-playground ADR 0018).
- **Bounded peak memory.** Streaming decode + incremental TAR parsing never holds the
  full uncompressed tree, so it does not regress peak memory the way a
  "decode the whole tar, then extract" prototype does (moodle-playground ADR 0019). This
  is what made adoption safe.
- **Chrome and Firefox.** No shipping browser exposes `DecompressionStream("zstd")`, so a
  small WASM decoder (`zstddec`, imported as `zstddec/stream`) is bundled into the worker.
  It streams on every target browser. `PharData` / ext-`phar` is not required — the writer
  goes through the raw Emscripten module.
- **Simpler.** One format, one code path, no fallback branch to maintain.

## Consequences

- Building the bundle needs Node ≥ 22.15 (native `node:zlib` zstd). The bundle-building CI
  jobs (`.github/workflows/pages.yml`, and the e2e job in `.github/workflows/ci.yml` via
  `make up`) run Node 24.
- A new runtime dependency, `zstddec` (`^0.2.0`), is bundled into the PHP worker by
  esbuild.
- The parity tripwire turns a truncated or mis-decoded bundle into a loud boot failure
  rather than a silently partial core.

## References

- moodle-playground ADR 0018 — solid-compression experiment and the ~51 % download /
  ~3× cold-boot measurements.
- moodle-playground ADR 0019 — streaming `tar.zst` extraction (bounded peak memory),
  the mechanism this port reuses verbatim.
