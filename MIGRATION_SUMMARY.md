# FacturaScripts Playground Migration Summary

This repository has been fully migrated from the legacy Sean Morris PHP WASM stack (`php-cgi-wasm`, `php-wasm`) to the modern WordPress Playground `@php-wasm/universal` and `@php-wasm/web` ecosystem, aligning its architecture with `omeka-s-playground` and `moodle-playground`.

## What was replaced

1. **Dependencies**: `php-cgi-wasm`, `php-wasm`, and the many `php-wasm-*` extensions have been removed. `@php-wasm/universal`, `@php-wasm/web`, and `esbuild` were added. PGlite has been removed as this is SQLite only for now.
2. **Worker Build**: Instead of using raw ESM files for the worker, the worker is now built using `esbuild` (`scripts/esbuild.worker.mjs`), resolving issues with Emscripten Node.js built-ins.
3. **VFS artifacts**: The legacy `.vfs.bin` and `.vfs.index.json` approach was completely replaced. The bundle now produces standard `.zip` files (e.g., `facturascripts-core-unknown.zip`) that are downloaded, cached via Cache API, and extracted via `fflate` into the Emscripten MEMFS directly in the browser.
4. **Manifests**: Manifests were upgraded to schema `v2` (matching Omeka/Moodle).
5. **Runtime Bootstrapping**: `php-loader.js` was rewritten to use `PHP` and `wrapPhpInstance`.
6. **Network Proxy**: Outbound HTTP intercepting and the restrictive `installOutboundFetchPolicy` was removed. `@php-wasm/web` handles `fetch` natively through the browser APIs, supporting standard CORS.

## What was copied/adapted from Omeka S / Moodle / WordPress Playground

1. **Loader Script**: `facturascripts-loader.js` was introduced to handle streaming ZIP extraction and loading into the `PHP` instance (adapted from `omeka-loader.js`).
2. **Crash Recovery**: Added `crash-recovery.js` and `php-compat.js` for snapshotting memory states and recovering from fatal WASM errors automatically.
3. **Github Actions**: Replaced the `pages.yml` and `ci.yml` workflows with the ones from Omeka, adapted for FacturaScripts.

## What was simplified

1. The `runtime-registry.js` file tracking shared libraries is entirely gone, as `@php-wasm` automatically bundles and manages extensions.
2. The UI and Shell implementation (`src/shell/main.js`, `index.html`) is simplified and updated to use the unified Omeka/Moodle UI architecture, complete with log panels and system config screens. Colors have been updated to match FacturaScripts branding (`#1E3A8A` / `--color-fs-blue`).
3. `addons.js` is drastically simplified. Instead of using complex memory mapping, it downloads `.zip` files to `/persist/addons/downloads` and delegates directly to PHP.

## Compatibility Note (Preserved Features)

- The FacturaScripts custom wizard logic and setup sequences are preserved.
- Specifically, the system still runs `$user->loadFromCode` and `new Empresa()` during the bootstrap to auto-configure initial admin users and setup conditions.
- FacturaScripts Plugin deployment (`Plugins::deploy()`) is fully preserved and executed directly via `wrapPhpInstance().request()`.
- FacturaScripts Blueprint seeding (creating Customers, Suppliers, Products) is adapted and working correctly within the new memory file system.
