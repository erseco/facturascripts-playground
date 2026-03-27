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

## Reference projects

- WordPress Playground: architectural inspiration, @php-wasm/web source
- FacturaScripts: application runtime being packaged
- Moodle Playground (`/Users/ernesto/Downloads/git/moodle-playground/`): same @php-wasm stack, reference for patterns
- Omeka-S Playground: original source of `php-compat.js` (now adapted for FacturaScripts)
