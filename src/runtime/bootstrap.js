import { buildEffectivePlaygroundConfig, normalizeBlueprint } from "../shared/config.js";
import { materializeBlueprintAddons } from "./addons.js";
import { buildManifestState, fetchManifest } from "./manifest.js";
import { mountReadonlyCore } from "./vfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PLAYGROUND_DB_PATH = "/persist/mutable/db/facturascripts.sqlite";
export const PLAYGROUND_CONFIG_PATH = "/persist/mutable/config/playground-state.json";
export const PLAYGROUND_PREPEND_PATH = "/config/playground-prepend.php";
export const FS_ROOT = "/www/facturascripts";

function buildConfigPhp(config) {
  return `<?php
define('FS_ROUTE', 'http://localhost');
define('FS_FOLDER', '${FS_ROOT}');
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
`;
}

function buildInstallScript() {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('FS_FOLDER', '${FS_ROOT}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';
use FacturaScripts\\Core\\Base\\DataBase;
use FacturaScripts\\Core\\Plugins;
$db = new DataBase();
$db->connect();
Plugins::deploy();
echo "INSTALL_OK";
`;
}

function buildWizardScript(config) {
  const adminPassword = config.admin?.password || "admin";
  const email = config.admin?.email || "admin@example.com";
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('FS_FOLDER', '${FS_ROOT}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';
use FacturaScripts\\Core\\Base\\DataBase;
use FacturaScripts\\Core\\Model\\User;
use FacturaScripts\\Core\\Model\\Country;
use FacturaScripts\\Core\\Model\\Currency;
use FacturaScripts\\Dinamic\\Model\\Empresa;

header('Content-Type: application/json');
$db = new DataBase();
$db->connect();

$user = new User();
if (!$user->loadFromCode('${config.admin?.username || "admin"}')) {
    $user->nick = '${config.admin?.username || "admin"}';
    $user->email = '${email}';
    $user->setPassword('${adminPassword}');
    $user->langcode = '${config.locale || "es_ES"}';
    $user->save();
} else {
    $user->email = '${email}';
    $user->setPassword('${adminPassword}');
    $user->langcode = '${config.locale || "es_ES"}';
    $user->save();
}

$countryCode = '${config.install?.codpais || "ESP"}';
$companyName = '${config.install?.empresa || "Mi Empresa"}';

$country = new Country();
if (!$country->loadFromCode($countryCode)) {
    $country->codpais = $countryCode;
    $country->nombre = 'País por defecto';
    $country->save();
}

$empresa = new Empresa();
if (!$empresa->loadFromCode('1')) {
    $empresa->codempresa = 1;
    $empresa->nombre = $companyName;
    $empresa->codpais = $countryCode;
    $empresa->save();
}

echo json_encode(['ok' => true]);
`;
}

async function ensureDir(php, dirPath) {
  const segments = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = await php.analyzePath(current);
    if (!about?.exists) {
      try { await php.mkdir(current); } catch {}
    }
  }
}

async function writePlaygroundState(php, state) {
  await php.writeFile(PLAYGROUND_CONFIG_PATH, encoder.encode(JSON.stringify(state, null, 2)));
}

async function readPlaygroundState(php) {
  const about = await php.analyzePath(PLAYGROUND_CONFIG_PATH);
  if (!about?.exists) return null;
  const raw = await php.readFile(PLAYGROUND_CONFIG_PATH);
  return JSON.parse(decoder.decode(raw));
}

function buildAutologinScript(username) {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('FS_FOLDER', '${FS_ROOT}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';
use FacturaScripts\\Core\\Model\\User;

header('Content-Type: application/json');
$user = new User();
if ($user->loadFromCode('${username}')) {
    $user->newLogkey('127.0.0.1', 'playground');
    $user->save();
    echo json_encode(['ok' => true, 'fsNick' => $user->nick, 'fsLogkey' => $user->logkey, 'fsLang' => $user->langcode]);
    return;
}
echo json_encode(['ok' => false, 'error' => 'user not found']);
`;
}

async function initAllModels(php) {
  const scriptPath = `${FS_ROOT}/_playground_init_models.php`;
  const script = `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('FS_FOLDER', '${FS_ROOT}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';
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
  const response = await php.request(new Request("http://localhost/_playground_init_models.php"));
  await response.text();
  try { await php.unlink(scriptPath); } catch {}
}

async function performAutologin(php, config, publish) {
  publish("Signing in admin user automatically.", 0.85);
  const scriptPath = `${FS_ROOT}/_playground_autologin.php`;
  await php.writeFile(scriptPath, encoder.encode(buildAutologinScript(config.admin.username)));
  const response = await php.request(new Request("http://localhost/_playground_autologin.php"));
  const text = await response.text();
  try { await php.unlink(scriptPath); } catch {}

  try {
    const result = JSON.parse(text);
    if (!result.ok) { return { ok: false, warning: `Autologin failed: ${result.error}` }; }
    return { ok: true };
  } catch (_err) {
    return { ok: false, warning: `Autologin script returned unexpected output: ${text.substring(0, 200)}` };
  }
}

export async function bootstrapFacturaScripts({ config: rawConfig, blueprint: rawBlueprint, clean, php, publish, runtimeId }) {
  const blueprint = rawBlueprint ? normalizeBlueprint(rawBlueprint, rawConfig) : normalizeBlueprint({}, rawConfig);
  const config = buildEffectivePlaygroundConfig(rawConfig, blueprint);

  publish("Loading FacturaScripts manifest.", 0.2);
  const manifest = await fetchManifest();
  const manifestState = buildManifestState(manifest, runtimeId, rawConfig.bundleVersion);

  const existingState = await readPlaygroundState(php);
  const manifestVersion = `${manifestState.release || ""}:${manifestState.sha256 || ""}`;
  const versionMatch = existingState?.manifestVersion === manifestVersion;
  const skipInstall = versionMatch && !clean;

  if (!skipInstall && (clean || (existingState && !versionMatch && rawConfig.resetOnVersionMismatch))) {
    publish("Cleaning previous state.", 0.22);
    for (const path of [PLAYGROUND_DB_PATH, PLAYGROUND_CONFIG_PATH]) {
      const about = await php.analyzePath(path);
      if (about?.exists) {
        try { await php.unlink(path); } catch {}
      }
    }
  }

  publish("Mounting FacturaScripts readonly core.", 0.25);
  await mountReadonlyCore(php, manifest, { root: FS_ROOT, publish });

  publish("Creating mutable directory layout.", 0.4);
  const mutableDirs = [
    "/persist/mutable/db", "/persist/mutable/config", "/persist/mutable/session",
    `${FS_ROOT}/MyFiles`, `${FS_ROOT}/MyFiles/Log`, `${FS_ROOT}/Dinamic`,
    `${FS_ROOT}/Dinamic/Assets`, `${FS_ROOT}/Dinamic/Assets/CSS`, `${FS_ROOT}/Dinamic/Assets/JS`,
    `${FS_ROOT}/Dinamic/Assets/Images`, `${FS_ROOT}/Dinamic/Controller`, `${FS_ROOT}/Dinamic/Lib`,
    `${FS_ROOT}/Dinamic/Model`, `${FS_ROOT}/Dinamic/Table`, `${FS_ROOT}/Dinamic/View`,
    `${FS_ROOT}/Dinamic/XMLView`, `${FS_ROOT}/Plugins`,
  ];
  for (const dir of mutableDirs) { await ensureDir(php, dir); }

  publish("Writing config.php.", 0.45);
  await php.writeFile(`${FS_ROOT}/config.php`, encoder.encode(buildConfigPhp(config)));

  publish("Writing PHP prepend file.", 0.48);
  await php.writeFile(PLAYGROUND_PREPEND_PATH, encoder.encode(buildPhpPrepend()));

  const phpIniContent = [
    `auto_prepend_file = ${PLAYGROUND_PREPEND_PATH}`,
    `session.save_path = /persist/mutable/session`,
    `date.timezone = ${config.timezone}`,
    `memory_limit = 256M`,
    `max_execution_time = 0`,
    `display_errors = ${config.debug?.enabled ? "On" : "Off"}`,
    `error_reporting = E_ALL`,
    ""
  ].join("\n");
  await php.writeFile("/php.ini", encoder.encode(phpIniContent));

  publish("Running FacturaScripts deploy (compiling views and assets).", 0.55);
  const installScriptPath = `${FS_ROOT}/_playground_install.php`;
  await php.writeFile(installScriptPath, encoder.encode(buildInstallScript()));
  const installResponse = await php.request(new Request("http://localhost/_playground_install.php"));
  const installText = await installResponse.text();
  try { await php.unlink(installScriptPath); } catch {}
  if (!installText.includes("INSTALL_OK")) { throw new Error(`FacturaScripts deploy failed:\n${installText}`); }

  if (!skipInstall) {
    publish("Triggering first-run setup.", 0.65);
    const firstRunResponse = await php.request(new Request("http://localhost/"));
    const firstRunStatus = firstRunResponse.status;
    if (firstRunStatus >= 500) {
      const body = await firstRunResponse.text();
      throw new Error(`First-run request returned ${firstRunStatus}:\n${body}`);
    }

    publish("Initializing company, taxes, and base data.", 0.72);
    const wizardScriptPath = `${FS_ROOT}/_playground_wizard.php`;
    await php.writeFile(wizardScriptPath, encoder.encode(buildWizardScript(config)));
    const wizardResponse = await php.request(new Request("http://localhost/_playground_wizard.php"));
    const wizardText = await wizardResponse.text();
    try { await php.unlink(wizardScriptPath); } catch {}

    try {
      const wizardResult = JSON.parse(wizardText);
      if (!wizardResult.ok) { throw new Error(`Wizard initialization failed: ${wizardText}`); }
    } catch (err) {
      if (err instanceof SyntaxError) { throw new Error(`Wizard script returned unexpected output:\n${wizardText.substring(0, 500)}`); }
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
    publish("Persistent database matches current version. Skipping table creation.", 0.7);
  }

  await materializeBlueprintAddons({ php, blueprint, fsRoot: FS_ROOT, publish, config, manifestVersion });

  publish("Verifying all database tables.", 0.88);
  await initAllModels(php);

  const readyPath = blueprint.landingPage || config.landingPath || "/";

  if (config.autologin) {
    const autologin = await performAutologin(php, config, publish);
    if (autologin.ok) { publish("Autologin successful.", 0.9); }
    else if (autologin.warning) { publish(`[warning] ${autologin.warning}`, 0.92); }
  }

  publish("FacturaScripts is ready.", 0.95);
  return { readyPath };
}
