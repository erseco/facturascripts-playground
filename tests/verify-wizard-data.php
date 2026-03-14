<?php
/**
 * Runtime verification script for wizard initialization.
 *
 * Run this manually inside the playground to verify that wizard-equivalent
 * data was properly created. Execute via the playground's PHP runner or
 * place it in the web root and navigate to it.
 *
 * Expected output: all checks should show "OK".
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

define('FS_FOLDER', '/www/facturascripts');

require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';

header('Content-Type: text/plain');

$checks = [];
$allOk = true;

function check(string $label, bool $ok, string $detail = ''): void {
    global $checks, $allOk;
    $status = $ok ? 'OK' : 'FAIL';
    $msg = "$status: $label";
    if ($detail) {
        $msg .= " ($detail)";
    }
    $checks[] = $msg;
    if (!$ok) {
        $allOk = false;
    }
}

// Check taxes
$impuesto = new FacturaScripts\Core\Model\Impuesto();
$taxCount = $impuesto->count();
check('Impuesto (taxes) exist', $taxCount > 0, "count=$taxCount");

// Check payment methods
$formaPago = new FacturaScripts\Core\Model\FormaPago();
$payCount = $formaPago->count();
check('FormaPago (payment methods) exist', $payCount > 0, "count=$payCount");

// Check document states
$estado = new FacturaScripts\Core\Model\EstadoDocumento();
$stateCount = $estado->count();
check('EstadoDocumento (document states) exist', $stateCount > 0, "count=$stateCount");

// Check series
$serie = new FacturaScripts\Core\Model\Serie();
$serieCount = $serie->count();
check('Serie (series) exist', $serieCount > 0, "count=$serieCount");

// Check journals
$diario = new FacturaScripts\Core\Model\Diario();
$diarioCount = $diario->count();
check('Diario (journals) exist', $diarioCount > 0, "count=$diarioCount");

// Check company
$empresa = new FacturaScripts\Core\Model\Empresa();
if ($empresa->loadFromCode(1)) {
    check('Empresa loaded', true);
    check('Empresa.regimeniva set', !empty($empresa->regimeniva), "value={$empresa->regimeniva}");
    check('Empresa.nombre set', !empty($empresa->nombre), "value={$empresa->nombre}");
} else {
    check('Empresa loaded', false, 'Could not load empresa with id=1');
}

// Check warehouse
$almacen = new FacturaScripts\Core\Model\Almacen();
$almacenes = $almacen->all([], [], 0, 1);
check('Almacen (warehouse) exists', !empty($almacenes));

// Check settings
use FacturaScripts\Core\Tools;
$codalmacen = Tools::settings('default', 'codalmacen');
check('Setting codalmacen set', !empty($codalmacen), "value=$codalmacen");

$idempresa = Tools::settings('default', 'idempresa');
check('Setting idempresa set', !empty($idempresa), "value=$idempresa");

echo implode("\n", $checks) . "\n\n";
echo $allOk ? 'ALL_CHECKS_PASSED' : 'SOME_CHECKS_FAILED';
echo "\n";
