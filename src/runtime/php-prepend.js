import { FS_ROOT, PLAYGROUND_DB_PATH } from "./bootstrap-paths.js";

/**
 * PHP `auto_prepend_file` content, executed before every FacturaScripts request.
 *
 * Kept in its own module (only pure path constants imported) so it can be unit
 * tested without pulling in the browser-only bootstrap dependency chain.
 */
export function buildPhpPrepend() {
  return `<?php
if (!file_exists('${PLAYGROUND_DB_PATH}')) {
    $dir = dirname('${PLAYGROUND_DB_PATH}');
    if (!is_dir($dir)) { mkdir($dir, 0777, true); }
    touch('${PLAYGROUND_DB_PATH}');
}
$_SERVER['SERVER_PORT'] = 80;
if (empty($_SERVER['DOCUMENT_ROOT'])) { $_SERVER['DOCUMENT_ROOT'] = '${FS_ROOT}'; }
if (empty($_SERVER['SCRIPT_FILENAME'])) { $_SERVER['SCRIPT_FILENAME'] = $_SERVER['DOCUMENT_ROOT'] . '/index.php'; }
// Pre-populate the Forja cache (serialized empty arrays) before every request.
// In the offline playground, Forja::builds()/plugins() would otherwise reach
// facturascripts.com through the CORS proxy and parse a non-array response,
// crashing Dashboard with "Cannot access offset of type string on string"
// (Forja.php). Writing on each request also survives Cache::clear() and the
// 3600s cache expiry, so canUpdateCore() stays false and no curl call fires.
$fsForjaCacheDir = '${FS_ROOT}/MyFiles/Tmp/FileCache';
if (!is_dir($fsForjaCacheDir)) { @mkdir($fsForjaCacheDir, 0777, true); }
foreach (['forja_builds', 'forja_plugins'] as $fsForjaKey) {
    @file_put_contents($fsForjaCacheDir . '/' . $fsForjaKey . '.cache', 'a:0:{}');
}
`;
}
