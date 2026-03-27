import {
  buildEffectivePlaygroundConfig,
  normalizeBlueprint,
} from "../shared/config.js";
import { materializeBlueprintAddons } from "./addons.js";
import {
  FS_ROOT,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_DB_PATH,
  PLAYGROUND_PREPEND_PATH,
} from "./bootstrap-paths.js";
import { buildManifestState, fetchManifest } from "./manifest.js";
import { mountReadonlyCore } from "./vfs.js";
import { buildWizardScript } from "./wizard-script.js";

export {
  buildWizardScript,
  FS_ROOT,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_DB_PATH,
  PLAYGROUND_PREPEND_PATH,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function buildConfigPhp(config) {
  return `<?php
defined('FS_ROUTE') || define('FS_ROUTE', '');
defined('FS_FOLDER') || define('FS_FOLDER', '${FS_ROOT}');
define('FS_DB_TYPE', 'sqlite');
define('FS_DB_HOST', '');
define('FS_DB_PORT', 0);
define('FS_DB_NAME', '${PLAYGROUND_DB_PATH}');
define('FS_DB_USER', '');
define('FS_DB_PASS', '');
define('FS_DB_FOREIGN_KEYS', true);
define('FS_DB_TYPE_CHECK', true);
define('FS_SESSION_TIMEOUT', 86400); // 24 hours
define('FS_DISABLE_ADDONS_UPDATE', true);
define('FS_DISABLE_CORE_UPDATE', true);
define('FS_LANG', '${config.locale || "es_ES"}');
define('FS_DEBUG', false);
define('FS_DISABLE_ADD_PLUGINS', false);
define('FS_DISABLE_RM_PLUGINS', false);
`;
}

function buildPhpPrepend() {
  return `<?php
if (!file_exists('${PLAYGROUND_DB_PATH}')) {
    $dir = dirname('${PLAYGROUND_DB_PATH}');
    if (!is_dir($dir)) { mkdir($dir, 0777, true); }
    touch('${PLAYGROUND_DB_PATH}');
}
$_SERVER['SERVER_PORT'] = 80;
if (empty($_SERVER['DOCUMENT_ROOT'])) { $_SERVER['DOCUMENT_ROOT'] = '${FS_ROOT}'; }
if (empty($_SERVER['SCRIPT_FILENAME'])) { $_SERVER['SCRIPT_FILENAME'] = $_SERVER['DOCUMENT_ROOT'] . '/index.php'; }

// Keep Forja remote-API cache files fresh so FacturaScripts never blocks on
// a curl call to facturascripts.com (10 s timeout). Cache::get() expires at
// 3600 s, so refresh at 3500 s to always have a valid entry.
$_pgForjaDir = '${FS_ROOT}/MyFiles/Tmp/FileCache';
if (!is_dir($_pgForjaDir)) { @mkdir($_pgForjaDir, 0777, true); }
foreach (['forja_builds', 'forja_plugins'] as $_pgKey) {
    $_pgFile = $_pgForjaDir . '/' . $_pgKey . '.cache';
    if (!file_exists($_pgFile) || filemtime($_pgFile) < time() - 3500) {
        file_put_contents($_pgFile, 'a:0:{}');
    }
}
unset($_pgForjaDir, $_pgKey, $_pgFile);
`;
}

function buildInstallScript() {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '${FS_ROOT}/config.php';
require_once '${FS_ROOT}/vendor/autoload.php';
use FacturaScripts\\Core\\Base\\DataBase;
use FacturaScripts\\Core\\Plugins;
$db = new DataBase();
$db->connect();
Plugins::deploy(true, true);
echo "INSTALL_OK";
`;
}

// buildWizardScript lives in ./wizard-script.js and is re-exported above.

async function ensureDir(php, dirPath) {
  const segments = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = await php.analyzePath(current);
    if (!about?.exists) {
      try {
        await php.mkdir(current);
      } catch {}
    }
  }
}

async function writePlaygroundState(php, state) {
  await php.writeFile(
    PLAYGROUND_CONFIG_PATH,
    encoder.encode(JSON.stringify(state, null, 2)),
  );
}

async function readPlaygroundState(php) {
  const about = await php.analyzePath(PLAYGROUND_CONFIG_PATH);
  if (!about?.exists) return null;
  const raw = await php.readFile(PLAYGROUND_CONFIG_PATH);
  return JSON.parse(decoder.decode(raw));
}

function buildAutologinScript(username) {
  return `<?php
ob_start();
error_reporting(0);
require_once '${FS_ROOT}/config.php';
require_once '${FS_ROOT}/vendor/autoload.php';
use FacturaScripts\\Core\\Model\\User;
ob_clean();
header('Content-Type: application/json');

$user = new User();
if (!$user->loadFromCode('${username}')) {
    echo json_encode(['ok' => false, 'error' => 'user not found']);
    exit;
}
$user->newLogkey('127.0.0.1', 'playground');
$logkey = $user->logkey;
$nick = $user->nick;

if (!$user->save()) {
    echo json_encode(['ok' => false, 'error' => 'user save failed']);
    exit;
}

setcookie('fsNick', $nick, 0, '/');
setcookie('fsLogkey', $logkey, 0, '/');
echo json_encode(['ok' => true, 'nick' => $nick, 'logkey' => $logkey]);
`;
}

async function initAllModels(php) {
  const scriptPath = `${FS_ROOT}/_playground_init_models.php`;
  const script = `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '${FS_ROOT}/config.php';
require_once '${FS_ROOT}/vendor/autoload.php';
use FacturaScripts\\Core\\Tools;

header('Content-Type: application/json');
$modelsFolder = Tools::folder('Dinamic', 'Model');
$loaded = 0;
foreach (Tools::folderScan($modelsFolder) as $fileName) {
    if ('.php' !== substr($fileName, -4)) { continue; }
    $className = 'FacturaScripts\\\\Dinamic\\\\Model\\\\' . substr($fileName, 0, -4);
    try { new $className(); $loaded++; } catch (\\Throwable $e) {}
}
echo json_encode(['ok' => true, 'models' => $loaded]);
`;
  await php.writeFile(scriptPath, encoder.encode(script));
  const response = await php.request(
    new Request("http://localhost/_playground_init_models.php"),
  );
  await response.text();
  try {
    await php.unlink(scriptPath);
  } catch {}
}

// Runs a PHP script via php.request() so wrapPhpInstance captures the
// Set-Cookie headers in its internal cookie jar. All subsequent PHP requests
// from the iframe (via SW→PHP bridge) will have HTTP_COOKIE injected.
async function performAutologin(php, config, publish) {
  publish("Signing in admin user automatically.", 0.85);
  const scriptPath = `${FS_ROOT}/_playground_autologin.php`;
  await php.writeFile(
    scriptPath,
    encoder.encode(buildAutologinScript(config.admin.username)),
  );
  const response = await php.request(
    new Request("http://localhost/_playground_autologin.php"),
  );
  const text = await response.text();
  try {
    await php.unlink(scriptPath);
  } catch {}
  try {
    const result = JSON.parse(text);
    if (!result.ok) {
      return { ok: false, warning: `Autologin failed: ${result.error}` };
    }
    // Directly inject into the wrapPhpInstance cookie jar as a reliable
    // fallback alongside PHP's setcookie() Set-Cookie response headers.
    if (result.nick && result.logkey && php.setCookie) {
      php.setCookie("fsNick", result.nick);
      php.setCookie("fsLogkey", result.logkey);
    }
    return { ok: true };
  } catch (_err) {
    return {
      ok: false,
      warning: `Autologin script returned unexpected output: ${text.substring(0, 200)}`,
    };
  }
}

export async function bootstrapFacturaScripts({
  config: rawConfig,
  blueprint: rawBlueprint,
  clean,
  php,
  publish,
  runtimeId,
}) {
  const blueprint = rawBlueprint
    ? normalizeBlueprint(rawBlueprint, rawConfig)
    : normalizeBlueprint({}, rawConfig);
  const config = buildEffectivePlaygroundConfig(rawConfig, blueprint);

  publish("Loading FacturaScripts manifest.", 0.2);
  const manifest = await fetchManifest();
  const manifestState = buildManifestState(
    manifest,
    runtimeId,
    rawConfig.bundleVersion,
  );

  const existingState = await readPlaygroundState(php);
  const manifestVersion = `${manifestState.release || ""}:${manifestState.sha256 || ""}`;
  const versionMatch = existingState?.manifestVersion === manifestVersion;
  const skipInstall = versionMatch && !clean;

  if (
    !skipInstall &&
    (clean ||
      (existingState && !versionMatch && rawConfig.resetOnVersionMismatch))
  ) {
    publish("Cleaning previous state.", 0.22);
    for (const path of [PLAYGROUND_DB_PATH, PLAYGROUND_CONFIG_PATH]) {
      const about = await php.analyzePath(path);
      if (about?.exists) {
        try {
          await php.unlink(path);
        } catch {}
      }
    }
  }

  publish("Mounting FacturaScripts readonly core.", 0.25);
  await mountReadonlyCore(php, manifest, { root: FS_ROOT, publish });

  publish("Creating mutable directory layout.", 0.4);
  const mutableDirs = [
    "/persist/mutable/db",
    "/persist/mutable/config",
    "/persist/mutable/session",
    `${FS_ROOT}/MyFiles`,
    `${FS_ROOT}/MyFiles/Log`,
    `${FS_ROOT}/MyFiles/Tmp`,
    `${FS_ROOT}/MyFiles/Tmp/FileCache`,
    `${FS_ROOT}/Dinamic`,
    `${FS_ROOT}/Dinamic/Assets`,
    `${FS_ROOT}/Dinamic/Assets/CSS`,
    `${FS_ROOT}/Dinamic/Assets/JS`,
    `${FS_ROOT}/Dinamic/Assets/Images`,
    `${FS_ROOT}/Dinamic/Controller`,
    `${FS_ROOT}/Dinamic/Lib`,
    `${FS_ROOT}/Dinamic/Model`,
    `${FS_ROOT}/Dinamic/Table`,
    `${FS_ROOT}/Dinamic/View`,
    `${FS_ROOT}/Dinamic/XMLView`,
    `${FS_ROOT}/Plugins`,
  ];
  for (const dir of mutableDirs) {
    await ensureDir(php, dir);
  }

  // Pre-populate Forja cache so FacturaScripts never triggers slow curl calls
  // to facturascripts.com. Cache::remember() returns this data immediately.
  const emptySerializedArray = encoder.encode("a:0:{}");
  for (const key of ["forja_builds", "forja_plugins"]) {
    await php.writeFile(
      `${FS_ROOT}/MyFiles/Tmp/FileCache/${key}.cache`,
      emptySerializedArray,
    );
  }

  // Patch Cache::clear() to preserve Forja cache files. Without this,
  // enablePluginAction/disablePluginAction call Cache::clear() which deletes
  // forja_builds.cache and forja_plugins.cache. The next Forja call in the
  // same request then triggers a 10s curl timeout to facturascripts.com.
  try {
    const cachePath = `${FS_ROOT}/Core/Cache.php`;
    const cacheRaw = decoder.decode(await php.readFile(cachePath));
    const patched = cacheRaw.replace(
      "if (str_ends_with($fileName, '.cache')) {",
      "if (str_ends_with($fileName, '.cache') && !str_starts_with($fileName, 'forja_')) {",
    );
    if (patched !== cacheRaw) {
      await php.writeFile(cachePath, encoder.encode(patched));
    }
  } catch {}

  // Patch Dashboard controller to disable outbound HTTP calls.
  // Dashboard::privateCore() calls Telemetry::init()->ready() and
  // Forja::canUpdateCore() which use PHP's real curl extension.  In
  // Firefox/Safari, Emscripten's networking layer cannot reach
  // facturascripts.com and crashes with EHOSTUNREACH (errno 23 in
  // Emscripten — previously misidentified as ENFILE).
  // Also disable loadNews() which fetches the changelog via Http::get().
  try {
    const dashPath = `${FS_ROOT}/Core/Controller/Dashboard.php`;
    const dashOriginal = decoder.decode(await php.readFile(dashPath));
    const dashRaw = dashOriginal
      .replace(
        "$this->registered = Telemetry::init()->ready();",
        "$this->registered = false;",
      )
      .replace(
        "$this->updated = Forja::canUpdateCore() === false;",
        "$this->updated = true;",
      )
      .replace(
        "return Http::get('https://facturascripts.com/comm3/index.php?page=community_changelog&json=TRUE')\n                ->setTimeout(5)\n                ->json() ?? [];",
        "return [];",
      );
    if (dashRaw !== dashOriginal) {
      await php.writeFile(dashPath, encoder.encode(dashRaw));
    }
  } catch {}

  publish("Writing config.php.", 0.45);
  await php.writeFile(
    `${FS_ROOT}/config.php`,
    encoder.encode(buildConfigPhp(config)),
  );

  publish("Writing PHP prepend file.", 0.48);
  await php.writeFile(
    PLAYGROUND_PREPEND_PATH,
    encoder.encode(buildPhpPrepend()),
  );

  const phpIniContent = [
    `auto_prepend_file = ${PLAYGROUND_PREPEND_PATH}`,
    `session.save_path = /persist/mutable/session`,
    `date.timezone = ${config.timezone}`,
    `memory_limit = 256M`,
    `max_execution_time = 0`,
    `display_errors = ${config.debug?.enabled ? "On" : "Off"}`,
    `error_reporting = E_ALL`,
    "",
  ].join("\n");
  await php.writeFile("/php.ini", encoder.encode(phpIniContent));

  publish("Running FacturaScripts deploy (compiling views and assets).", 0.55);
  const installScriptPath = `${FS_ROOT}/_playground_install.php`;
  await php.writeFile(installScriptPath, encoder.encode(buildInstallScript()));
  const installResponse = await php.request(
    new Request("http://localhost/_playground_install.php"),
  );
  const installText = await installResponse.text();
  try {
    await php.unlink(installScriptPath);
  } catch {}
  if (!installText.includes("INSTALL_OK")) {
    throw new Error(`FacturaScripts deploy failed:\n${installText}`);
  }

  if (!skipInstall) {
    publish("Triggering first-run setup.", 0.65);
    const firstRunResponse = await php.request(
      new Request("http://localhost/"),
    );
    const firstRunStatus = firstRunResponse.status;
    if (firstRunStatus >= 500) {
      const body = await firstRunResponse.text();
      throw new Error(`First-run request returned ${firstRunStatus}:\n${body}`);
    }

    publish("Initializing company, taxes, and base data.", 0.72);
    const wizardScriptPath = `${FS_ROOT}/_playground_wizard.php`;
    await php.writeFile(
      wizardScriptPath,
      encoder.encode(buildWizardScript(config)),
    );
    const wizardResponse = await php.request(
      new Request("http://localhost/_playground_wizard.php"),
    );
    const wizardText = await wizardResponse.text();
    try {
      await php.unlink(wizardScriptPath);
    } catch {}

    try {
      const wizardResult = JSON.parse(wizardText);
      if (!wizardResult.ok) {
        throw new Error(`Wizard initialization failed: ${wizardText}`);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(
          `Wizard script returned unexpected output:\n${wizardText.substring(0, 500)}`,
        );
      }
      throw err;
    }

    publish("Saving playground state.", 0.85);
    await writePlaygroundState(php, {
      manifestVersion,
      runtimeId,
      installedAt: new Date().toISOString(),
      admin: { username: config.admin.username },
    });
  } else {
    publish(
      "Persistent database matches current version. Skipping table creation.",
      0.7,
    );
  }

  await materializeBlueprintAddons({
    php,
    blueprint,
    fsRoot: FS_ROOT,
    publish,
    config,
    manifestVersion,
  });

  publish("Verifying all database tables.", 0.88);
  await initAllModels(php);

  const readyPath = blueprint.landingPage || config.landingPath || "/";

  if (config.autologin) {
    const autologin = await performAutologin(php, config, publish);
    if (autologin.ok) {
      publish("Autologin successful.", 0.9);
    } else if (autologin.warning) {
      publish(`[warning] ${autologin.warning}`, 0.92);
    }
  }

  publish("FacturaScripts is ready.", 0.95);
  return { readyPath };
}
