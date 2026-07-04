<!--
MAINTENANCE: Update this file when:
- Adding/removing npm scripts in package.json or targets in Makefile
- Changing the runtime flow (shell, remote host, service worker, php worker)
- Modifying the FacturaScripts bundle format, manifest schema, or storage model
- Changing deployment assumptions for static hosting
- Changing playground.config.json or blueprint semantics
-->

# AGENTS.md

This file provides guidance to AI coding agents when working with this repository.

**IMPORTANT:** Before making changes, read `CHANGELOG-TECHNICAL.md` — it documents
past investigations, decisions, and known limitations. This avoids re-investigating
solved problems and explains why certain non-obvious choices were made (e.g., why
Intl is disabled, why the prepend path is at `/internal/shared/auto_prepend_file.php`,
why `Plugins::deploy(true, true)` is used instead of `deploy()`).

## Project overview

FacturaScripts Playground runs a full FacturaScripts instance entirely in the browser using WebAssembly.

Main layers:

1. Shell UI: `index.html` and `src/shell/main.js`
2. Runtime host: `remote.html` and `src/remote/main.js`
3. Request routing: `sw.js` and `php-worker.js`
4. FacturaScripts runtime boot: `src/runtime/*`
5. Local dev server: `scripts/dev-server.mjs`

At runtime, the readonly FacturaScripts core is loaded from a prebuilt bundle and mutable state is kept in browser persistence.

## Build system

Requirements:

- Node.js 18+
- npm
- Composer
- Git

Common commands:

```bash
npm install
npm run sync-browser-deps
npm run prepare-runtime
npm run bundle
npm run test:e2e
make up
make deps
make prepare
make bundle
make serve
make test-e2e
make lint
make format
make test
make clean
make reset
```

Important scripts:

- `npm run sync-browser-deps`: vendors browser runtime dependencies
- `npm run prepare-runtime`: prepares runtime assets
- `npm run bundle`: builds the readonly FacturaScripts bundle
- `npm run test:e2e`: runs the Playwright browser suite

Generated assets:

- `assets/facturascripts/`: readonly runtime bundle files
- `assets/manifests/`: generated manifest files

Do not hand-edit generated bundle artifacts unless the task is specifically about build output.

## Runtime flow

```text
index.html
  -> src/shell/main.js
     -> remote.html
        -> src/remote/main.js
           -> sw.js
              -> php-worker.js
                 -> src/runtime/bootstrap.js
                 -> src/runtime/vfs.js
                 -> @php-wasm/web (via php-loader.js + php-compat.js)
```

Responsibilities:

- `index.html` / `src/shell/main.js`
  - toolbar, iframe host, blueprint import/export, runtime status
- `remote.html` / `src/remote/main.js`
  - registers the service worker and hosts the scoped playground iframe
- `sw.js`
  - intercepts same-origin requests and routes them to the scoped runtime
- `php-worker.js`
  - owns the @php-wasm/web PHP instance for a scope, with crash recovery
- `src/runtime/bootstrap.js`
  - mounts the core, writes config, runs deploy, handles first boot and autologin
- `src/runtime/vfs.js`
  - helper that mounts the readonly FacturaScripts bundle into the WASM filesystem

## Storage model

- Readonly core: mounted in memory under `/www/facturascripts`
- Mutable database: `/persist/mutable/db/facturascripts.sqlite`
- Mutable config: `/persist/mutable/config`
- Mutable session: `/persist/mutable/session`
- FacturaScripts writable directories: `/www/facturascripts/Dinamic`, `/www/facturascripts/MyFiles`, `/www/facturascripts/Plugins`

Do not reintroduce boot-time copying of the entire core into persistent browser storage.

## Bundle and manifest

Relevant files:

- `scripts/build-facturascripts-bundle.sh`
- `scripts/fetch-facturascripts-source.sh`
- `scripts/generate-manifest.mjs`
- `scripts/esbuild.worker.mjs`
- `src/runtime/manifest.js`

Default build source:

- `FS_REF=https://github.com/erseco/facturascripts.git`
- `FS_REF_BRANCH=feature/add-sqlite-support`

Bundle format: a single streaming `tar.zst` (`format: "tar.zst"`, `container: "tar"`,
`codec: "zstd"` in the manifest). The build packs the staged core with
`scripts/build-tar-zst-bundle.mjs` (deterministic USTAR + zstd level 19); the browser
runtime extracts it in `src/runtime/vfs.js` by streaming zstd decode + incremental TAR
parsing straight into MEMFS (`lib/streaming-tar-extract.js`). The old ZIP path is fully
removed — there is no fallback. See `docs/streaming-tar-zst-core-bundle.md`. Building the
bundle needs Node >= 22.15 (native `node:zlib` zstd); CI runs Node 24.

If you change bundle structure, update manifest generation and runtime loading together.

## Configuration

Runtime defaults live in:

- `playground.config.json`
- `src/shared/config.js`

Important flags:

- `bundleVersion`
- `defaultBlueprintUrl`
- `siteTitle`
- `landingPath`
- `locale`
- `timezone`
- `autologin`
- `resetOnVersionMismatch`
- `admin.*`
- `runtimes[]`

Blueprint input lives in:

- `assets/blueprints/default.blueprint.json`
- `assets/blueprints/blueprint-schema.json`
- `src/shared/blueprint.js`

Current blueprint focus:

- debug mode
- landing page
- title, locale, timezone
- login credentials
- declarative plugin list

Plugin download/materialization is implemented in `src/runtime/addons.js`.

## Development conventions

- The repo uses ESM.
- Prefer explicit helpers over deeply coupled inline logic.
- Prefer `URL` helpers for browser paths and POSIX-style paths for runtime FS paths.
- Keep comments short and explain why, not what.

## Linting, formatting, and testing

Before committing or submitting a PR, always run:

```bash
make lint      # Run Biome linter — must pass with zero errors
make format    # Auto-fix lint and formatting issues
make test      # Run unit tests — all must pass
make test-e2e  # Run browser e2e tests
```

Biome is configured in `biome.json` and checks `src/`, `tests/`, and `scripts/`. Fix any lint errors before committing. Use `make format` to auto-fix formatting and safe lint issues.

Typical syntax checks:

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/vfs.js
node --check src/shell/main.js
node --check src/shared/blueprint.js
```

Useful manual validation areas:

- first boot install
- reload with persisted state
- autologin flow
- navigation inside FacturaScripts
- service worker updates after rebuild or redeploy

If a change touches routing or boot behavior, prefer checking real browser behavior and not only syntax.

## Key files

- `index.html`: shell UI
- `remote.html`: runtime host page (loading overlay with progress bar)
- `sw.js`: service worker routing and static asset caching
- `php-worker.js`: PHP worker bridge, boot lifecycle, crash recovery, request tracing
- `playground.config.json`: runtime defaults
- `src/runtime/bootstrap.js`: installation, config writing, autologin, Forja cache
- `src/runtime/php-loader.js`: @php-wasm/web runtime creation, OPcache config, fs-persistence
- `src/runtime/php-compat.js`: wraps @php-wasm PHP instance with cookie jar, front-controller routing
- `src/runtime/fs-persistence.js`: IndexedDB-backed filesystem journal
- `src/runtime/crash-recovery.js`: WASM crash detection, snapshot, automatic restart
- `src/runtime/vfs.js`: readonly core bundle mount helper
- `src/runtime/manifest.js`: manifest loading
- `src/runtime/addons.js`: blueprint plugin install/activate and seed data
- `src/runtime/networking.js`: proxy URL resolution for plugin downloads
- `src/shared/blueprint.js`: blueprint parsing and normalization
- `src/shared/config.js`: playground configuration loading and merging
- `src/shared/paths.js`: path resolution utilities for subdirectory hosting
- `src/shared/protocol.js`: BroadcastChannel naming and worker request IDs
- `src/shared/storage.js`: browser persistence helpers
- `src/styles/app.css`: shell styling
- `Makefile`: common local workflow
- `playwright.config.mjs`: Playwright runner and local web server bootstrap
- `tests/e2e/`: browser e2e tests for the shell/runtime UI
- `CHANGELOG-TECHNICAL.md`: decision log — read before making changes

## Common pitfalls

- Do not assume the app is hosted at `/`; it may run in a subdirectory.
- Do not assume persisted state is reset automatically; version mismatch handling depends on config.
- Do not assume plugins declared in blueprint are automatically installed.
- Do not break the separation between readonly core and mutable overlay.
- Do not forget that service worker changes may require a hard refresh.
- The real curl extension in @php-wasm/web does NOT go through `globalThis.fetch`. JS fetch blockers do not intercept curl calls. Use PHP-side cache pre-population instead.
- The `auto_prepend_file` must be at `/internal/shared/auto_prepend_file.php` — this is the only path @php-wasm reads. Writing to other paths has no effect.
- `Plugins::deploy()` must be called with `(true, true)` to populate the `pages` table. Without `initControllers`, FK constraints on `users.homepage` fail.
- `opcache.file_cache_only` must be `1` in WASM (shared memory OPcache needs COOP/COEP headers).
- FacturaScripts uses `parent.document.location` for row click navigation. The SW injects a `parent === window` override in every HTML response. Do not remove this or iframe navigation breaks.
- The SW rewrites `data-href` attributes alongside `href`/`src`/`action`. FacturaScripts stores navigation URLs in `data-href` on `<tr class="clickableRow">`.
- `Cache::clear()` in FacturaScripts deletes ALL `.cache` files including Forja cache. Bootstrap patches `Cache.php` in MEMFS to exclude `forja_*` files. Without this, plugin enable/disable triggers 20s curl timeouts.

## Area-specific guidance

If you edit `sw.js`:

- preserve scoped runtime routing
- preserve subdirectory hosting support

If you edit `bootstrap.js`:

- verify install idempotency
- verify persisted data survives reloads
- verify autologin still works

If you edit bundle scripts:

- keep manifest schema and runtime readers in sync
- avoid casual output filename changes

## Deployment notes

This project is intended for static deployment.

After changes to `sw.js`, `remote.html`, or runtime boot files:

- redeploy the site
- force-refresh the browser or clear the old service worker
- verify from a clean scope when possible

## Performance notes

- Plugin operations (install/enable) take ~20s. This is pure PHP execution in WASM (`Plugins::deploy` + `initControllers` for 111 controllers). No network calls involved. See `CHANGELOG-TECHNICAL.md` for details.
- Page loads take ~5-15s depending on complexity. OPcache file cache helps on warm loads.
- Intl extension is disabled to reduce download size (~27MB ICU data). FacturaScripts does not require it.
- Forja cache files must be pre-populated before any PHP request to avoid 10s curl timeouts.

## Debugging

### By hand (in the browser)

Serve the playground locally and drive it in a real browser — most runtime bugs (routing, persistence, boot) only reproduce there.

```bash
make serve            # PORT defaults to 8085; override with PORT=9090 make serve
```

Use a high port. A port below 1024 fails with `EACCES` (the dev server is not privileged). Then open `http://localhost:<port>/`.

Frame and routing layout:

- The shell loads at `/` (`index.html` → `#site-frame`).
- `#site-frame` hosts `remote.html`, which nests `#remote-frame`.
- `#remote-frame` points at `/playground/<scope>/<runtime>/…`, intercepted and served by the Service Worker.
- `<runtime>` is a runtime id such as `php83` (default; see `playground.config.json`).
- `<scope>` is a sessionStorage-scoped id (`getOrCreateScopeId`), unique within a browser session, so each tab/session gets isolated mutable state.

The runtime is ready when `#address-input` is enabled. First boot is slow (install + deploy), so poll rather than assume:

```js
// In the shell page console (top frame).
const addr = document.querySelector("#address-input");
console.log("ready:", addr && !addr.disabled);
```

Dump the IndexedDB journals to inspect persisted ops. There are TWO databases — the per-scope filesystem journal and the per-PHP-version OPcache journal — both using the `ops` object store:

```js
// In the shell page console. Replace <scope> and <phpVersion> with the live values.
async function dumpJournal(dbName) {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const ops = await new Promise((res, rej) => {
    const r = db.transaction("ops", "readonly").objectStore("ops").getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  console.log(dbName, ops.length, ops);
  db.close();
}
dumpJournal("facturascripts-fs-journal:<scope>"); // mutable app data (DB, config, session)
dumpJournal("facturascripts-opcache:<phpVersion>"); // compiled bytecode, e.g. 8.3
```

Default admin credentials are `admin` / `admin` (see `playground.config.json` → `admin.*`). Autologin is on by default.

Notes when debugging persistence and plugins:

- Plugins install PHP-side: `addons.js` downloads the ZIP, then calls `Plugins::add($zipPath, …)` which uses `ZipArchive`. This is not a JS-side extraction.
- Persistence replays via `replayResilient` (`fs-persistence.js`): the whole batch is replayed first, and on any failure it replays op-by-op and skips the un-appliable ones. A single bad journal op never bricks the reload — so a "missing" file after reload usually means an op was skipped, not that journaling failed.

Reset a corrupted scope with the `#reset-button` ("Reset Playground") in the shell, or by booting with `?clean=1`. Both force a clean boot that clears BOTH journals (`clearJournal` for the FS journal and `clearOpcacheJournal` for the OPcache journal).

### With the e2e suite (Playwright)

Browser e2e tests live in `tests/e2e/*.spec.mjs` and run with:

```bash
npm run test:e2e      # = playwright test
make test-e2e         # same thing
```

`playwright.config.mjs` boots the dev server automatically. Tests wait for readiness via `#address-input` being enabled.

In CI the e2e run is the last step ("Run Playwright tests") of the single `test` job in `.github/workflows/ci.yml` — there is no separate `e2e` job.

Gotcha: run each sibling playground's e2e suite on its own. Playwright reuses an existing dev server on a shared port (`reuseExistingServer`), so two playgrounds' e2e runs in parallel will hit the same server and cross-contaminate each other's apps and state.

## Reference projects

- WordPress Playground: architectural inspiration, @php-wasm/web source
- FacturaScripts: application runtime being packaged
- Moodle Playground (`/Users/ernesto/Downloads/git/moodle-playground/`): same @php-wasm stack, reference for patterns
- Omeka-S Playground: original source of `php-compat.js` (now adapted for FacturaScripts)

## Persistence model (per-tab storage + blueprint reset)

Mutable state under `/persist` is journaled to IndexedDB (`facturascripts-fs-journal:<scope>`) via
`@php-wasm/fs-journal`, so it survives reloads. Key facts for future work:

- **Per-tab, within-session.** `scopeId` lives in `sessionStorage`, so each
  browser tab/window has its own environment. Opening the playground in a new tab
  starts clean — nothing is shared (only *duplicating* a tab copies
  `sessionStorage`). State is lost when the tab closes.
- **A different blueprint starts fresh.** The persisted env is keyed by the
  blueprint *source* — `blueprintSourceKey(href)` in `src/shared/paths.js`
  (`url:<value>` for `?blueprint-url=`, `inline:<hash>` for `?blueprint=` /
  `?blueprint-data=`, else `default`) — remembered per scope in `sessionStorage`
  (`blueprint-source:<scope>`). Loading a **different** blueprint in the same tab
  forces a clean boot (discards the previous `/persist` and installs fresh);
  **reloading the same blueprint keeps the data.** (Same intent as WordPress
  Playground, which serves URL blueprints as temporary by default and keys
  persisted sites per site-slug.)
- **Clean boot wiring.** On a clean boot the shell adds `&clean=1` to the
  `#site-frame` remote URL; the worker then `clearJournal`s and **re-starts
  journaling** (`initFsPersistence` runs after the clear in
  `src/runtime/php-loader.js`) so the fresh env persists on later reloads. The
  `#reset-button` triggers the same path.
- **Flush.** On each debounced flush the journal collapses ops *before* hydrating
  (`collapseAndHydrate` = `hydrateUpdateFileOps(php, normalizeFilesystemOperations(ops))`)
  so a heavy install that rewrites the SQLite DB hundreds of times doesn't OOM.
- **Inspect:** `await indexedDB.databases()` → open `facturascripts-fs-journal:<scope>` → read the
  `ops` object store.
