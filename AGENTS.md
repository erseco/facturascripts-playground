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
make up
make deps
make prepare
make bundle
make serve
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
                 -> php-cgi-wasm
```

Responsibilities:

- `index.html` / `src/shell/main.js`
  - toolbar, iframe host, blueprint import/export, runtime status
- `remote.html` / `src/remote/main.js`
  - registers the service worker and hosts the scoped playground iframe
- `sw.js`
  - intercepts same-origin requests and routes them to the scoped runtime
- `php-worker.js`
  - owns the `php-cgi-wasm` instance for a scope
- `src/runtime/bootstrap.js`
  - mounts the core, writes config, runs deploy, handles first boot and autologin
- `src/runtime/vfs.js`
  - mounts the readonly FacturaScripts bundle into the WASM filesystem

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
- `scripts/build-vfs-image.mjs`
- `scripts/generate-manifest.mjs`
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

Plugin download/materialization is not implemented yet. `src/runtime/addons.js` is currently a stub.

## Development conventions

- The repo uses ESM.
- Prefer explicit helpers over deeply coupled inline logic.
- Prefer `URL` helpers for browser paths and POSIX-style paths for runtime FS paths.
- Keep comments short and explain why, not what.

## Testing and verification

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
- `remote.html`: runtime host page
- `sw.js`: service worker routing
- `php-worker.js`: PHP worker bridge and boot lifecycle
- `playground.config.json`: runtime defaults
- `src/runtime/bootstrap.js`: installation, config writing, autologin
- `src/runtime/vfs.js`: readonly core bundle mounting
- `src/runtime/manifest.js`: manifest loading
- `src/shared/blueprint.js`: blueprint parsing and normalization
- `src/shared/storage.js`: browser persistence helpers
- `src/styles/app.css`: shell styling
- `Makefile`: common local workflow

## Common pitfalls

- Do not assume the app is hosted at `/`; it may run in a subdirectory.
- Do not assume persisted state is reset automatically; version mismatch handling depends on config.
- Do not assume plugins declared in blueprint are automatically installed.
- Do not break the separation between readonly core and mutable overlay.
- Do not forget that service worker changes may require a hard refresh.

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

## Reference projects

- WordPress Playground: architectural inspiration
- FacturaScripts: application runtime being packaged
