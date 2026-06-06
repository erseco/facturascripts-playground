# AGENTS.md — FacturaScripts Playground debugging & dev guide

This is a debugging/dev guide for AI agents and humans working on the
**FacturaScripts Playground**: a full FacturaScripts instance running entirely in
the browser on PHP-WASM. It is one of four sibling PHP-WASM playgrounds
(nextcloud, moodle, omeka, facturascripts) that share the same architecture.

> Companion doc: `CHANGELOG-TECHNICAL.md` records past investigations and
> non-obvious decisions (why Intl is disabled, why the prepend lives at
> `/internal/shared/auto_prepend_file.php`, why `Plugins::deploy(true, true)`,
> Forja cache patch, etc.). Read it before touching boot or plugin behavior.

> **Remote note:** this repo's git remote is `erseco` (the user's fork at
> `git@github.com:erseco/facturascripts-playground.git`), not `ateeducacion`.

---

## Overview / Architecture

The playground is a static site. There is no backend — everything runs in the
browser tab via WebAssembly.

Layers:

1. **Shell** — `index.html` + `src/shell/main.js`: toolbar, address bar, the
   `#site-frame` iframe, blueprint import/export, settings, reset.
2. **Runtime host** — `remote.html` + `src/remote/main.js`: registers the
   service worker and hosts the nested scoped iframe (`#remote-frame`) with a
   boot progress overlay.
3. **Request routing** — `sw.js` (service worker) + `php-worker.js` (the worker
   that owns the PHP instance for a scope).
4. **Runtime boot** — `src/runtime/*`: PHP loader, bootstrap/provisioning,
   FS persistence, crash recovery, plugin install, networking, VFS mount.
5. **Shared** — `src/shared/*`: config, blueprint, paths, protocol (channel
   names / request IDs), storage (sessionStorage helpers).
6. **App loader** — `lib/facturascripts-loader.js`: manifest fetch + bundle ZIP
   download with Cache API caching and SHA-256 verification.
7. **Dev server** — `scripts/dev-server.mjs`.

Provisioning is **blueprint-driven** (`assets/blueprints/*`,
`src/shared/blueprint.js`, `src/runtime/addons.js`). The readonly FacturaScripts
core is mounted in MEMFS under `/www/facturascripts`; mutable state lives under
`/persist` (journaled to IndexedDB).

The worker (`php-worker.js`) is **esbuild-bundled** to
`dist/php-worker.bundle.js` (~3.3 MB). Lint is **Biome**. `@php-wasm/*` is pinned
at `^3.1.36` (`@php-wasm/web`, `@php-wasm/universal`, `@php-wasm/fs-journal`).

Request flow:

```text
index.html → src/shell/main.js → remote.html → src/remote/main.js
  → sw.js → php-worker.js → src/runtime/bootstrap.js + php-loader.js
  → @php-wasm/web
```

---

## Running locally

The dev server lives at `scripts/dev-server.mjs` and is wired through the
Makefile `serve` target:

```bash
make bundle              # build dist/php-worker.bundle.js (+ runtime assets) FIRST
PORT=8087 make serve     # serve at http://127.0.0.1:8087
# or one-shot:
PORT=8087 make up        # = bundle + serve
```

The exact serve command is `PORT=$(PORT) node ./scripts/dev-server.mjs`
(`PORT` defaults to `8085`).

**CRITICAL gotcha:** the dev server binds to `process.env.PORT`. A privileged
port (`<1024`) fails with `EACCES`. Always use a high port (e.g. `8087`):

```bash
PORT=8087 make serve     # good
PORT=80   make serve     # EACCES — bind permission denied
```

The server requires the build outputs to exist: `dist/php-worker.bundle.js` (from
`make bundle` / `npm run build-worker`) and `index.html`. Run `make bundle` first
on a clean checkout; the bundle and `assets/facturascripts/*` are gitignored.

---

## Scoped URL routing

- The **shell** is served at `/`.
- The shell renders `#site-frame` whose `src` is
  `remote.html?scope=<scopeId>&runtime=<runtimeId>&path=<path>`
  (built by `resolveRemoteUrl()` in `src/shared/paths.js`).
- `remote.html` registers the SW and hosts a **nested** iframe (`#remote-frame`)
  pointing at the real scoped app path.
- The scoped app path is **`playground/<scopeId>/<runtimeId>/<path>`**
  (built by `buildScopedSitePath()` in `src/shared/paths.js`). The service
  worker intercepts requests under this prefix and routes them to the PHP worker
  for that scope.

`runtimeId` is a PHP-version id from `playground.config.json` →
`runtimes[]`: **`php81`, `php82`, `php83` (default), `php84`, `php85`** (labels
`PHP 8.1`…`PHP 8.5`). Note: `id` is `php83`, but the underlying `phpVersion` is
`"8.3"` — the worker bundle strips any PHP versions not offered here to keep
`dist/` small (see `scripts/esbuild.worker.mjs`).

`scopeId` comes from `getOrCreateScopeId()` (`src/shared/storage.js`): it reads
the `scope` query param or `sessionStorage`, and persists a generated id into
`sessionStorage`. This is what makes persistence **per-session** (see below).

The shell supports subdirectory hosting — do not assume the app is at `/`. Path
helpers (`getBasePath`, `joinBasePath`) in `src/shared/paths.js` handle the
prefix.

---

## Boot & readiness

Booting is **slow** (WASM download + PHP boot + provisioning — tens of seconds,
plugin ops ~20s). Poll for readiness rather than using fixed sleeps.

Readiness signals (this is exactly what the e2e suite waits on):

```js
// #address-input becomes enabled, and #site-frame src contains "scope="
await expect(page.locator("#address-input")).toBeEnabled();
await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
```

The boot overlay (progress bar / status text) lives in `remote.html`
(`#progress-fill`, `#progress-percent`, `#remote-status`) and is driven by
`progress` messages posted from `php-worker.js` over a `BroadcastChannel`.

---

## Persistence model (Wave 4)

Mutable state under **`/persist`** is journaled to IndexedDB via
`@php-wasm/fs-journal`. Code: `src/runtime/fs-persistence.js`. Mutable paths:

- `/persist/mutable/db/facturascripts.sqlite` — SQLite database
  (`PLAYGROUND_DB_PATH` in `src/runtime/bootstrap-paths.js`)
- `/persist/mutable/config` — playground state JSON
- `/persist/mutable/session` — PHP sessions

There are **two** IndexedDB journals (verified prefixes in
`src/runtime/fs-persistence.js`):

- **`facturascripts-fs-journal:<scopeId>`** — the `/persist` data journal, keyed
  by `scopeId`.
- **`facturascripts-opcache:<phpVersion>`** — the OPcache bytecode journal, keyed
  by PHP version, so PHP only compiles each file once across reloads (big warm
  speedup). OPcache ops are replayed *before* `/persist` so bytecode is present
  before any script runs.

Each db has a single object store named **`ops`** (`autoIncrement`).

Because `scopeId` is stored in **`sessionStorage`**, durability is
**within-session**: persisted data survives reloads in the same tab, but is lost
when the tab closes (a new tab gets a new scope, hence a fresh journal db).

SQLite temp files (`.sqlite-journal`, `.sqlite-wal`, `.sqlite-shm`) are
explicitly **skipped** when journaling — they are created and deleted inside a
single transaction and would cause hydration failures if journaled.

### replayResilient — never brick boot on one bad op

On boot, saved ops are replayed onto the fresh MEMFS via the
`replayResilient(rawPhp, ops)` helper:

```js
function replayResilient(rawPhp, ops) {
  if (!ops || ops.length === 0) return;
  try {
    replayFSJournal(rawPhp, ops);          // fast path: whole batch at once
  } catch {
    for (const op of ops) {                 // slow path: op-by-op
      try { replayFSJournal(rawPhp, [op]); }
      catch { /* skip un-appliable op */ }
    }
  }
}
```

Why: a journaled op can become un-appliable against a clean FS when its
prerequisite state was never journaled — e.g. an `unlink` of a file whose CREATE
wasn't recorded leaves a dangling delete that throws. The fast path replays the
whole batch; on any throw it falls back to op-by-op and skips the failing ones (a
failed `unlink` just means the file is already absent — the intended end state).
This guarantees **a single bad op never bricks the reload.**

### Reset

`?clean=1` on the remote URL, or the **Reset Playground** button
(`#reset-button` in the shell), triggers a clean boot. The shell sets
`pendingCleanBoot` → `updateFrame()` appends `clean=1` → the worker boots with
`forceCleanBoot`, which calls `clearJournal(scopeId)` **and**
`clearOpcacheJournal(phpVersion)` (see `src/runtime/php-loader.js`) instead of
`initFsPersistence()`. Reset also clears the scope's sessionStorage state.

### Key lesson (general)

Persist **data, not derived caches**, and a persistence replay must **never**
brick boot on one bad op — hence `replayResilient`. (OPcache is journaled
separately, keyed by PHP version, precisely because it is a derived cache that is
safe to drop.)

---

## Plugins via ZipArchive

FacturaScripts plugins are installed **PHP-side**, the memory-safe native way —
not by JS-decompressing into MEMFS. `src/runtime/addons.js` writes the plugin ZIP
bytes to the WASM FS, then runs PHP that calls:

```php
$zip = new ZipArchive();
$zip->open($zipPath);
// ...
Plugins::add($zipPath, basename($zipPath), true);   // install
Plugins::enable($resolvedName);                       // activate
```

Because plugin install already used `Plugins::add` → `ZipArchive` (native,
streaming, memory-safe), it was **already correct and was left untouched** by the
Wave 1 core-extraction work that moved the readonly core to a native extraction
path. Do not "optimize" plugin install into JS-side unzipping.

Plugin operations are PHP-CPU-bound (~20s for `Plugins::deploy` +
`initControllers`), not network-bound. See `CHANGELOG-TECHNICAL.md`.

---

## Admin credentials

Defined in `playground.config.json` → `admin`:

```json
"admin": { "username": "admin", "password": "admin", "email": "admin@example.com" }
```

So the login is **`admin` / `admin`** (not `admin`/`password`). With
`"autologin": true`, the playground keeps an admin session, so you usually land
logged in.

---

## Debugging recipes (page-console snippets)

Run these in the **page console** (the shell tab). To inspect the SQLite/journal
you typically want the same origin that owns the IndexedDB dbs.

**List all IndexedDB databases:**

```js
await indexedDB.databases();
// look for:  facturascripts-fs-journal:<scope>  and  facturascripts-opcache:<phpVersion>
```

**Read the persisted FS journal ops for the active scope:**

```js
const scope = sessionStorage.getItem("facturascripts-playground:active"); // active scopeId
const db = await new Promise((res, rej) => {
  const r = indexedDB.open(`facturascripts-fs-journal:${scope}`);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const ops = await new Promise((res, rej) => {
  const r = db.transaction("ops", "readonly").objectStore("ops").getAll();
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
console.log(ops.length, ops.slice(0, 5));
```

(Confirm the active-scope key with `Object.keys(sessionStorage)` — the prefix is
`facturascripts-playground:`.)

**Inspect the OPcache journal (keyed by PHP version, e.g. `8.3`):**

```js
indexedDB.open("facturascripts-opcache:8.3");  // then read the "ops" store the same way
```

**Force a clean boot from the URL (skips replay, clears both journals):**

Append `?clean=1` to the remote frame URL, or just click **Reset Playground**
(`#reset-button`).

**Wipe everything for a truly fresh boot:**

```js
for (const { name } of await indexedDB.databases()) indexedDB.deleteDatabase(name);
sessionStorage.clear();
const regs = await navigator.serviceWorker.getRegistrations();
for (const r of regs) await r.unregister();
location.reload();
```

**Capture phpinfo / PHP diagnostics:** open the side panel
(`#panel-toggle-button`) → PHP Info tab (`#phpinfo-tab`); under the hood the
shell posts `{ kind: "capture-phpinfo" }` to the worker.

**Watch boot progress / errors:** the worker posts `progress` / `error` /
`ready` messages on a `BroadcastChannel` (names from `src/shared/protocol.js`).
The remote host page surfaces them in the overlay.

Tip: curl/network errors inside WASM do **not** go through `globalThis.fetch`, so
DevTools "Network" and JS fetch blockers won't show them. Use PHP-side logging /
the worker's error messages instead (see the `wasm-network-error` path in
`php-worker.js`).

---

## Build & test

```bash
make deps        # npm install
make prepare     # sync-browser-deps + build-worker + prepare-runtime
make bundle      # build the readonly FacturaScripts bundle (+ prepare)
make lint        # Biome check  — must pass clean
make format      # Biome check --fix (auto-fix + formatting)
make test        # unit tests:  node --test tests/*.test.mjs
make test-e2e    # Playwright browser suite (npm run test:e2e)
```

- **Biome auto-wraps long lines** and reformats; match its formatting (run
  `make format` before committing so the diff is what CI expects).
- Worker bundle: `npm run build-worker` (`scripts/esbuild.worker.mjs`) → emits
  `dist/php-worker.bundle.js`.
- **Confirm a change actually reached the bundle:**

  ```bash
  grep <token> dist/php-worker.bundle.js
  ```

  (esbuild bundles the worker, so editing `src/runtime/*` has no runtime effect
  until you rebuild.)
- Unit tests live in `tests/*.test.mjs`; Playwright specs in `tests/e2e/`
  (config: `playwright.config.mjs`, base URL `http://127.0.0.1:8085`, which the
  config boots via `PORT=8085 make up`/`serve`).

---

## CI gotchas

CI is GitHub Actions (`.github/workflows/ci.yml`, workflow name **Tests**).

- **Single `test` job runs everything.** Unlike omeka/moodle (which have a
  separate `e2e` job), FacturaScripts runs its **e2e *inside* the `test` job**:
  checkout → `npm install` → `node --check` syntax pass → `make test` →
  `make lint` → `mkdocs build --strict` → `npx playwright install` →
  `npm run test:e2e`. There is no standalone e2e job — keep it that way unless
  you intend to split it.
- **`make test` runs WITHOUT `sync-browser-deps`.** CI does not vendor browser
  deps, so `vendor/` is absent (it is gitignored). Therefore runtime code must
  import shared deps as **bare specifiers** — `import ... from "@php-wasm/web"`,
  `"@php-wasm/fs-journal"`, `"@php-wasm/universal"`, `"fflate"` — **never**
  `../vendor/...`. Bare specifiers resolve from `node_modules` in CI and get
  rewritten to `vendor/` only for the browser at sync time.
- **Never `git add -A`.** It would commit local `.claude/`, `.omc/`, and other
  workspace artifacts. Stage explicit files only (`git add <path>`).
- **CodeQL / least privilege:** the workflow declares `permissions: contents:
  read`. Preserve this; do not widen token permissions without reason.
- Docs build is part of CI (`mkdocs build --strict`) — broken Markdown links in
  `docs/`/`mkdocs.yml` fail the build.

---

## Common pitfalls (carry-over)

- `auto_prepend_file` must be at `/internal/shared/auto_prepend_file.php` — the
  only path @php-wasm reads. Writing elsewhere has no effect.
- `Plugins::deploy()` must be `(true, true)`; without `initControllers` the
  `pages` table stays empty and FK constraints on `users.homepage` fail.
- `opcache.file_cache_only` must be `1` in WASM (shared-memory OPcache needs
  COOP/COEP).
- The SW injects a `parent === window` override into every HTML response;
  FacturaScripts uses `parent.document.location` for row-click navigation. Don't
  remove it or iframe navigation breaks. The SW also rewrites `data-href`
  alongside `href`/`src`/`action`.
- `Cache::clear()` deletes ALL `.cache` files including the Forja cache; bootstrap
  patches `Cache.php` in MEMFS to exclude `forja_*` — otherwise plugin
  enable/disable triggers ~20s curl timeouts.
- Don't reintroduce boot-time copying of the entire core into persistent storage
  (readonly core stays in MEMFS; only `/persist` is journaled).

---

## Sibling projects

Same `@php-wasm` stack — useful for cross-referencing patterns:
Nextcloud, Moodle, Omeka-S playgrounds (Omeka-S is the original source of
`php-compat.js`, since adapted here). WordPress Playground is the upstream
architectural reference for `@php-wasm/web`.
