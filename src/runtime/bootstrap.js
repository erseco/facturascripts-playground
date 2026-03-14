import {
  buildEffectivePlaygroundConfig,
  normalizeBlueprint,
} from "../shared/blueprint.js";
import { materializeBlueprintAddons } from "./addons.js";
import { buildManifestState, fetchManifest } from "./manifest.js";
import { mountReadonlyCore } from "./vfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PLAYGROUND_DB_PATH = "/persist/mutable/db/facturascripts.sqlite";
export const PLAYGROUND_CONFIG_PATH =
  "/persist/mutable/config/playground-state.json";
export const PLAYGROUND_PREPEND_PATH = "/config/playground-prepend.php";
export const FS_ROOT = "/www/facturascripts";

function phpString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function phpBoolean(value) {
  return value ? "true" : "false";
}

function buildConfigPhp(config) {
  const debugEnabled = config.debug?.enabled === true;

  return `<?php
define('FS_COOKIES_EXPIRE', 31536000);
define('FS_ROUTE', '');
define('FS_DB_TYPE', 'sqlite');
define('FS_DB_HOST', '');
define('FS_DB_PORT', 0);
define('FS_DB_NAME', '${phpString(PLAYGROUND_DB_PATH)}');
define('FS_DB_USER', '');
define('FS_DB_PASS', '');
define('FS_DB_FOREIGN_KEYS', true);
define('FS_DB_TYPE_CHECK', true);
define('FS_LANG', '${phpString(config.locale)}');
define('FS_TIMEZONE', '${phpString(config.timezone)}');
define('FS_HIDDEN_PLUGINS', '');
define('FS_DEBUG', ${phpBoolean(debugEnabled)});
define('FS_DISABLE_ADD_PLUGINS', false);
define('FS_DISABLE_RM_PLUGINS', false);
define('FS_INITIAL_USER', '${phpString(config.admin.username)}');
define('FS_INITIAL_PASS', '${phpString(config.admin.password)}');

// =============================================================================
// WASM environment shims (loaded via config.php to guarantee early execution)
// =============================================================================

// --- Server defaults ---
if (!isset($_SERVER['HTTP_USER_AGENT']) || $_SERVER['HTTP_USER_AGENT'] === '') {
    $_SERVER['HTTP_USER_AGENT'] = 'FacturaScripts-Playground/1.0 (WASM)';
}

// --- curl shim (curl extension is not available in WASM) ---
if (!defined('CURLOPT_AUTOREFERER')) {
    define('CURLOPT_AUTOREFERER', 58);
    define('CURLOPT_FOLLOWLOCATION', 52);
    define('CURLOPT_RETURNTRANSFER', 19913);
    define('CURLOPT_TIMEOUT', 13);
    define('CURLOPT_USERAGENT', 10018);
    define('CURLOPT_HTTPHEADER', 10023);
    define('CURLOPT_CUSTOMREQUEST', 10036);
    define('CURLOPT_URL', 10002);
    define('CURLOPT_POSTFIELDS', 10015);
    define('CURLOPT_POST', 47);
    define('CURLOPT_USERPWD', 10005);
    define('CURLOPT_HEADERFUNCTION', 20079);
    define('CURLOPT_SSL_VERIFYPEER', 64);
    define('CURLOPT_SSL_VERIFYHOST', 81);
    define('CURLOPT_CONNECTTIMEOUT', 78);
    define('CURLOPT_ENCODING', 10102);
    define('CURLOPT_MAXREDIRS', 68);
    define('CURLOPT_HEADER', 42);
    define('CURLOPT_NOBODY', 44);
    define('CURLOPT_VERBOSE', 41);
    define('CURLOPT_COOKIEFILE', 10031);
    define('CURLOPT_COOKIEJAR', 10082);
    define('CURLINFO_HTTP_CODE', 2097154);
    define('CURLINFO_CONTENT_TYPE', 1048594);
    define('CURLINFO_EFFECTIVE_URL', 1048577);
    define('CURLINFO_HEADER_SIZE', 2097163);
    define('CURLINFO_TOTAL_TIME', 3145731);
    define('CURL_HTTP_VERSION_1_1', 2);
    define('CURLOPT_HTTP_VERSION', 84);
}

if (!function_exists('curl_init')) {
    class _CurlHandle {
        public $url = '';
        public $method = 'GET';
        public $headers = [];
        public $postfields = null;
        public $returntransfer = false;
        public $timeout = 30;
        public $useragent = '';
        public $userpwd = '';
        public $followlocation = true;
        public $header_callback = null;
        public $error = '';
        public $info = [];
    }

    function curl_init($url = null) {
        $ch = new _CurlHandle();
        if ($url !== null) {
            $ch->url = $url;
        }
        return $ch;
    }

    function curl_setopt($ch, $option, $value) {
        switch ($option) {
            case CURLOPT_URL: $ch->url = $value; break;
            case CURLOPT_CUSTOMREQUEST: $ch->method = $value; break;
            case CURLOPT_POST: if ($value) $ch->method = 'POST'; break;
            case CURLOPT_POSTFIELDS: $ch->postfields = $value; break;
            case CURLOPT_RETURNTRANSFER: $ch->returntransfer = (bool)$value; break;
            case CURLOPT_HTTPHEADER: $ch->headers = (array)$value; break;
            case CURLOPT_TIMEOUT: $ch->timeout = (int)$value; break;
            case CURLOPT_USERAGENT: $ch->useragent = $value; break;
            case CURLOPT_USERPWD: $ch->userpwd = $value; break;
            case CURLOPT_FOLLOWLOCATION: $ch->followlocation = (bool)$value; break;
            case CURLOPT_HEADERFUNCTION: $ch->header_callback = $value; break;
        }
        return true;
    }

    function curl_setopt_array($ch, array $options) {
        foreach ($options as $option => $value) {
            curl_setopt($ch, $option, $value);
        }
        return true;
    }

    function curl_exec($ch) {
        $ch->error = '';
        $ch->info = [
            CURLINFO_HTTP_CODE => 0,
            CURLINFO_CONTENT_TYPE => '',
            CURLINFO_EFFECTIVE_URL => $ch->url,
        ];

        $contextHeaders = [];
        foreach ($ch->headers as $h) {
            $contextHeaders[] = $h;
        }
        if ($ch->useragent && !preg_grep('/^User-Agent:/i', $contextHeaders)) {
            $contextHeaders[] = 'User-Agent: ' . $ch->useragent;
        }
        if ($ch->userpwd) {
            $contextHeaders[] = 'Authorization: Basic ' . base64_encode($ch->userpwd);
        }

        $content = null;
        $method = $ch->method ?: 'GET';

        if ($ch->postfields !== null && in_array($method, ['POST', 'PUT', 'PATCH'])) {
            $content = is_array($ch->postfields) ? http_build_query($ch->postfields) : $ch->postfields;
            if (!preg_grep('/^Content-Type:/i', $contextHeaders)) {
                $contextHeaders[] = 'Content-Type: application/x-www-form-urlencoded';
            }
        }

        $httpOpts = [
            'method' => $method,
            'header' => implode("\\r\\n", $contextHeaders),
            'follow_location' => $ch->followlocation ? 1 : 0,
            'timeout' => $ch->timeout,
            'ignore_errors' => true,
        ];
        if ($content !== null) {
            $httpOpts['content'] = $content;
        }

        $context = stream_context_create(['http' => $httpOpts]);
        $result = @file_get_contents($ch->url, false, $context);

        if ($result === false) {
            $ch->error = 'curl shim: request failed for ' . $ch->url;
            $ch->info[CURLINFO_HTTP_CODE] = 0;
            return false;
        }

        $statusCode = 200;
        if (isset($http_response_header) && is_array($http_response_header)) {
            foreach ($http_response_header as $responseHeader) {
                if (preg_match('/^HTTP\\/[\\d.]+ (\\d+)/', $responseHeader, $m)) {
                    $statusCode = (int)$m[1];
                }
                if ($ch->header_callback) {
                    call_user_func($ch->header_callback, $ch, $responseHeader . "\\r\\n");
                }
            }
        }

        $ch->info[CURLINFO_HTTP_CODE] = $statusCode;
        return $ch->returntransfer ? $result : true;
    }

    function curl_getinfo($ch, $opt = null) {
        if ($opt !== null) {
            return $ch->info[$opt] ?? null;
        }
        return $ch->info;
    }

    function curl_error($ch) {
        return $ch->error;
    }

    function curl_errno($ch) {
        return $ch->error ? 1 : 0;
    }

    function curl_close($ch) {
        return true;
    }
}

if (!class_exists('CURLFile', false)) {
    class CURLFile {
        public $name;
        public $mime;
        public $postname;
        public function __construct(string $filename, string $mime_type = '', string $posted_filename = '') {
            $this->name = $filename;
            $this->mime = $mime_type;
            $this->postname = $posted_filename;
        }
        public function getFilename(): string { return $this->name; }
        public function getMimeType(): string { return $this->mime; }
        public function getPostFilename(): string { return $this->postname; }
    }
}

// --- finfo shim (fileinfo extension is not available in WASM) ---
if (!class_exists('finfo', false)) {
    class finfo {
        private int $flags;
        public function __construct(int $flags = FILEINFO_NONE, ?string $magic_database = null) {
            $this->flags = $flags;
        }
        public function file(string $filename, int $flags = FILEINFO_NONE, $context = null) {
            $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
            $map = [
                'jpg'=>'image/jpeg','jpeg'=>'image/jpeg','png'=>'image/png','gif'=>'image/gif',
                'svg'=>'image/svg+xml','webp'=>'image/webp','bmp'=>'image/bmp','ico'=>'image/x-icon',
                'pdf'=>'application/pdf','zip'=>'application/zip','gz'=>'application/gzip',
                'css'=>'text/css','js'=>'application/javascript','json'=>'application/json',
                'xml'=>'application/xml','html'=>'text/html','htm'=>'text/html','txt'=>'text/plain',
                'csv'=>'text/csv','mp3'=>'audio/mpeg','ogg'=>'audio/ogg','wav'=>'audio/wav',
                'mp4'=>'video/mp4','webm'=>'video/webm',
            ];
            return $map[$ext] ?? 'application/octet-stream';
        }
        public function buffer(string $string, int $flags = FILEINFO_NONE, $context = null) {
            return 'application/octet-stream';
        }
        public function set_flags(int $flags): bool { $this->flags = $flags; return true; }
    }
}
if (!defined('FILEINFO_NONE')) { define('FILEINFO_NONE', 0); }
if (!defined('FILEINFO_MIME_TYPE')) { define('FILEINFO_MIME_TYPE', 16); }
if (!defined('FILEINFO_MIME')) { define('FILEINFO_MIME', 1040); }

if (!function_exists('finfo_open')) {
    function finfo_open(int $flags = FILEINFO_NONE, ?string $magic_database = null) { return new finfo($flags, $magic_database); }
}
if (!function_exists('finfo_file')) {
    function finfo_file($finfo, string $filename, int $flags = FILEINFO_NONE, $context = null) { return $finfo->file($filename, $flags, $context); }
}
if (!function_exists('finfo_buffer')) {
    function finfo_buffer($finfo, string $string, int $flags = FILEINFO_NONE, $context = null) { return $finfo->buffer($string, $flags, $context); }
}
if (!function_exists('finfo_close')) {
    function finfo_close($finfo): bool { return true; }
}
if (!function_exists('mime_content_type')) {
    function mime_content_type(string $filename) { return (new finfo(FILEINFO_MIME_TYPE))->file($filename); }
}

// --- bcmath polyfill (bcmath extension is not available in WASM) ---
if (!function_exists('bcadd')) {
    function _bc_normalize($num) {
        $num = trim((string)$num);
        if ($num === '' || $num === '.') return '0';
        return $num;
    }
    function _bc_to_float($num) { return (float)_bc_normalize($num); }
    function _bc_format($result, $scale) {
        if ($scale === null) $scale = 0;
        if ($scale < 0) $scale = 0;
        $result = number_format($result, $scale + 2, '.', '');
        if ($scale === 0) {
            $pos = strpos($result, '.');
            return $pos !== false ? substr($result, 0, $pos) : $result;
        }
        $pos = strpos($result, '.');
        if ($pos === false) return $result . '.' . str_repeat('0', $scale);
        $decimals = substr($result, $pos + 1);
        return substr($result, 0, $pos) . '.' . substr(str_pad($decimals, $scale, '0'), 0, $scale);
    }

    function bcadd($a, $b, $scale = null) { return _bc_format(_bc_to_float($a) + _bc_to_float($b), $scale); }
    function bcsub($a, $b, $scale = null) { return _bc_format(_bc_to_float($a) - _bc_to_float($b), $scale); }
    function bcmul($a, $b, $scale = null) { return _bc_format(_bc_to_float($a) * _bc_to_float($b), $scale); }
    function bcdiv($a, $b, $scale = null) {
        $bv = _bc_to_float($b);
        if ($bv == 0) { trigger_error('bcdiv(): Division by zero', E_USER_WARNING); return null; }
        return _bc_format(_bc_to_float($a) / $bv, $scale);
    }
    function bcmod($a, $b, $scale = null) {
        $bv = _bc_to_float($b);
        if ($bv == 0) { trigger_error('bcmod(): Division by zero', E_USER_WARNING); return null; }
        return _bc_format(fmod(_bc_to_float($a), $bv), $scale);
    }
    function bccomp($a, $b, $scale = null) {
        $av = _bc_to_float($a); $bv = _bc_to_float($b);
        if ($scale !== null) { $av = round($av, $scale); $bv = round($bv, $scale); }
        if ($av > $bv) return 1;
        if ($av < $bv) return -1;
        return 0;
    }
    function bcpow($a, $b, $scale = null) { return _bc_format(pow(_bc_to_float($a), (int)_bc_to_float($b)), $scale); }
    function bcscale($scale = null) { return 0; }
    function bcpowmod($a, $b, $mod, $scale = null) {
        return bcmod(bcpow($a, $b, $scale), $mod, $scale);
    }
    function bcsqrt($a, $scale = null) { return _bc_format(sqrt(_bc_to_float($a)), $scale); }
}
`;
}

function buildPhpPrepend() {
  // All WASM shims (curl, finfo, bcmath, etc.) are now defined in config.php
  // which is loaded via require_once on every request. The prepend is kept
  // minimal for any per-request setup that cannot go in config.php.
  return `<?php
// Placeholder — all shims live in config.php for reliable loading.
`;
}

function buildInstallScript() {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

define('FS_FOLDER', '${FS_ROOT}');

require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';

// Create required mutable directories
$dirs = ['Plugins', 'Dinamic', 'MyFiles', 'MyFiles/Log'];
foreach ($dirs as $dir) {
    $path = FS_FOLDER . '/' . $dir;
    if (!is_dir($path)) {
        @mkdir($path, 0777, true);
    }
}

// Deploy plugins to create tables and initial structure
$pluginManager = new FacturaScripts\\Core\\Plugins();
$pluginManager->deploy(true, true);

echo 'INSTALL_OK';
`;
}

export function buildWizardScript(config) {
  const inst = config.install || {};
  const codpais = phpString(inst.codpais || "ESP");
  const empresa = phpString(inst.empresa || "Empresa Playground");
  const cifnif = phpString(inst.cifnif || "00000014Z");
  const tipoidfiscal = phpString(inst.tipoidfiscal || "");
  const direccion = phpString(inst.direccion || "");
  const codpostal = phpString(inst.codpostal || "");
  const ciudad = phpString(inst.ciudad || "");
  const provincia = phpString(inst.provincia || "");
  const regimeniva = phpString(inst.regimeniva || "General");
  const codimpuesto = phpString(inst.codimpuesto || "");
  const defaultplan = phpBoolean(inst.defaultplan !== false);
  const costpricepolicy = phpString(inst.costpricepolicy || "");
  const ventasinstock = phpBoolean(inst.ventasinstock === true);
  const updatesupplierprices = phpBoolean(inst.updatesupplierprices !== false);
  const adminUser = phpString(config.admin?.username || "admin");
  const adminEmail = phpString(config.admin?.email || "");

  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

define('FS_FOLDER', '${FS_ROOT}');

require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';

use FacturaScripts\\Core\\Tools;
use FacturaScripts\\Core\\Model\\Almacen;
use FacturaScripts\\Core\\Model\\AttachedFile;
use FacturaScripts\\Core\\Model\\Diario;
use FacturaScripts\\Core\\Model\\Empresa;
use FacturaScripts\\Core\\Model\\EstadoDocumento;
use FacturaScripts\\Core\\Model\\FormaPago;
use FacturaScripts\\Core\\Model\\Impuesto;
use FacturaScripts\\Core\\Model\\Provincia;
use FacturaScripts\\Core\\Model\\Retencion;
use FacturaScripts\\Core\\Model\\Serie;
use FacturaScripts\\Core\\Model\\User;

header('Content-Type: application/json');

// Idempotency guard: if taxes already exist, the wizard has already run
$impuesto = new Impuesto();
if ($impuesto->count() > 0) {
    echo json_encode(['ok' => true, 'skipped' => true]);
    exit;
}

$codpais = '${codpais}';

// Step 1: Load country defaults
$defaultsFile = FS_FOLDER . '/Dinamic/Data/Codpais/' . $codpais . '/default.json';
if (!file_exists($defaultsFile)) {
    $defaultsFile = FS_FOLDER . '/Core/Data/Codpais/' . $codpais . '/default.json';
}

$countryDefaults = [];
if (file_exists($defaultsFile)) {
    $content = file_get_contents($defaultsFile);
    if ($content !== false) {
        $countryDefaults = json_decode($content, true) ?: [];
    }
}

// Apply country defaults to settings
$settingsKeys = ['coddivisa', 'codimpuesto', 'codpago', 'codserie', 'tipoidfiscal'];
foreach ($settingsKeys as $key) {
    if (isset($countryDefaults[$key]) && $countryDefaults[$key] !== '') {
        Tools::settingsSet('default', $key, $countryDefaults[$key]);
    }
}

// Initialize models (triggers install SQL for each)
$models = [
    new AttachedFile(),
    new Diario(),
    new EstadoDocumento(),
    new FormaPago(),
    new Impuesto(),
    new Retencion(),
    new Serie(),
    new Provincia(),
];
foreach ($models as $model) {
    // Calling count() or any query triggers the install() method
    $model->count();
}

// Update empresa (company)
$empresa = new Empresa();
if ($empresa->loadFromCode(1)) {
    $empresa->nombre = '${empresa}';
    $empresa->nombrecorto = '${empresa}';
    $empresa->cifnif = '${cifnif}';
    $empresa->tipoidfiscal = '${tipoidfiscal}' ?: ($countryDefaults['tipoidfiscal'] ?? '');
    $empresa->direccion = '${direccion}';
    $empresa->codpostal = '${codpostal}';
    $empresa->ciudad = '${ciudad}';
    $empresa->provincia = '${provincia}';
    $empresa->codpais = $codpais;
    $empresa->email = '${adminEmail}';
    $empresa->regimeniva = '${regimeniva}';
    $empresa->save();
}

// Find or create warehouse and link to empresa
$almacen = new Almacen();
if (!$almacen->loadFromCode($almacen->primaryColumnValue())) {
    // Get the first warehouse
    $almacenes = $almacen->all([], [], 0, 1);
    if (!empty($almacenes)) {
        $almacen = $almacenes[0];
    }
}

if ($almacen->exists()) {
    $almacen->codpais = $codpais;
    $almacen->ciudad = '${ciudad}';
    $almacen->provincia = '${provincia}';
    $almacen->direccion = '${direccion}';
    $almacen->codpostal = '${codpostal}';
    $almacen->idempresa = $empresa->idempresa ?? 1;
    $almacen->save();

    Tools::settingsSet('default', 'codalmacen', $almacen->codalmacen);
    Tools::settingsSet('default', 'idempresa', $almacen->idempresa);
}

// Update admin user
$user = new User();
if ($user->loadFromCode('${adminUser}')) {
    $email = '${adminEmail}';
    if ($email !== '') {
        $user->email = $email;
    }
    $user->homepage = 'Dashboard';
    $user->save();
}

// Set additional settings
$codimpuestoVal = '${codimpuesto}';
if ($codimpuestoVal !== '') {
    Tools::settingsSet('default', 'codimpuesto', $codimpuestoVal);
}
$costpricepolicyVal = '${costpricepolicy}';
if ($costpricepolicyVal !== '') {
    Tools::settingsSet('default', 'costpricepolicy', $costpricepolicyVal);
}
Tools::settingsSet('default', 'updatesupplierprices', ${updatesupplierprices});
Tools::settingsSet('default', 'ventasinstock', ${ventasinstock});

// Import default accounting plan if requested
if (${defaultplan}) {
    $planFile = FS_FOLDER . '/Dinamic/Data/Codpais/' . $codpais . '/plan.csv';
    if (!file_exists($planFile)) {
        $planFile = FS_FOLDER . '/Core/Data/Codpais/' . $codpais . '/plan.csv';
    }
    if (file_exists($planFile)) {
        $importClass = 'FacturaScripts\\\\Core\\\\Lib\\\\Accounting\\\\AccountingPlanImport';
        if (class_exists($importClass)) {
            $importer = new $importClass();
            $importer->importCSV($planFile, '0001');
        }
    }
}

// Step 3: Load ALL Dinamic/Model classes to trigger remaining table creation.
// We use scandir() instead of glob() because glob() may not work in WASM MEMFS.
// This mirrors FacturaScripts\\Core\\Controller\\Wizard::saveStep3().
$dinamicModelDir = FS_FOLDER . '/Dinamic/Model';
$modelDebug = ['dir_exists' => is_dir($dinamicModelDir), 'loaded' => [], 'errors' => []];
if (is_dir($dinamicModelDir)) {
    $files = @scandir($dinamicModelDir);
    $modelDebug['scandir_count'] = is_array($files) ? count($files) : 'false';
    if (is_array($files)) {
        foreach ($files as $fileName) {
            if (substr($fileName, -4) !== '.php') {
                continue;
            }
            $modelName = substr($fileName, 0, -4);
            $className = 'FacturaScripts\\\\Dinamic\\\\Model\\\\' . $modelName;
            try {
                new $className();
                $modelDebug['loaded'][] = $modelName;
            } catch (\\Throwable $e) {
                $modelDebug['errors'][] = $modelName . ': ' . $e->getMessage();
            }
        }
    }
}

// Run deploy again after all models are loaded (mirrors real Wizard step 3)
$pluginManager = new FacturaScripts\\Core\\Plugins();
$pluginManager->deploy(true, true);

// Set default employee role
Tools::settingsSet('default', 'codrol', 'employee');

// Save settings
Tools::settingsSave();

echo json_encode(['ok' => true, 'skipped' => false, 'modelDebug' => $modelDebug]);
`;
}

function _buildProbeScript() {
  return `<?php
$ok = true;
$results = [];

if (extension_loaded('pdo_sqlite')) {
    $results[] = 'pdo_sqlite: OK';
} else {
    $results[] = 'pdo_sqlite: MISSING';
    $ok = false;
}

try {
    $db = new PDO('sqlite::memory:');
    $db->exec('CREATE TABLE _probe (id INTEGER PRIMARY KEY)');
    $db->exec('INSERT INTO _probe (id) VALUES (1)');
    $row = $db->query('SELECT id FROM _probe LIMIT 1')->fetch();
    $results[] = $row && $row['id'] == 1 ? 'sqlite: OK' : 'sqlite: FAIL';
} catch (Throwable $e) {
    $results[] = 'sqlite: ERROR ' . $e->getMessage();
    $ok = false;
}

header('Content-Type: text/plain');
echo implode("\\n", $results) . "\\n";
echo $ok ? 'PROBE_OK' : 'PROBE_FAIL';
`;
}

function ensureDirSync(FS, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = FS.analyzePath(current);
    if (!about?.exists) {
      try {
        FS.mkdir(current);
      } catch {
        // Ignore existing directories.
      }
    }
  }
}

function _removeNodeIfPresent(FS, path) {
  const about = FS.analyzePath(path);
  if (!about.exists) {
    return;
  }

  const mode = about.object?.mode;
  if (typeof mode === "number" && FS.isDir(mode)) {
    for (const entry of FS.readdir(path)) {
      if (entry === "." || entry === "..") {
        continue;
      }
      _removeNodeIfPresent(FS, `${path}/${entry}`.replace(/\/{2,}/gu, "/"));
    }
    FS.rmdir(path);
    return;
  }

  FS.unlink(path);
}

function pathExists(FS, path) {
  return FS.analyzePath(path)?.exists || false;
}

function writeFileSafe(FS, path, content) {
  const parentDir = path.split("/").slice(0, -1).join("/") || "/";
  ensureDirSync(FS, parentDir);
  FS.writeFile(
    path,
    typeof content === "string" ? encoder.encode(content) : content,
  );
}

function readPlaygroundState(FS) {
  try {
    const about = FS.analyzePath(PLAYGROUND_CONFIG_PATH);
    if (!about?.exists) {
      return null;
    }
    const raw = decoder.decode(FS.readFile(PLAYGROUND_CONFIG_PATH));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePlaygroundState(FS, state) {
  writeFileSafe(FS, PLAYGROUND_CONFIG_PATH, JSON.stringify(state, null, 2));
}

function buildAutologinScript(username) {
  // Generates a logkey for the admin user and outputs the cookie values as JSON.
  // We then write them directly to /config/.cookies so the php-cgi-wasm CookieJar
  // picks them up for subsequent requests.
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

define('FS_FOLDER', '${FS_ROOT}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';

use FacturaScripts\\Core\\Model\\User;

header('Content-Type: application/json');

$user = new User();
if ($user->loadFromCode('${phpString(username)}')) {
    $user->newLogkey('127.0.0.1', 'playground');
    $user->save();

    echo json_encode([
        'ok' => true,
        'fsNick' => $user->nick,
        'fsLogkey' => $user->logkey,
        'fsLang' => $user->langcode,
    ]);
    exit;
}

echo json_encode(['ok' => false, 'error' => 'user not found']);
`;
}

async function performAutologin(php, config, FS, publish) {
  publish("Signing in admin user automatically.", 0.85);
  const scriptPath = `${FS_ROOT}/_playground_autologin.php`;
  writeFileSafe(FS, scriptPath, buildAutologinScript(config.admin.username));

  const response = await php.request(
    new Request("http://localhost/_playground_autologin.php"),
  );
  const text = await response.text();
  try {
    FS.unlink(scriptPath);
  } catch {
    /* ignore */
  }

  try {
    const result = JSON.parse(text);
    if (!result.ok) {
      return { ok: false, warning: `Autologin failed: ${result.error}` };
    }

    // Inject cookies directly into the php-cgi-wasm CookieJar.
    // The CookieJar injects them as HTTP_COOKIE env var into every PHP request.
    const cookieEntries = [
      `fsNick=${result.fsNick}; path=/`,
      `fsLogkey=${result.fsLogkey}; path=/`,
      `fsLang=${result.fsLang}; path=/`,
    ];
    for (const entry of cookieEntries) {
      php.cookieJar.store(entry);
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
  const binary = await php.binary;
  const { FS } = binary;

  publish("Loading FacturaScripts manifest.", 0.2);
  const manifest = await fetchManifest();
  const manifestState = buildManifestState(
    manifest,
    runtimeId,
    rawConfig.bundleVersion,
  );

  // Check existing state
  const existingState = readPlaygroundState(FS);
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
      if (pathExists(FS, path)) {
        try {
          FS.unlink(path);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Always mount the VFS — the in-memory filesystem is wiped between sessions
  publish("Mounting FacturaScripts readonly core.", 0.25);
  await mountReadonlyCore(php, manifest);

  // Create mutable directory layout
  // Directories are created directly inside the docroot. The VFS is readonly on
  // disk but Emscripten's MEMFS overlay allows in-memory writes on top of it.
  // Symlinks don't work reliably in MEMFS, so we create real directories.
  publish("Creating mutable directory layout.", 0.4);
  const mutableDirs = [
    "/persist/mutable/db",
    "/persist/mutable/config",
    "/persist/mutable/session",
    `${FS_ROOT}/MyFiles`,
    `${FS_ROOT}/MyFiles/Log`,
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
    ensureDirSync(FS, dir);
  }

  // Write config.php
  publish("Writing config.php.", 0.45);
  writeFileSafe(FS, `${FS_ROOT}/config.php`, buildConfigPhp(config));

  // Write PHP prepend file
  publish("Writing PHP prepend file.", 0.48);
  writeFileSafe(FS, PLAYGROUND_PREPEND_PATH, buildPhpPrepend());

  // Configure php.ini for prepend
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
  // Write php.ini to /config/ which is in PHP_INI_SCAN_DIR (set by php-cgi-wasm)
  writeFileSafe(FS, "/config/php.ini", phpIniContent);

  // Always run deploy — the in-memory Dinamic/ directory is empty on each session.
  // Plugins::deploy() generates compiled views, controllers, assets, etc.
  publish("Running FacturaScripts deploy (compiling views and assets).", 0.55);
  const installScriptPath = `${FS_ROOT}/_playground_install.php`;
  writeFileSafe(FS, installScriptPath, buildInstallScript());

  const installResponse = await php.request(
    new Request("http://localhost/_playground_install.php"),
  );
  const installText = await installResponse.text();
  try {
    FS.unlink(installScriptPath);
  } catch {
    /* ignore */
  }
  if (!installText.includes("INSTALL_OK")) {
    throw new Error(`FacturaScripts deploy failed:\n${installText}`);
  }

  if (!skipInstall) {
    // First request to / to trigger initial setup (creates admin user etc.)
    publish("Triggering first-run setup.", 0.65);
    const firstRunResponse = await php.request(
      new Request("http://localhost/"),
    );
    const firstRunStatus = firstRunResponse.status;
    if (firstRunStatus >= 500) {
      const body = await firstRunResponse.text();
      throw new Error(`First-run request returned ${firstRunStatus}:\n${body}`);
    }

    // Run wizard-equivalent initialization (taxes, payment methods, company data, etc.)
    publish("Initializing company, taxes, and base data.", 0.72);
    const wizardScriptPath = `${FS_ROOT}/_playground_wizard.php`;
    writeFileSafe(FS, wizardScriptPath, buildWizardScript(config));

    const wizardResponse = await php.request(
      new Request("http://localhost/_playground_wizard.php"),
    );
    const wizardText = await wizardResponse.text();
    try {
      FS.unlink(wizardScriptPath);
    } catch {
      /* ignore */
    }

    try {
      const wizardResult = JSON.parse(wizardText);
      if (wizardResult.modelDebug) {
        console.log(
          "[wizard] Model debug:",
          JSON.stringify(wizardResult.modelDebug),
        );
      }
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

    // Save playground state
    publish("Saving playground state.", 0.85);
    writePlaygroundState(FS, {
      manifestVersion,
      runtimeId,
      installedAt: new Date().toISOString(),
      admin: {
        username: config.admin.username,
      },
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

  const readyPath = blueprint.landingPage || config.landingPath || "/";

  if (config.autologin) {
    const autologin = await performAutologin(php, config, FS, publish);
    if (autologin.ok) {
      publish("Autologin successful.", 0.9);
    } else if (autologin.warning) {
      publish(`[warning] ${autologin.warning}`, 0.92);
    }
  }

  publish("FacturaScripts is ready.", 0.95);
  return { readyPath };
}
