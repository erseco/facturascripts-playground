# Technical Decision Log

This file documents key technical decisions, investigations, and their rationale.
AI agents working on this codebase should read this file to understand why things
are the way they are and avoid re-investigating solved problems.

---

## Migration from php-cgi-wasm to @php-wasm/web

**Date:** 2026-03-26
**Context:** Migrated from Sean Morris' `php-cgi-wasm` v0.0.9-alpha-32 to WordPress Playground's `@php-wasm/web` v3.1.13.

### What changed

| Aspect | Legacy (php-cgi-wasm) | New (@php-wasm/web) |
|--------|----------------------|---------------------|
| Cookie handling | `php.cookieJar.store()` API | `wrapPhpInstance` cookie Map + `php.setCookie()` |
| Curl | PHP polyfill shim (all calls intercepted) | Real curl extension in WASM (not interceptable via JS) |
| OPcache | None persisted | File-cache via IndexedDB journal |
| FS persistence | `syncfs()` per request | Async journal with 1.5s debounce |
| Static assets | All through PHP engine | Direct FS bypass in `wrapPhpInstance` |
| Crash recovery | None | Snapshot + automatic restart |

### Key issues found and fixed

#### 1. Autologin broken — `$user->save()` fails with FK constraint
**Root cause:** `Plugins::deploy()` was called WITHOUT `initControllers` (lost during migration). The `pages` table stayed empty, so `users.homepage → pages.name` FK violated on save.
**Fix:** Changed `Plugins::deploy()` → `Plugins::deploy(true, true)` in `buildInstallScript()`. Also reordered wizard to create empresa/almacen BEFORE user (FK on `idempresa`).
**Files:** `src/runtime/bootstrap.js`

#### 2. Forja HTTP timeouts (~60s delays)
**Root cause:** Legacy stack had a PHP curl shim that returned empty results for ALL HTTP calls. New stack uses real curl extension which goes through Emscripten networking — NOT through `globalThis.fetch` — so the JS fetch blocker doesn't intercept.
**Fix:** Pre-populate Forja cache files (`forja_builds.cache`, `forja_plugins.cache`) via `php.writeFile()` during bootstrap AND via PHP prepend on every request. `Cache::remember()` returns cached data immediately, curl callback never fires.
**Files:** `src/runtime/bootstrap.js` (mutableDirs + cache pre-population + prepend)

#### 3. PHP prepend not executing
**Root cause:** `@php-wasm/web` reads `auto_prepend_file` from `/internal/shared/php.ini`. The old code wrote the prepend to `/config/playground-prepend.php` and set the path in a file-based `/php.ini` at `/php.ini` — but @php-wasm never reads that file.
**Fix:** Changed `PLAYGROUND_PREPEND_PATH` to `/internal/shared/auto_prepend_file.php` (the default @php-wasm location). Removed the code in `php-loader.js` that emptied this file.
**Files:** `src/runtime/bootstrap.js`, `src/runtime/php-loader.js`

#### 4. php-compat.js was copy-pasted from omeka-s-playground
**Issue:** `DEFAULT_WEB_ROOT = "/www/omeka"`, User-Agent "OmekaPlayground/1.0", Omeka-specific comments.
**Fix:** Updated all references to FacturaScripts.
**Files:** `src/runtime/php-compat.js`

#### 5. Progress bar not updating during bootstrap
**Root cause:** `setRemoteProgress()` in `remote.html` ignored the `progress` parameter. Also, bootstrap progress messages from the worker went to the shell via BroadcastChannel but `remote.html` didn't listen to them.
**Fix:** Wired up `progressFillEl` and `progressPercentEl`. Added BroadcastChannel listener in remote for worker progress.
**Files:** `src/remote/main.js`, `remote.html`

#### 6. phpinfo button not working
**Root cause:** Shell sends `capture-phpinfo` to `remote.html` via postMessage. Remote didn't forward it to the PHP worker.
**Fix:** Added handler in `bindShellCommands` to forward `capture-phpinfo` to the worker.
**Files:** `src/remote/main.js`

### Performance decisions

#### Intl extension disabled
**Rationale:** FacturaScripts only needs bcmath, curl, fileinfo, gd, mbstring, openssl, simplexml, zip. Loading Intl adds ~27MB of ICU data to every session. Disabled via `loadWebRuntime(phpVersion)` without `{ withIntl: true }`.
**Impact:** Did not measurably improve PHP execution speed (the bottleneck is PHP interpretation in WASM, not memory). Kept disabled to reduce download size.
**Files:** `src/runtime/php-loader.js`

#### OPcache file_cache_only = 1
**Rationale:** @php-wasm default is `file_cache_only = 1` (file-only cache). We had set it to `0` (shared memory + file) but SharedArrayBuffer requires COOP/COEP headers which the playground may not have. With `file_cache_only = 0`, OPcache could silently disable itself.
**Files:** `src/runtime/php-loader.js`

#### default_socket_timeout = 1
**Rationale:** Safety net for any PHP stream-based HTTP calls that bypass the Forja cache. Limits socket operations to 1s. Note: this does NOT affect curl (which uses `CURLOPT_TIMEOUT` set by FacturaScripts to 10s).
**Files:** `src/runtime/php-loader.js`

#### Plugin install/enable was slow (~20s) — Cache::clear() deleted Forja cache
**Root cause:** `AdminPlugins::enablePluginAction()` calls `Cache::clear()` after enabling a plugin. `Cache::clear()` deletes ALL `.cache` files in `MyFiles/Tmp/FileCache`, including `forja_builds.cache` and `forja_plugins.cache`. After the clear, `privateCore()` calls `Forja::plugins()` and `Forja::canUpdateCore()` — both find no cache and trigger curl requests to `facturascripts.com` with 10s timeouts each. Total: ~20s delay.
**Why blueprint was fast:** Blueprint installs plugins via a direct PHP script (`addons.js`) that calls `Plugins::add()` + `Plugins::enable()` without going through the AdminPlugins controller. No `Cache::clear()`, no Forja calls, no curl timeouts.
**Fix:** Patch `Cache.php` in MEMFS during bootstrap to exclude `forja_*` files from `clear()`. The Forja cache files survive the clear and serve cached data immediately.
**Files:** `src/runtime/bootstrap.js` (Cache.php MEMFS patch)

#### 7. Navigation freeze after Edit pages — `parent.document.location`
**Root cause:** FacturaScripts' `Custom.js` (line 150) uses `parent.document.location = $(this).attr("data-href")` for clickable row navigation via the `.clickableRow` mousedown handler. Inside the playground iframe, `parent` is `remote.html` — not the FS page. Clicking a table row navigates `remote.html` away, destroying the entire playground. Chrome shows this as a silent freeze; Firefox may show `ErrnoError { errno: 23 }`.

**Why it was hard to find:** The bug only triggers with real mouse clicks on table rows (which fire the jQuery `.mousedown` handler). Programmatic navigation (address bar, Playwright `evaluate`) bypasses the handler entirely and works fine. The `.cancelClickable` class on `<a>` links inside rows prevents the link's own mousedown from bubbling — the ROW's mousedown does the actual navigation.

**Fix:** The SW injects `<script>try{Object.defineProperty(window,"parent",{get:()=>window})}catch(e){}</script>` into every HTML `<head>` via `rewriteHtmlDocument()`. This makes `parent === window`, matching native FS behavior (where `parent` IS `window`). The SW also rewrites `data-href` attributes alongside `href`/`src`/`action` so the scoped URLs are correct.

**Files:** `sw.js`

### Known limitations

#### Plugin operations take ~20s
`Plugins::enable()` calls `deploy(false, true)` which runs `initControllers()` on all 111 controllers. This is pure PHP execution in WASM — no external calls involved (verified: Forja cache returns in 1ms). The `php-worker.js` trace logging shows the exact timing: `[php] POST /AdminPlugins → 200 (20099ms)`. There is no playground-level fix for this; it would require changes in FacturaScripts itself (e.g., skipping `initControllers` during enable).

#### Page loads take ~5-15s
Normal WASM overhead for a complex PHP framework. Each request compiles Twig templates, loads dozens of PHP classes, and queries SQLite. OPcache file cache helps on subsequent requests for the same PHP files.

#### Real curl still makes network calls
Unlike the legacy PHP curl shim that intercepted ALL calls, the real curl extension in @php-wasm/web goes through Emscripten's networking layer. The JS `globalThis.fetch` blocker does NOT intercept these. We rely on pre-populating the Forja/Telemetry cache files so the HTTP callbacks are never called.
