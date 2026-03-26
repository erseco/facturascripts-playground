import { FS_ROOT } from "./bootstrap-paths.js";

export function buildWizardScript(config) {
  const adminPassword = config.admin?.password || "admin";
  const email = config.admin?.email || "admin@example.com";
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once '${FS_ROOT}/config.php';
require_once '${FS_ROOT}/vendor/autoload.php';
use FacturaScripts\\Core\\Base\\DataBase;
use FacturaScripts\\Core\\Tools;
use FacturaScripts\\Dinamic\\Model\\Almacen;
use FacturaScripts\\Dinamic\\Model\\Empresa;
use FacturaScripts\\Dinamic\\Model\\Pais;
use FacturaScripts\\Dinamic\\Model\\User;

header('Content-Type: application/json');
$db = new DataBase();
$db->connect();

$codpais = '${config.install?.codpais || "ESP"}';
$companyName = '${config.install?.empresa || "Mi Empresa"}';

// Create base records FIRST so FK constraints on the user are satisfied.
$pais = new Pais();
if (!$pais->loadFromCode($codpais)) {
    $pais->codpais = $codpais;
    $pais->nombre = 'España';
    $pais->save();
}

$empresa = new Empresa();
$empresa->loadFromCode('1');
$empresa->nombre = $companyName;
$empresa->codpais = $codpais;
if (!$empresa->primaryColumnValue()) { $empresa->codempresa = 1; }
$empresa->save();

$almacen = new Almacen();
if ($almacen->loadFromCode('ALG')) {
    Tools::settingsSet('default', 'codalmacen', $almacen->codalmacen);
} else {
    $almacen = new Almacen();
    $almacen->nombre = $companyName;
    $almacen->codpais = $codpais;
    $almacen->idempresa = $empresa->idempresa;
    $almacen->save();
    Tools::settingsSet('default', 'codalmacen', $almacen->codalmacen);
}
Tools::settingsSet('default', 'idempresa', $empresa->idempresa);
Tools::settingsSave();

// Create/update admin user AFTER empresa/almacen exist (User::clear() reads these defaults).
$user = new User();
if (!$user->loadFromCode('${config.admin?.username || "admin"}')) {
    $user->nick = '${config.admin?.username || "admin"}';
    $user->langcode = '${config.locale || "es_ES"}';
    $user->save();
}
$user->email = '${email}';
if (strlen('${adminPassword}') >= 8) { $user->setPassword('${adminPassword}'); }
$user->langcode = '${config.locale || "es_ES"}';
$user->homepage = 'Dashboard';
$user->save();

echo json_encode(['ok' => true]);
`;
}
