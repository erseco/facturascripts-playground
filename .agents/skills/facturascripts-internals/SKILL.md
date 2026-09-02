---
name: facturascripts-internals
description: FacturaScripts domain expert for this php-wasm playground. Use when changing installation and deploy, SQLite integration, plugins, Dinamic models and controllers, companies or users, settings, caches, or FacturaScripts-specific blueprint provisioning.
metadata:
  author: facturascripts-playground
  version: "1.0"
---

# FacturaScripts Internals

Use FacturaScripts' own APIs and lifecycle while preserving the browser/WASM workarounds proven here. Read `CHANGELOG-TECHNICAL.md` before changing runtime behavior; then inspect `src/runtime/bootstrap.js`, `src/runtime/wizard-script.js`, `src/runtime/addons.js`, and the relevant current source.

## Core source and database

- Core lives at `/www/facturascripts`; mutable DB/config/session state lives under `/persist/mutable`. Writable application trees are `Dinamic`, `MyFiles`, and `Plugins`.
- SQLite support comes from the fork branches, not a build-time patch: `feature/add-sqlite-support` for dev and generated `feature/add-sqlite-support-stable` for stable. Never commit manually to the generated stable branch.
- `config.php` must keep `FS_DB_TYPE = sqlite`, `FS_DB_NAME = /persist/mutable/db/facturascripts.sqlite`, foreign keys enabled, and core/addon updates disabled inside the readonly playground.
- Connect through `FacturaScripts\Core\Base\DataBase` after loading `config.php` and `vendor/autoload.php`. Never replace the file DB with `:memory:`; PHP state and PDO connections end after each request.
- Preserve the readonly-core/mutable-overlay split and the OPcache namespace keyed by PHP version plus exact bundle SHA-256.

## Install and deploy lifecycle

- First deploy must call `Plugins::deploy(true, true)`. The second `true` initializes controllers and populates `pages`; plain `deploy()` leaves `users.homepage` pointing at missing rows and breaks user saves/autologin.
- The wizard order is constrained by foreign keys: load country defaults and core model seeds, create company and warehouse, store defaults, create series/exercise/accounting plan, then create or update the admin user.
- Instantiate required `FacturaScripts\Dinamic\Model` classes before expecting their CSV seed data or generated tables.
- Save defaults through `Tools::settingsSet()` and finish with `Tools::settingsSave()`.
- Create the admin only after company/warehouse defaults exist. Set its `homepage` to `Dashboard`, plus company, warehouse, series, language, and password.
- Autologin uses `User::newLogkey()` and the `fsNick`/`fsLogkey` cookies. Run it through `php.request()` so the JS cookie jar captures `Set-Cookie`; do not rely on PHP memory between requests.

## Models, settings, and plugins

- Runtime classes are under `FacturaScripts\Dinamic`, because deploy composes core and plugin overrides there. Use Dinamic models for application behavior; use Core classes for infrastructure such as `DataBase`, `Plugins`, `Tools`, and `Cache`.
- Prefer model methods (`loadFromCode`, `findWhereEq`, `save`, `primaryColumnValue`) over direct SQL so validation, defaults, and plugin overrides run.
- Make blueprint seeds idempotent using a stable business key: customer `codcliente`, supplier `codproveedor`, product `referencia`, or an explicitly validated `_unique` field.
- Blueprint settings are grouped scalars. Apply them after plugins and seed data with `Tools::settingsSet(group, key, value)` followed by one `Tools::settingsSave()`.
- Plugin ZIPs are installed PHP-side with `ZipArchive` and `Plugins::add()`, then enabled with `Plugins::enable()`. Resolve the plugin name from `facturascripts.ini` when it is absent from the blueprint.
- A plugin operation may take about 20 seconds because enabling rebuilds controllers; do not misdiagnose that known synchronous WASM cost as a network hang.
- When plugin or settings blueprint semantics change, update schema, normalizer, materialization fingerprint, docs, and tests together.

## Cache and networking invariants

- The real php-wasm curl extension does not pass through `globalThis.fetch`; JS fetch interception cannot block or mock it.
- FacturaScripts' Forja update calls are deliberately neutralized because core is readonly. `/internal/shared/auto_prepend_file.php` rewrites `forja_builds.cache` and `forja_plugins.cache` to serialized empty arrays before every request.
- Keep the prepend at exactly `/internal/shared/auto_prepend_file.php`; php-wasm does not read an arbitrary project `php.ini` path.
- Keep the MEMFS `Cache.php` protection that prevents `Cache::clear()` from deleting `forja_*`. Removing either protection reintroduces timeouts or malformed Forja responses.
- Intl is intentionally disabled; FacturaScripts does not require it and ICU adds substantial download size.
- `opcache.file_cache_only` must remain `1` because shared-memory OPcache depends on COOP/COEP headers that static deployments may not provide.

## Browser/WASM behavior

- No application state survives in PHP globals between requests. Durable session state is files, SQLite, cookies, and the IndexedDB filesystem journal.
- FacturaScripts expects top-window navigation and uses `parent.document.location` for clickable rows. Preserve the service-worker `parent === window` override and rewriting of `data-href` as well as `href`, `src`, and `action`.
- Reset/clean boot clears both the per-scope mutable journal and the bundle-specific OPcache journal.
- Keep `Dinamic`, `MyFiles`, and `Plugins` writable; do not copy the entire readonly core into persistence.
- Source patches and compatibility edits must be gated to the WASM/playground need and retained in build/runtime code, not hidden in generated bundles.

## Verification

- [ ] `Plugins::deploy(true, true)` completes and the `pages` table supports the admin homepage.
- [ ] Wizard creates company/warehouse/defaults before the admin user and remains idempotent.
- [ ] Models use `FacturaScripts\Dinamic` and seed records upsert by stable keys.
- [ ] Plugin add/enable and settings changes survive a reload without rerunning unnecessarily.
- [ ] Forja caches are reseeded by the prepend and survive `Cache::clear()`.
- [ ] SQLite remains `/persist/mutable/db/facturascripts.sqlite` with foreign keys enabled.
- [ ] Clickable rows navigate inside the scoped runtime rather than replacing the host iframe.
- [ ] Clean boot, reload, autologin, and the selected stable/dev bundle work in a real browser.
