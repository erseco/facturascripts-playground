import { crc32 } from "node:zlib";
import { expect, test } from "@playwright/test";

// OPcache's file cache (file_cache_only) is inert under php-wasm's `wasm` SAPI
// on PHP 8.3 and live by default (or `?opcache=1`), which reports the `uwsgi`
// SAPI name. Both rows pass the flag explicitly so the config default cannot
// make them pass vacuously.
// opcache_reset()/opcache_invalidate() are no-ops in this mode, so a PHP file
// compiled once and then rewritten must execute its new code on the next
// request purely through timestamp validation. The plain row proves the
// plumbing (and that the SAPI name is untouched); the `opcache` row is the real
// canary: it asserts the cache is active so it cannot pass vacuously.
// Blueprints have no writeFile step, so the canary ships as a plugin ZIP that
// the test serves in place of the addon proxy (the dev server's same-origin
// /__addon_proxy__ or the deployed zip-proxy worker).
test.describe.configure({ timeout: 420_000 });

const PLUGIN = "OpCanary";

const canaryIndex = `<?php
header('Content-Type: application/json');
$target = __DIR__ . '/target.php';
if (($_GET['step'] ?? '1') === '1') {
    // Older than opcache.file_update_protection so the first compile is stored.
    touch($target, time() - 10);
} else {
    file_put_contents($target, "<?php return 'v2';");
}
clearstatcache();
$value = include $target;
$status = function_exists('opcache_get_status') ? opcache_get_status(false) : null;
echo json_encode([
    'value' => $value,
    'fileCacheOnly' => is_array($status) && !empty($status['file_cache_only']),
    'php' => PHP_VERSION,
    'sapi' => PHP_SAPI,
]);`;

// Minimal stored (uncompressed) ZIP: enough for PHP's ZipArchive.
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const pluginZip = buildZip({
  [`${PLUGIN}/facturascripts.ini`]: `name = '${PLUGIN}'\ndescription = 'OPcache canary'\nversion = 1\nmin_version = 2025\n`,
  [`${PLUGIN}/canary.php`]: canaryIndex,
  [`${PLUGIN}/target.php`]: "<?php return 'v1';",
});

function buildBlueprintData() {
  const payload = {
    meta: { title: "OPcache canary" },
    plugins: [`https://example.org/${PLUGIN}.zip`],
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function waitForScopedFrame(page) {
  await expect
    .poll(
      () =>
        page
          .frames()
          .find((frame) => /\/playground\/[^/]+\/[^/]+/.test(frame.url()))
          ? true
          : null,
      { timeout: 300_000 },
    )
    .toBe(true);
  return page
    .frames()
    .find((frame) => /\/playground\/[^/]+\/[^/]+/.test(frame.url()));
}

for (const opcache of [false, true]) {
  test(`rewritten PHP files recompile on PHP 8.3 with ?opcache=${opcache ? 1 : 0}`, async ({
    page,
    context,
  }) => {
    const manifest = await page.request.get("assets/manifests/latest.json");
    test.skip(!manifest.ok(), "no core bundle is built here");

    const servePlugin = (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/zip",
        headers: { "access-control-allow-origin": "*" },
        body: pluginZip,
      });
    await context.route("**/__addon_proxy__?**", servePlugin);
    await context.route("https://zip-proxy.erseco.workers.dev/**", servePlugin);
    await page.goto(
      `/?opcache=${opcache ? 1 : 0}&scope=opcanary-${crypto.randomUUID()}&blueprint-data=${buildBlueprintData()}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.locator("#address-input")).toBeEnabled({
      timeout: 300_000,
    });
    const frame = await waitForScopedFrame(page);

    const call = (step) =>
      frame.evaluate(
        async ({ step, plugin }) => {
          const prefix = location.pathname.match(
            /^.*\/playground\/[^/]+\/[^/]+/u,
          )[0];
          const response = await fetch(
            `${prefix}/Plugins/${plugin}/canary.php?step=${step}`,
            { cache: "no-store" },
          );
          return { status: response.status, body: await response.text() };
        },
        { step, plugin: PLUGIN },
      );

    let first;
    await expect
      .poll(
        async () => {
          first = await call(1);
          return first.status;
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe(200);
    const compiled = JSON.parse(first.body);
    expect(compiled.php.startsWith("8.3")).toBe(true);
    expect(compiled.value).toBe("v1");
    expect(compiled.sapi).toBe(opcache ? "uwsgi" : "wasm");
    expect(compiled.fileCacheOnly, "OPcache file cache is live").toBe(opcache);

    const second = await call(2);
    expect(second.status, second.body).toBe(200);
    expect(JSON.parse(second.body).value).toBe("v2");
  });
}
