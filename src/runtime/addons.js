import { APP_LOCATION, resolveProxyUrl } from "./networking.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PERSIST_ADDONS_ROOT = "/persist/addons";
const PLUGIN_DOWNLOAD_DIR = `${PERSIST_ADDONS_ROOT}/downloads`;
const BLUEPRINT_PAYLOAD_PATH = "/tmp/blueprint-payload.json";
const BLUEPRINT_STATE_PATH = "/persist/mutable/config/blueprint-state.json";

function sanitizeSegment(value, fallback) {
  const normalized = String(value || "").trim();
  const sanitized = normalized.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return sanitized || fallback;
}

async function sha256Text(text) {
  const bytes = encoder.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureDir(php, path) {
  const segments = path.split("/").filter(Boolean);
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

async function removeNodeIfPresent(php, path) {
  const about = await php.analyzePath(path);
  if (!about?.exists) return;
  try {
    await php.unlink(path);
  } catch {}
}

async function pathExists(php, path) {
  const about = await php.analyzePath(path);
  return about?.exists || false;
}

function buildDownloadUrl(sourceUrl, proxyBaseUrl) {
  if (!proxyBaseUrl) return sourceUrl;
  const proxied = new URL(proxyBaseUrl);
  proxied.searchParams.set("url", sourceUrl);
  return proxied.toString();
}

async function fetchBytes(url) {
  const directFetch =
    globalThis.__playgroundOriginalFetch || globalThis.fetch.bind(globalThis);
  const response = await directFetch(url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchPluginArchive(url, _name, proxyBaseUrl) {
  return fetchBytes(buildDownloadUrl(url, proxyBaseUrl));
}

function buildPluginSourceList(plugin) {
  const sources = [];
  if (plugin.source?.url) sources.push(plugin.source.url);
  return sources;
}

function buildPluginOps(results) {
  return results.map((entry) => ({
    name: entry.name || "",
    zipPath: entry.zipPath || "",
    shouldEnable: entry.shouldEnable,
  }));
}

function buildBlueprintMaterializationState({
  manifestVersion,
  blueprintHash,
  pluginResults,
  seedSummary,
}) {
  return {
    manifestVersion,
    blueprintHash,
    materializedAt: new Date().toISOString(),
    plugins: pluginResults,
    seed: seedSummary,
  };
}

function buildSeedPayload(blueprint) {
  return {
    customers: blueprint.seed?.customers || [],
    suppliers: blueprint.seed?.suppliers || [],
    products: blueprint.seed?.products || [],
  };
}

function buildPluginScript({ fsRoot, payloadPath }) {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
defined('FS_FOLDER') || define('FS_FOLDER', '${fsRoot}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';
use FacturaScripts\\Core\\Plugins;
use FacturaScripts\\Core\\Base\\DataBase;

function pluginNameFromZip(string $zipPath): string {
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) return '';
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $entry = $zip->getNameIndex($i);
        if (!preg_match('/(?:^|\\/)(facturascripts\\.ini)$/i', $entry)) continue;
        $ini = $zip->getFromIndex($i);
        if ($ini === false) continue;
        $data = parse_ini_string($ini);
        if (!empty($data['name'])) { $zip->close(); return (string)$data['name']; }
    }
    $zip->close();
    return '';
}

$db = new DataBase();
$db->connect();
$payload = json_decode(file_get_contents('${payloadPath}'), true);
if (!is_array($payload)) throw new RuntimeException('Invalid blueprint plugin payload.');

$result = ['ok' => true, 'plugins' => []];
foreach ($payload['plugins'] ?? [] as $item) {
    $name = (string)($item['name'] ?? '');
    $zipPath = isset($item['zipPath']) ? (string)$item['zipPath'] : '';
    $shouldEnable = !empty($item['shouldEnable']);
    $resolvedName = $name;

    $entry = ['name' => $name, 'installed' => false, 'enabled' => false];
    if ($zipPath !== '') {
        if (empty($resolvedName)) {
            $resolvedName = pluginNameFromZip($zipPath);
            $entry['name'] = $resolvedName;
        }
        if (!Plugins::add($zipPath, basename($zipPath), true)) throw new RuntimeException('Failed to install plugin ' . ($resolvedName ?: $zipPath) . ' from ' . $zipPath);
        $entry['installed'] = true;
    } elseif (null === Plugins::get($resolvedName)) {
        throw new RuntimeException('Plugin ' . $resolvedName . ' is not available in the current runtime.');
    }

    if (empty($resolvedName)) throw new RuntimeException('Unable to resolve the installed plugin name.');
    if ($shouldEnable && !Plugins::enable($resolvedName)) throw new RuntimeException('Failed to activate plugin ' . $resolvedName . '.');

    $entry['enabled'] = Plugins::isEnabled($resolvedName);
    $result['plugins'][] = $entry;
}
header('Content-Type: application/json');
echo json_encode($result);
`;
}

function buildSeedScript({ fsRoot, payloadPath }) {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');
define('FS_FOLDER', '${fsRoot}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';
use FacturaScripts\\Core\\Model\\Cliente;
use FacturaScripts\\Core\\Model\\Producto;
use FacturaScripts\\Core\\Model\\Proveedor;
use FacturaScripts\\Core\\Base\\DataBase;

$db = new DataBase();
$db->connect();
$payload = json_decode(file_get_contents('${payloadPath}'), true);
if (!is_array($payload)) throw new RuntimeException('Invalid blueprint seed payload.');

function apply_fields($model, array $data, array $allowed): void {
    foreach ($allowed as $field) {
        if (array_key_exists($field, $data)) $model->$field = $data[$field];
    }
}
function upsert_cliente(array $data): string {
    $code = trim((string)($data['codcliente'] ?? ''));
    if ($code === '') throw new RuntimeException('Seed customer entry requires codcliente.');
    $model = Cliente::findWhereEq('codcliente', $code) ?? new Cliente();
    $mode = $model->primaryColumnValue() ? 'updated' : 'created';
    apply_fields($model, $data, ['codcliente', 'nombre', 'razonsocial', 'cifnif', 'email', 'telefono1', 'telefono2', 'direccion', 'apartado', 'codpostal', 'ciudad', 'provincia', 'codpais', 'observaciones', 'web']);
    if (!$model->save()) throw new RuntimeException('Failed to save customer ' . $code . '.');
    return $mode;
}
function upsert_proveedor(array $data): string {
    $code = trim((string)($data['codproveedor'] ?? ''));
    if ($code === '') throw new RuntimeException('Seed supplier entry requires codproveedor.');
    $model = Proveedor::findWhereEq('codproveedor', $code) ?? new Proveedor();
    $mode = $model->primaryColumnValue() ? 'updated' : 'created';
    apply_fields($model, $data, ['codproveedor', 'nombre', 'razonsocial', 'cifnif', 'email', 'telefono1', 'telefono2', 'direccion', 'apartado', 'codpostal', 'ciudad', 'provincia', 'codpais', 'observaciones', 'web']);
    if (!$model->save()) throw new RuntimeException('Failed to save supplier ' . $code . '.');
    return $mode;
}
function upsert_producto(array $data): string {
    $reference = trim((string)($data['referencia'] ?? ''));
    if ($reference === '') throw new RuntimeException('Seed product entry requires referencia.');
    $model = Producto::findWhereEq('referencia', $reference) ?? new Producto();
    $mode = $model->idproducto ? 'updated' : 'created';
    apply_fields($model, $data, ['referencia', 'descripcion', 'precio', 'observaciones', 'codfamilia', 'codfabricante', 'codimpuesto', 'excepcioniva', 'sevende', 'secompra', 'nostock', 'publico', 'ventasinstock', 'stockfis']);
    if (!$model->save()) throw new RuntimeException('Failed to save product ' . $reference . '.');
    return $mode;
}

$result = ['ok' => true, 'customers' => ['created' => 0, 'updated' => 0], 'suppliers' => ['created' => 0, 'updated' => 0], 'products' => ['created' => 0, 'updated' => 0]];
foreach ($payload['customers'] ?? [] as $entry) { $mode = upsert_cliente($entry); $result['customers'][$mode]++; }
foreach ($payload['suppliers'] ?? [] as $entry) { $mode = upsert_proveedor($entry); $result['suppliers'][$mode]++; }
foreach ($payload['products'] ?? [] as $entry) { $mode = upsert_producto($entry); $result['products'][$mode]++; }

header('Content-Type: application/json');
echo json_encode($result);
`;
}

async function runPhpScript({ php, scriptPath, scriptContents }) {
  await php.writeFile(scriptPath, encoder.encode(scriptContents));
  try {
    const response = await php.request(
      new Request(
        `http://localhost${scriptPath.replace(/^\/www\/facturascripts/iu, "")}`,
      ),
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `PHP script ${scriptPath} failed with status ${response.status}: ${text}`,
      );
    return text;
  } finally {
    try {
      await php.unlink(scriptPath);
    } catch {}
  }
}

async function installAndActivatePlugins({
  php,
  fsRoot,
  publish,
  blueprint,
  proxyBaseUrl,
}) {
  const pluginResults = [];
  if (!blueprint.plugins?.length) return pluginResults;

  await ensureDir(php, PLUGIN_DOWNLOAD_DIR);
  publish("Resolving blueprint plugins.", 0.76);

  for (const plugin of blueprint.plugins) {
    const targetDir = `${fsRoot}/Plugins/${plugin.name}`;
    const sources = buildPluginSourceList(plugin);
    let zipPath = null;
    const requiresDownload =
      plugin.source?.type === "url" &&
      (!plugin.name || !(await pathExists(php, targetDir)));

    if (requiresDownload && sources.length > 0) {
      const sourceUrl = sources[0];
      publish(`Downloading plugin ${plugin.name || sourceUrl}.`, 0.78);
      const bytes = await fetchPluginArchive(
        sourceUrl,
        plugin.name || sourceUrl,
        proxyBaseUrl,
      );
      const zipFileName = `${sanitizeSegment(plugin.name || sourceUrl, "plugin")}.zip`;
      zipPath = `${PLUGIN_DOWNLOAD_DIR}/${zipFileName}`;
      await php.writeFile(zipPath, bytes);
    } else if (
      plugin.source?.type === "bundled" &&
      !(await pathExists(php, targetDir))
    ) {
      throw new Error(
        `Blueprint plugin "${plugin.name}" is not available in the bundled runtime and no ZIP URL was provided.`,
      );
    }

    pluginResults.push({
      name: plugin.name,
      zipPath,
      shouldEnable: plugin.state === "activate",
      source: plugin.source,
    });
  }

  if (!pluginResults.length) return pluginResults;

  await php.writeFile(
    BLUEPRINT_PAYLOAD_PATH,
    encoder.encode(
      JSON.stringify({ plugins: buildPluginOps(pluginResults) }, null, 2),
    ),
  );
  const text = await runPhpScript({
    php,
    scriptPath: `${fsRoot}/_playground_blueprint_plugins.php`,
    scriptContents: buildPluginScript({
      fsRoot,
      payloadPath: BLUEPRINT_PAYLOAD_PATH,
    }),
  });
  const result = JSON.parse(text);
  if (!result?.ok)
    throw new Error(`Plugin blueprint execution failed: ${text}`);

  return (
    result.plugins ||
    pluginResults.map((entry) => ({
      name: entry.name,
      installed: Boolean(entry.zipPath),
      enabled: entry.shouldEnable,
    }))
  );
}

async function applySeedData({ php, fsRoot, publish, blueprint }) {
  const seedPayload = buildSeedPayload(blueprint);
  const totalEntries =
    seedPayload.customers.length +
    seedPayload.suppliers.length +
    seedPayload.products.length;
  if (totalEntries === 0) return null;

  publish("Seeding demo customers, suppliers, and products.", 0.84);
  await php.writeFile(
    BLUEPRINT_PAYLOAD_PATH,
    encoder.encode(JSON.stringify(seedPayload, null, 2)),
  );
  const text = await runPhpScript({
    php,
    scriptPath: `${fsRoot}/_playground_blueprint_seed.php`,
    scriptContents: buildSeedScript({
      fsRoot,
      payloadPath: BLUEPRINT_PAYLOAD_PATH,
    }),
  });
  const result = JSON.parse(text);
  if (!result?.ok) throw new Error(`Blueprint seed execution failed: ${text}`);
  return result;
}

export async function materializeBlueprintAddons({
  php,
  blueprint,
  fsRoot,
  publish,
  config,
  manifestVersion,
}) {
  const blueprintFingerprint = JSON.stringify({
    plugins: blueprint.plugins || [],
    seed: buildSeedPayload(blueprint),
  });
  const blueprintHash = await sha256Text(blueprintFingerprint);

  let existingState = null;
  if (await pathExists(php, BLUEPRINT_STATE_PATH)) {
    const raw = await php.readFile(BLUEPRINT_STATE_PATH);
    existingState = JSON.parse(decoder.decode(raw));
  }

  if (
    existingState?.manifestVersion === manifestVersion &&
    existingState?.blueprintHash === blueprintHash
  ) {
    publish(
      "Blueprint plugins and demo seed already match persisted state.",
      0.74,
    );
    return existingState;
  }

  const pluginResults = await installAndActivatePlugins({
    php,
    fsRoot,
    publish,
    blueprint,
    proxyBaseUrl: resolveProxyUrl(config),
  });
  const seedSummary = await applySeedData({ php, fsRoot, publish, blueprint });

  const nextState = buildBlueprintMaterializationState({
    manifestVersion,
    blueprintHash,
    pluginResults,
    seedSummary,
  });
  await php.writeFile(
    BLUEPRINT_STATE_PATH,
    encoder.encode(JSON.stringify(nextState, null, 2)),
  );
  await removeNodeIfPresent(php, BLUEPRINT_PAYLOAD_PATH);

  return nextState;
}
