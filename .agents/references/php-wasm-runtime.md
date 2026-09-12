# FacturaScripts runtime reference

Local details for the shared PHP-WASM and browser-runtime skills. Keep this file
outside installed skill directories; read the section needed for the task.

## PHP integration

- The loader and adapter are src/runtime/php-loader.js and php-compat.js.
  Autologin uses the HTTP path so fsNick/fsLogkey cookies reach the JS cookie jar.
- Preserve Plugins::deploy(true, true), which populates pages, and wizard ordering:
  company/warehouse/defaults must exist before saving the admin user.
- Intl is deliberately disabled. opcache.file_cache_only stays 1; the current
  deployment does not rely on shared-memory OPcache or require ICU.
- /internal/shared/auto_prepend_file.php reseeds Forja cache files before requests.
  Keep the Cache.php protection that prevents deleting forja_* entries. PHP curl
  is not blocked by JS fetch interception; removing either protection causes
  update timeouts. See the relevant [technical-log entries](../../CHANGELOG-TECHNICAL.md).
- Preserve the SW parent override and data-href rewriting for clickable rows:
  FacturaScripts otherwise uses parent.document.location outside the app frame.
- Plugin ZIPs use PHP ZipArchive and Plugins::add/enable; use Dinamic models for
  application behavior. Details: [facturascripts-internals](../skills/facturascripts-internals/SKILL.md).

## Storage and recovery

- Core streams from tar.zst into /www/facturascripts; ZIP is only for plugins.
  Keep Dinamic, MyFiles, and Plugins writable. See
  [bundle design](../../docs/streaming-tar-zst-core-bundle.md).
- `facturascripts-fs-journal:<scope>` persists mutable state; SQLite remains
  /persist/mutable/db/facturascripts.sqlite with foreign keys enabled.
- OPcache is separately journaled by PHP version **and exact core bundle SHA-256**.
  See buildOpcacheKey in php-loader.js and opcacheDatabaseName in fs-persistence.js.
  Never reduce this to Nextcloud's PHP-version-only key. Clean boot clears the
  scope journal and the selected OPcache journal, then reinitializes journaling.
- Preserve blueprint materialization fingerprints and idempotent settings/seeds.
  Reload should not unnecessarily reinstall plugins or reset user edits.
- Read php-worker.js and src/runtime/crash-recovery.js for checkpoint coverage,
  failure fallback, and restart limits; keep coherent DB/file snapshots and safe
  request replay. Do not borrow Moodle's filedir or cache-exclusion rules.
