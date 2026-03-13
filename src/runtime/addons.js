const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BLUEPRINT_STATE_PATH = "/persist/mutable/config/blueprint-state.json";
const BLUEPRINT_PAYLOAD_PATH = "/persist/mutable/config/blueprint-payload.json";
const PLUGIN_DOWNLOAD_DIR = "/persist/mutable/plugins";

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

function writeFileSafe(FS, path, content) {
  const parentDir = path.split("/").slice(0, -1).join("/") || "/";
  ensureDirSync(FS, parentDir);
  FS.writeFile(path, typeof content === "string" ? encoder.encode(content) : content);
}

function readJsonFile(FS, path) {
  try {
    if (!FS.analyzePath(path)?.exists) {
      return null;
    }
    return JSON.parse(decoder.decode(FS.readFile(path)));
  } catch {
    return null;
  }
}

function pathExists(FS, path) {
  return Boolean(FS.analyzePath(path)?.exists);
}

function removeNodeIfPresent(FS, path) {
  const about = FS.analyzePath(path);
  if (!about?.exists) {
    return;
  }

  const mode = about.object?.mode;
  if (typeof mode === "number" && FS.isDir(mode)) {
    for (const entry of FS.readdir(path)) {
      if (entry === "." || entry === "..") {
        continue;
      }
      removeNodeIfPresent(FS, `${path}/${entry}`.replace(/\/{2,}/gu, "/"));
    }
    FS.rmdir(path);
    return;
  }

  FS.unlink(path);
}

function sanitizeSegment(value, fallback = "plugin") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || fallback;
}

async function sha256Text(value) {
  const bytes = encoder.encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchPluginArchive(sourceUrl, label) {
  const resolvedUrl = await resolvePluginDownloadUrl(sourceUrl, label);
  const response = await fetch(resolvedUrl, { cache: "no-store" });
  if (!response.ok) {
    let detail = `${response.status}`;
    const contentType = response.headers.get("content-type") || "";
    try {
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        detail = payload?.details
          ? `${response.status} ${payload.error || "Proxy error"}: ${payload.details}`
          : `${response.status} ${payload?.error || "Proxy error"}`;
      } else {
        const text = await response.text();
        if (text.trim()) {
          detail = `${response.status}: ${text.trim()}`;
        }
      }
    } catch {
      // Keep the plain status when the body cannot be read.
    }
    throw new Error(`Unable to download plugin ${label} from ${resolvedUrl}: ${detail}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Downloaded plugin ${label} from ${resolvedUrl} is empty.`);
  }
  return bytes;
}

function isFacturaScriptsPluginPageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.hostname === "facturascripts.com"
      && /^\/plugins\/[^/]+\/?$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function buildGitHubArchiveUrl(sourceUrl) {
  let url;
  try {
    url = new URL(String(sourceUrl || ""));
  } catch {
    return null;
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const [owner, repo, kind, ...rest] = parts;
  const cleanRepo = repo.replace(/\.git$/iu, "");
  const repoBase = `https://github.com/${owner}/${cleanRepo}`;

  if (!kind) {
    return null;
  }

  if (kind === "archive") {
    return sourceUrl;
  }

  if (kind === "tree" && rest.length > 0) {
    const branch = rest.join("/");
    return `${repoBase}/archive/refs/heads/${branch}.zip`;
  }

  if (kind === "pull" && rest.length > 0) {
    const pullNumber = rest[0];
    if (!/^\d+$/u.test(pullNumber)) {
      return null;
    }
    return `https://codeload.github.com/${owner}/${cleanRepo}/zip/refs/pull/${pullNumber}/head`;
  }

  if (kind === "releases" && rest[0] === "download" && rest.length >= 2) {
    return sourceUrl;
  }

  return null;
}

function extractFacturaScriptsDownloadUrl(html, sourceUrl) {
  const match = String(html || "").match(/href=["']([^"']*\/DownloadBuild\/\d+\/(?:stable|beta)[^"']*)["']/iu);
  if (!match?.[1]) {
    throw new Error(`Unable to find a DownloadBuild link in ${sourceUrl}.`);
  }
  return new URL(match[1], sourceUrl).toString();
}

async function resolvePluginDownloadUrl(sourceUrl, label) {
  const githubArchiveUrl = buildGitHubArchiveUrl(sourceUrl);
  if (githubArchiveUrl) {
    return githubArchiveUrl;
  }

  if (!isFacturaScriptsPluginPageUrl(sourceUrl)) {
    return sourceUrl;
  }

  const response = await fetch(sourceUrl, {
    cache: "no-store",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Unable to resolve plugin page ${sourceUrl} for ${label}: ${response.status}`);
  }

  const html = await response.text();
  return extractFacturaScriptsDownloadUrl(html, sourceUrl);
}

function buildPluginSourceList(plugin) {
  if (plugin.source?.type === "url") {
    return [plugin.source.url];
  }

  if (plugin.source?.type === "bundled") {
    return [];
  }

  return [];
}

function buildBlueprintMaterializationState({ manifestVersion, blueprintHash, pluginResults, seedSummary }) {
  return {
    manifestVersion,
    blueprintHash,
    appliedAt: new Date().toISOString(),
    plugins: pluginResults,
    seed: seedSummary,
  };
}

function buildPluginOps(pluginResults) {
  return pluginResults.map((entry) => ({
    name: entry.name,
    zipPath: entry.zipPath || null,
    shouldEnable: entry.shouldEnable === true,
  }));
}

function buildSeedPayload(blueprint) {
  return {
    customers: blueprint.seed?.customers || [],
    suppliers: blueprint.seed?.suppliers || [],
    products: blueprint.seed?.products || [],
  };
}

function buildPluginScript({ fsRoot, payloadPath, operation }) {
  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

define('FS_FOLDER', '${fsRoot}');
require_once FS_FOLDER . '/config.php';
require_once FS_FOLDER . '/vendor/autoload.php';

use FacturaScripts\\Core\\Plugins;
use FacturaScripts\\Core\\Internal\\Plugin;

$payload = json_decode(file_get_contents('${payloadPath}'), true);
if (!is_array($payload)) {
    throw new RuntimeException('Invalid blueprint plugin payload.');
}

$result = [
    'ok' => true,
    'plugins' => [],
];

foreach ($payload['plugins'] ?? [] as $item) {
    $name = (string)($item['name'] ?? '');
    $zipPath = isset($item['zipPath']) ? (string)$item['zipPath'] : '';
    $shouldEnable = !empty($item['shouldEnable']);
    $resolvedName = $name;

    $entry = [
        'name' => $name,
        'installed' => false,
        'enabled' => false,
    ];

    if ($zipPath !== '') {
        $pluginFromZip = Plugin::getFromZip($zipPath);
        if ($pluginFromZip && empty($resolvedName)) {
            $resolvedName = $pluginFromZip->name;
            $entry['name'] = $resolvedName;
        }
        if (!Plugins::add($zipPath, basename($zipPath), true)) {
            throw new RuntimeException('Failed to install plugin ' . ($resolvedName ?: $zipPath) . ' from ' . $zipPath);
        }
        $entry['installed'] = true;
    } elseif (null === Plugins::get($resolvedName)) {
        throw new RuntimeException('Plugin ' . $resolvedName . ' is not available in the current runtime.');
    }

    if (empty($resolvedName)) {
        throw new RuntimeException('Unable to resolve the installed plugin name.');
    }

    if ($shouldEnable && !Plugins::enable($resolvedName)) {
        throw new RuntimeException('Failed to activate plugin ' . $resolvedName . '.');
    }

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

$payload = json_decode(file_get_contents('${payloadPath}'), true);
if (!is_array($payload)) {
    throw new RuntimeException('Invalid blueprint seed payload.');
}

function apply_fields($model, array $data, array $allowed): void
{
    foreach ($allowed as $field) {
        if (array_key_exists($field, $data)) {
            $model->$field = $data[$field];
        }
    }
}

function upsert_cliente(array $data): string
{
    $code = trim((string)($data['codcliente'] ?? ''));
    if ($code === '') {
        throw new RuntimeException('Seed customer entry requires codcliente.');
    }

    $model = Cliente::findWhereEq('codcliente', $code) ?? new Cliente();
    $mode = $model->primaryColumnValue() ? 'updated' : 'created';
    apply_fields($model, $data, [
        'codcliente', 'nombre', 'razonsocial', 'cifnif', 'email', 'telefono1', 'telefono2',
        'direccion', 'apartado', 'codpostal', 'ciudad', 'provincia', 'codpais', 'observaciones',
        'web'
    ]);
    if (!$model->save()) {
        throw new RuntimeException('Failed to save customer ' . $code . '.');
    }
    return $mode;
}

function upsert_proveedor(array $data): string
{
    $code = trim((string)($data['codproveedor'] ?? ''));
    if ($code === '') {
        throw new RuntimeException('Seed supplier entry requires codproveedor.');
    }

    $model = Proveedor::findWhereEq('codproveedor', $code) ?? new Proveedor();
    $mode = $model->primaryColumnValue() ? 'updated' : 'created';
    apply_fields($model, $data, [
        'codproveedor', 'nombre', 'razonsocial', 'cifnif', 'email', 'telefono1', 'telefono2',
        'direccion', 'apartado', 'codpostal', 'ciudad', 'provincia', 'codpais', 'observaciones',
        'web'
    ]);
    if (!$model->save()) {
        throw new RuntimeException('Failed to save supplier ' . $code . '.');
    }
    return $mode;
}

function upsert_producto(array $data): string
{
    $reference = trim((string)($data['referencia'] ?? ''));
    if ($reference === '') {
        throw new RuntimeException('Seed product entry requires referencia.');
    }

    $model = Producto::findWhereEq('referencia', $reference) ?? new Producto();
    $mode = $model->idproducto ? 'updated' : 'created';
    apply_fields($model, $data, [
        'referencia', 'descripcion', 'precio', 'observaciones', 'codfamilia', 'codfabricante',
        'codimpuesto', 'excepcioniva', 'sevende', 'secompra', 'nostock', 'publico',
        'ventasinstock', 'stockfis'
    ]);
    if (!$model->save()) {
        throw new RuntimeException('Failed to save product ' . $reference . '.');
    }
    return $mode;
}

$result = [
    'ok' => true,
    'customers' => ['created' => 0, 'updated' => 0],
    'suppliers' => ['created' => 0, 'updated' => 0],
    'products' => ['created' => 0, 'updated' => 0],
];

foreach ($payload['customers'] ?? [] as $entry) {
    $mode = upsert_cliente($entry);
    $result['customers'][$mode]++;
}
foreach ($payload['suppliers'] ?? [] as $entry) {
    $mode = upsert_proveedor($entry);
    $result['suppliers'][$mode]++;
}
foreach ($payload['products'] ?? [] as $entry) {
    $mode = upsert_producto($entry);
    $result['products'][$mode]++;
}

header('Content-Type: application/json');
echo json_encode($result);
`;
}

async function runPhpScript({ FS, php, scriptPath, scriptContents }) {
  writeFileSafe(FS, scriptPath, scriptContents);
  try {
    const response = await php.request(new Request(`http://localhost${scriptPath.replace(/^\/www\/facturascripts/iu, "")}`));
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PHP script ${scriptPath} failed with status ${response.status}: ${text}`);
    }
    return text;
  } finally {
    try {
      FS.unlink(scriptPath);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function installAndActivatePlugins({ FS, php, fsRoot, publish, blueprint }) {
  const pluginResults = [];
  if (!blueprint.plugins.length) {
    return pluginResults;
  }

  ensureDirSync(FS, PLUGIN_DOWNLOAD_DIR);
  publish("Resolving blueprint plugins.", 0.76);

  for (const plugin of blueprint.plugins) {
    const targetDir = `${fsRoot}/Plugins/${plugin.name}`;
    const sources = buildPluginSourceList(plugin);
    let zipPath = null;
    const requiresDownload = plugin.source?.type === "url"
      && (!plugin.name || !pathExists(FS, targetDir));

    if (requiresDownload && sources.length > 0) {
      const sourceUrl = sources[0];
      publish(`Downloading plugin ${plugin.name || sourceUrl}.`, 0.78);
      const bytes = await fetchPluginArchive(sourceUrl, plugin.name || sourceUrl);
      const zipFileName = `${sanitizeSegment(plugin.name || sourceUrl, "plugin")}.zip`;
      zipPath = `${PLUGIN_DOWNLOAD_DIR}/${zipFileName}`;
      writeFileSafe(FS, zipPath, bytes);
    } else if (plugin.source?.type === "bundled" && !pathExists(FS, targetDir)) {
      throw new Error(`Blueprint plugin "${plugin.name}" is not available in the bundled runtime and no ZIP URL was provided.`);
    }

    pluginResults.push({
      name: plugin.name,
      zipPath,
      shouldEnable: plugin.state === "activate",
      source: plugin.source,
    });
  }

  if (!pluginResults.length) {
    return pluginResults;
  }

  writeFileSafe(FS, BLUEPRINT_PAYLOAD_PATH, JSON.stringify({ plugins: buildPluginOps(pluginResults) }, null, 2));
  const text = await runPhpScript({
    FS,
    php,
    scriptPath: `${fsRoot}/_playground_blueprint_plugins.php`,
    scriptContents: buildPluginScript({
      fsRoot,
      payloadPath: BLUEPRINT_PAYLOAD_PATH,
    }),
  });

  const result = JSON.parse(text);
  if (!result?.ok) {
    throw new Error(`Plugin blueprint execution failed: ${text}`);
  }

  return result.plugins || pluginResults.map((entry) => ({
    name: entry.name,
    installed: Boolean(entry.zipPath),
    enabled: entry.shouldEnable,
  }));
}

async function applySeedData({ FS, php, fsRoot, publish, blueprint }) {
  const seedPayload = buildSeedPayload(blueprint);
  const totalEntries = seedPayload.customers.length + seedPayload.suppliers.length + seedPayload.products.length;
  if (totalEntries === 0) {
    return null;
  }

  publish("Seeding demo customers, suppliers, and products.", 0.84);
  writeFileSafe(FS, BLUEPRINT_PAYLOAD_PATH, JSON.stringify(seedPayload, null, 2));

  const text = await runPhpScript({
    FS,
    php,
    scriptPath: `${fsRoot}/_playground_blueprint_seed.php`,
    scriptContents: buildSeedScript({
      fsRoot,
      payloadPath: BLUEPRINT_PAYLOAD_PATH,
    }),
  });

  const result = JSON.parse(text);
  if (!result?.ok) {
    throw new Error(`Blueprint seed execution failed: ${text}`);
  }
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
  const binary = await php.binary;
  const { FS } = binary;
  const blueprintFingerprint = JSON.stringify({
    plugins: blueprint.plugins,
    seed: buildSeedPayload(blueprint),
  });
  const blueprintHash = await sha256Text(blueprintFingerprint);
  const existingState = readJsonFile(FS, BLUEPRINT_STATE_PATH);

  if (existingState?.manifestVersion === manifestVersion && existingState?.blueprintHash === blueprintHash) {
    publish("Blueprint plugins and demo seed already match persisted state.", 0.74);
    return existingState;
  }

  const pluginResults = await installAndActivatePlugins({
    FS,
    php,
    fsRoot,
    publish,
    blueprint,
    config,
  });
  const seedSummary = await applySeedData({
    FS,
    php,
    fsRoot,
    publish,
    blueprint,
  });

  const nextState = buildBlueprintMaterializationState({
    manifestVersion,
    blueprintHash,
    pluginResults,
    seedSummary,
  });
  writeFileSafe(FS, BLUEPRINT_STATE_PATH, JSON.stringify(nextState, null, 2));
  removeNodeIfPresent(FS, BLUEPRINT_PAYLOAD_PATH);

  return nextState;
}
