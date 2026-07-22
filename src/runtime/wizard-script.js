import { FS_ROOT } from "./bootstrap-paths.js";

/**
 * Escape a value for safe inclusion inside a single-quoted PHP string.
 */
function phpQuote(value) {
  return String(value ?? "")
    .replace(/\\/gu, "\\\\")
    .replace(/'/gu, "\\'");
}

/**
 * Build the first-run PHP wizard that mirrors FacturaScripts Wizard steps 1–2:
 * country defaults, core models (taxes, payment methods, series…), company,
 * warehouse, default tax/payment/serie, and optional accounting plan import.
 *
 * Values come from blueprint `install` (see docs/blueprint-json.md).
 */
export function buildWizardScript(config) {
  const install = config.install || {};
  const adminPassword = config.admin?.password || "admin";
  const email = config.admin?.email || "admin@example.com";
  const username = config.admin?.username || "admin";
  const locale = config.locale || "es_ES";

  const codpais = phpQuote(install.codpais || "ESP");
  const companyName = phpQuote(install.empresa || "Mi Empresa");
  const cifnif = phpQuote(install.cifnif || "");
  const tipoidfiscal = phpQuote(install.tipoidfiscal || "");
  const direccion = phpQuote(install.direccion || "");
  const codpostal = phpQuote(install.codpostal || "");
  const ciudad = phpQuote(install.ciudad || "");
  const provincia = phpQuote(install.provincia || "");
  const regimeniva = phpQuote(install.regimeniva || "General");
  const codimpuesto = phpQuote(install.codimpuesto || "");
  const costpricepolicy = phpQuote(install.costpricepolicy || "");
  const defaultplan = install.defaultplan === false ? "false" : "true";
  const ventasinstock = install.ventasinstock === true ? "true" : "false";
  const updatesupplierprices =
    install.updatesupplierprices === false ? "false" : "true";

  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '${FS_ROOT}/config.php';
require_once '${FS_ROOT}/vendor/autoload.php';
use FacturaScripts\\Core\\Base\\DataBase;
use FacturaScripts\\Core\\Tools;
use FacturaScripts\\Dinamic\\Lib\\Accounting\\AccountingPlanImport;
use FacturaScripts\\Dinamic\\Model\\Almacen;
use FacturaScripts\\Dinamic\\Model\\AttachedFile;
use FacturaScripts\\Dinamic\\Model\\Cuenta;
use FacturaScripts\\Dinamic\\Model\\Diario;
use FacturaScripts\\Dinamic\\Model\\Ejercicio;
use FacturaScripts\\Dinamic\\Model\\Empresa;
use FacturaScripts\\Dinamic\\Model\\EstadoDocumento;
use FacturaScripts\\Dinamic\\Model\\FormaPago;
use FacturaScripts\\Dinamic\\Model\\Impuesto;
use FacturaScripts\\Dinamic\\Model\\Pais;
use FacturaScripts\\Dinamic\\Model\\Provincia;
use FacturaScripts\\Dinamic\\Model\\Retencion;
use FacturaScripts\\Dinamic\\Model\\Serie;
use FacturaScripts\\Dinamic\\Model\\User;

header('Content-Type: application/json');
$db = new DataBase();
$db->connect();

$codpais = '${codpais}';
$companyName = '${companyName}';
$cifnif = '${cifnif}';
$tipoidfiscal = '${tipoidfiscal}';
$direccion = '${direccion}';
$codpostal = '${codpostal}';
$ciudad = '${ciudad}';
$provincia = '${provincia}';
$regimeniva = '${regimeniva}';
$codimpuesto = '${codimpuesto}';
$defaultplan = ${defaultplan};
$ventasinstock = ${ventasinstock};
$updatesupplierprices = ${updatesupplierprices};
$costpricepolicy = '${costpricepolicy}';

// Create base records FIRST so FK constraints on the user are satisfied.
$pais = new Pais();
if (!$pais->loadFromCode($codpais)) {
    $pais->codpais = $codpais;
    $pais->nombre = 'España';
    $pais->save();
}

// Load country defaults (coddivisa, codimpuesto, codpago, codserie, tipoidfiscal…).
$defaultJson = FS_FOLDER . '/Dinamic/Data/Codpais/' . $codpais . '/default.json';
if (is_file($defaultJson)) {
    $defaults = json_decode(file_get_contents($defaultJson), true) ?? [];
    foreach ($defaults as $group => $values) {
        if (!is_array($values)) { continue; }
        foreach ($values as $key => $value) {
            Tools::settingsSet((string)$group, (string)$key, $value);
        }
    }
}
Tools::settingsSet('default', 'codpais', $codpais);
Tools::settingsSet('default', 'homepage', 'Dashboard');

// Instantiate core models so CSV seed data (impuestos, formaspago, series…) is imported
// before the blueprint seed and before invoice posting needs them.
foreach ([
    AttachedFile::class, Diario::class, EstadoDocumento::class, FormaPago::class,
    Impuesto::class, Retencion::class, Serie::class, Provincia::class, Ejercicio::class,
] as $cls) {
    try { new $cls(); } catch (\\Throwable $e) {}
}

$empresa = new Empresa();
$empresa->loadFromCode('1');
$empresa->nombre = $companyName;
$empresa->nombrecorto = Tools::textBreak($companyName, 32);
$empresa->codpais = $codpais;
$empresa->cifnif = $cifnif;
$empresa->tipoidfiscal = $tipoidfiscal !== ''
    ? $tipoidfiscal
    : (string)Tools::settings('default', 'tipoidfiscal', 'NIF');
$empresa->regimeniva = $regimeniva !== '' ? $regimeniva : 'General';
$empresa->direccion = $direccion;
$empresa->codpostal = $codpostal;
$empresa->ciudad = $ciudad;
$empresa->provincia = $provincia;
if (!$empresa->primaryColumnValue()) { $empresa->codempresa = 1; }
$empresa->save();

$almacen = new Almacen();
if ($almacen->loadFromCode('ALG')) {
    $almacen->nombre = Tools::textBreak($companyName, 100);
    $almacen->codpais = $codpais;
    $almacen->direccion = $direccion;
    $almacen->codpostal = $codpostal;
    $almacen->ciudad = $ciudad;
    $almacen->provincia = $provincia;
    $almacen->idempresa = $empresa->idempresa;
    $almacen->save();
    Tools::settingsSet('default', 'codalmacen', $almacen->codalmacen);
} else {
    $almacen = new Almacen();
    $almacen->nombre = Tools::textBreak($companyName, 100);
    $almacen->codpais = $codpais;
    $almacen->direccion = $direccion;
    $almacen->codpostal = $codpostal;
    $almacen->ciudad = $ciudad;
    $almacen->provincia = $provincia;
    $almacen->idempresa = $empresa->idempresa;
    $almacen->save();
    Tools::settingsSet('default', 'codalmacen', $almacen->codalmacen);
}
Tools::settingsSet('default', 'idempresa', $empresa->idempresa);

// Override defaults from blueprint install when provided.
if ($codimpuesto !== '') {
    Tools::settingsSet('default', 'codimpuesto', $codimpuesto);
}
Tools::settingsSet('default', 'ventasinstock', $ventasinstock);
Tools::settingsSet('default', 'updatesupplierprices', $updatesupplierprices);
if ($costpricepolicy !== '') {
    Tools::settingsSet('default', 'costpricepolicy', $costpricepolicy);
}
if ($regimeniva !== '') {
    Tools::settingsSet('default', 'regimeniva', $regimeniva);
}
Tools::settingsSave();

// Import default accounting plan (PGC for ESP) so invoices can generate asientos.
if ($defaultplan) {
    $cuenta = new Cuenta();
    if ($cuenta->count() === 0) {
        $planFile = FS_FOLDER . '/Dinamic/Data/Codpais/' . $codpais . '/defaultPlan.csv';
        if (is_file($planFile)) {
            foreach (Ejercicio::all() as $exercise) {
                (new AccountingPlanImport())->importCSV($planFile, $exercise->codejercicio);
                break;
            }
        }
    }
}

// Create/update admin user AFTER empresa/almacen exist (User::clear() reads these defaults).
$user = new User();
if (!$user->loadFromCode('${phpQuote(username)}')) {
    $user->nick = '${phpQuote(username)}';
    $user->langcode = '${phpQuote(locale)}';
    $user->save();
}
$user->email = '${phpQuote(email)}';
if (strlen('${phpQuote(adminPassword)}') >= 8) { $user->setPassword('${phpQuote(adminPassword)}'); }
$user->langcode = '${phpQuote(locale)}';
$user->homepage = 'Dashboard';
if ($codAlmacen = Tools::settings('default', 'codalmacen')) {
    $user->codalmacen = $codAlmacen;
}
if ($codSerie = Tools::settings('default', 'codserie')) {
    $user->codserie = $codSerie;
}
$user->save();

echo json_encode([
    'ok' => true,
    'codpais' => $codpais,
    'codimpuesto' => Tools::settings('default', 'codimpuesto'),
    'codalmacen' => Tools::settings('default', 'codalmacen'),
    'defaultplan' => $defaultplan,
]);
`;
}
