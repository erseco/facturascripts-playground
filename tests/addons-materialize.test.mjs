import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { materializeBlueprintAddons } from "../src/runtime/addons.js";

const FS_ROOT = "/www/facturascripts";
const STATE_PATH = "/persist/mutable/config/blueprint-state.json";
const PAYLOAD_PATH = "/tmp/blueprint-payload.json";
const decoder = new TextDecoder();
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// In-memory PHP stand-in: records files, dirs and requests; `respond` maps a
// request pathname to the PHP script's {status, body}.
function fakePhp({
  respond = () => ({ body: '{"ok":true}' }),
  dirs = [],
} = {}) {
  const files = new Map();
  const existing = new Set(dirs);
  const php = {
    files,
    dirs: existing,
    requests: [],
    // Snapshot of each script and its payload at request time.
    runs: [],
    unlinked: [],
    async analyzePath(path) {
      return { exists: existing.has(path) || files.has(path) };
    },
    async mkdir(path) {
      if (path === "/persist") throw new Error("EEXIST");
      existing.add(path);
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async readFile(path) {
      return files.get(path);
    },
    async unlink(path) {
      php.unlinked.push(path);
      if (!files.delete(path)) throw new Error("ENOENT");
    },
    async request(request) {
      const { pathname } = new URL(request.url);
      php.requests.push(pathname);
      php.runs.push({
        script: decoder.decode(files.get(`${FS_ROOT}${pathname}`)),
        payload: JSON.parse(decoder.decode(files.get(PAYLOAD_PATH))),
      });
      const { status = 200, body } = respond(pathname);
      return new Response(body, { status });
    },
  };
  return php;
}

function run(php, blueprint, extra = {}) {
  const progress = [];
  return materializeBlueprintAddons({
    php,
    blueprint,
    fsRoot: FS_ROOT,
    publish: (message, value) => progress.push([message, value]),
    config: {},
    manifestVersion: "v1",
    ...extra,
  }).then((state) => ({ state, progress }));
}

describe("materializeBlueprintAddons", () => {
  it("does nothing but persist state for an empty blueprint", async () => {
    const php = fakePhp();
    const { state, progress } = await run(php, {});
    assert.equal(php.requests.length, 0);
    assert.deepEqual(progress, []);
    assert.equal(state.manifestVersion, "v1");
    assert.match(state.blueprintHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(state.plugins, []);
    assert.equal(state.seed, null);
    assert.equal(state.settings, null);
    assert.deepEqual(
      JSON.parse(decoder.decode(php.files.get(STATE_PATH))),
      state,
    );
    // No payload was written, so nothing to remove.
    assert.equal(php.unlinked.includes(PAYLOAD_PATH), false);
  });

  it("skips all work when the persisted state matches", async () => {
    const blueprint = { settings: { default: { codpais: "ESP" } } };
    const first = fakePhp({ respond: () => ({ body: '{"ok":true}' }) });
    const { state } = await run(first, blueprint);

    const php = fakePhp();
    php.files.set(STATE_PATH, first.files.get(STATE_PATH));
    const { state: again, progress } = await run(php, blueprint);
    assert.deepEqual(again, state);
    assert.equal(php.requests.length, 0);
    assert.match(progress[0][0], /already match persisted state/u);

    // A new manifest version re-applies the blueprint.
    const { progress: rerun } = await run(php, blueprint, {
      manifestVersion: "v2",
    });
    assert.deepEqual(php.requests, ["/_playground_blueprint_settings.php"]);
    assert.equal(rerun[0][0], "Applying blueprint settings.");
  });

  it("downloads URL plugins through the proxy and installs them", async () => {
    const fetched = [];
    globalThis.fetch = async (url, init) => {
      fetched.push({ url, init });
      return new Response(new Uint8Array([80, 75, 3, 4]));
    };
    const php = fakePhp({
      dirs: [`${FS_ROOT}/Plugins/Present`],
      respond: () => ({
        body: JSON.stringify({
          ok: true,
          plugins: [{ name: "Demo", installed: true, enabled: true }],
        }),
      }),
    });
    const { state, progress } = await run(
      php,
      {
        plugins: [
          {
            name: "Demo",
            state: "activate",
            source: { type: "url", url: "https://example.test/demo.zip" },
          },
          // Already on disk: no download, still enabled through PHP.
          {
            name: "Present",
            state: "install",
            source: { type: "url", url: "https://example.test/p.zip" },
          },
          // Bundled and present: passes through without a ZIP.
          { name: "Present", source: { type: "bundled" } },
        ],
      },
      { config: { proxyUrl: "https://proxy.test/fetch" } },
    );

    assert.equal(fetched.length, 1);
    const proxied = new URL(fetched[0].url);
    assert.equal(proxied.origin + proxied.pathname, "https://proxy.test/fetch");
    assert.equal(
      proxied.searchParams.get("url"),
      "https://example.test/demo.zip",
    );
    assert.equal(fetched[0].init.cache, "no-store");
    assert.deepEqual(
      [...php.files.get("/persist/addons/downloads/Demo.zip")],
      [80, 75, 3, 4],
    );
    assert.ok(php.dirs.has("/persist/addons/downloads"));

    const [{ script, payload }] = php.runs;
    assert.deepEqual(payload.plugins, [
      {
        name: "Demo",
        zipPath: "/persist/addons/downloads/Demo.zip",
        shouldEnable: true,
      },
      { name: "Present", zipPath: "", shouldEnable: false },
      { name: "Present", zipPath: "", shouldEnable: false },
    ]);
    assert.match(script, /define\('FS_FOLDER', '\/www\/facturascripts'\)/u);
    assert.match(
      script,
      /file_get_contents\('\/tmp\/blueprint-payload\.json'\)/u,
    );
    assert.match(script, /Plugins::enable\(\$resolvedName\)/u);

    assert.deepEqual(state.plugins, [
      { name: "Demo", installed: true, enabled: true },
    ]);
    assert.deepEqual(
      progress.map(([message]) => message),
      ["Resolving blueprint plugins.", "Downloading plugin Demo."],
    );
    // Script and payload are cleaned up.
    assert.equal(
      php.files.has(`${FS_ROOT}/_playground_blueprint_plugins.php`),
      false,
    );
    assert.equal(php.files.has(PAYLOAD_PATH), false);
  });

  it("names unnamed URL plugins after a sanitized source URL and falls back to local results", async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([1]));
    const php = fakePhp({ respond: () => ({ body: '{"ok":true}' }) });
    const { state, progress } = await run(php, {
      plugins: [
        {
          state: "activate",
          source: { type: "url", url: "https://x.test/a.zip" },
        },
      ],
    });
    const zipPath = "/persist/addons/downloads/https___x_test_a_zip.zip";
    assert.ok(php.files.has(zipPath));
    assert.equal(progress[1][0], "Downloading plugin https://x.test/a.zip.");
    // PHP returned no plugin list: results come from the JS-side plan.
    assert.deepEqual(state.plugins, [
      { name: undefined, installed: true, enabled: true },
    ]);
  });

  it("rejects a bundled plugin that is missing from the runtime", async () => {
    const php = fakePhp();
    await assert.rejects(
      run(php, { plugins: [{ name: "Ghost", source: { type: "bundled" } }] }),
      /Blueprint plugin "Ghost" is not available in the bundled runtime/u,
    );
    assert.equal(php.requests.length, 0);
  });

  it("retries a transient 502 once and reports a clear 404", async () => {
    const statuses = [502, 404];
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("", { status: statuses.shift() });
    };
    const php = fakePhp();
    await assert.rejects(
      run(php, {
        plugins: [
          {
            name: "Gone",
            source: { type: "url", url: "https://x.test/g.zip" },
          },
        ],
      }),
      /Failed to fetch https:\/\/x\.test\/g\.zip: 404 not found/u,
    );
    assert.equal(calls, 2);
  });

  it("surfaces PHP failures with status, body and not-ok results", async () => {
    const plugins = [{ name: "Present", source: { type: "bundled" } }];
    const dirs = [`${FS_ROOT}/Plugins/Present`];
    const failing = fakePhp({
      dirs,
      respond: () => ({ status: 500, body: "Fatal error" }),
    });
    await assert.rejects(
      run(failing, { plugins }),
      /PHP script \/www\/facturascripts\/_playground_blueprint_plugins\.php failed with status 500: Fatal error/u,
    );
    // The script is removed even when PHP fails.
    assert.equal(
      failing.files.has(`${FS_ROOT}/_playground_blueprint_plugins.php`),
      false,
    );

    const notOk = () =>
      fakePhp({ dirs, respond: () => ({ body: '{"ok":false}' }) });
    await assert.rejects(
      run(notOk(), { plugins }),
      /Plugin blueprint execution failed: \{"ok":false\}/u,
    );
    await assert.rejects(
      run(notOk(), { seed: { products: [{ referencia: "A" }] } }),
      /Blueprint seed execution failed/u,
    );
    await assert.rejects(
      run(notOk(), { settings: { default: { a: 1 } } }),
      /Blueprint settings execution failed/u,
    );
  });

  it("seeds data and applies settings with dedicated scripts", async () => {
    const seedResult = {
      ok: true,
      customers: { created: 1, updated: 0 },
      suppliers: { created: 0, updated: 1 },
      products: { created: 1, updated: 0 },
    };
    const settingsResult = { ok: true, groups: 1, keys: 2 };
    const php = fakePhp({
      respond: (path) => ({
        body: JSON.stringify(
          path.endsWith("_seed.php") ? seedResult : settingsResult,
        ),
      }),
    });
    const blueprint = {
      seed: {
        customers: [{ codcliente: "C1", nombre: "Ana" }],
        suppliers: [{ codproveedor: "P1" }],
        products: [{ referencia: "R1", precio: 3 }],
      },
      settings: { default: { codpais: "ESP", coddivisa: "EUR" } },
    };
    const { state, progress } = await run(php, blueprint);

    assert.deepEqual(php.requests, [
      "/_playground_blueprint_seed.php",
      "/_playground_blueprint_settings.php",
    ]);
    const [seedRun, settingsRun] = php.runs;
    assert.deepEqual(seedRun.payload, blueprint.seed);
    assert.match(seedRun.script, /function upsert_producto/u);
    assert.deepEqual(settingsRun.payload, { settings: blueprint.settings });
    assert.match(settingsRun.script, /Tools::settingsSave\(\);/u);

    assert.deepEqual(state.seed, seedResult);
    assert.deepEqual(state.settings, settingsResult);
    assert.deepEqual(
      progress.map(([, value]) => value),
      [0.84, 0.86],
    );
    assert.equal(php.files.has(PAYLOAD_PATH), false);
  });
});
