import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import { buildManifestState, fetchManifest } from "../src/runtime/manifest.js";
import { APP_LOCATION, resolveProxyUrl } from "../src/runtime/networking.js";
import { wrapPhpInstance } from "../src/runtime/php-compat.js";

const ROOT = "/www/facturascripts";
const encoder = new TextEncoder();

// Minimal fake of a @php-wasm/web PHP instance backed by a Map of files.
function fakePhp({ files = {}, dirs = [], response = {}, chdir } = {}) {
  const fileMap = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  const runs = [];
  const listeners = [];
  const php = {
    runs,
    listeners,
    fileMap,
    readFileAsBuffer(path) {
      if (!fileMap.has(path)) throw new Error(`ENOENT ${path}`);
      return encoder.encode(fileMap.get(path));
    },
    fileExists: (path) => fileMap.has(path) || dirSet.has(path),
    isDir: (path) => dirSet.has(path),
    mkdir: (path) => dirSet.add(path),
    writeFile: (path, data) => fileMap.set(path, data),
    async run(args) {
      runs.push(args);
      const next = typeof response === "function" ? response(args) : response;
      return {
        httpStatusCode: 200,
        headers: {},
        bytes: encoder.encode("ok"),
        ...next,
      };
    },
    addEventListener: (type, handler) => listeners.push(["add", type, handler]),
    removeEventListener: (type, handler) =>
      listeners.push(["remove", type, handler]),
  };
  php[__private__dont__use] = chdir
    ? Promise.resolve({ FS: { chdir } })
    : undefined;
  return php;
}

describe("wrapPhpInstance request()", () => {
  it("serves an existing static file with its MIME type and no PHP run", async () => {
    const php = fakePhp({ files: { [`${ROOT}/Core/app.css`]: "body{}" } });
    const response = await wrapPhpInstance(php).request({
      url: "/Core/app.css",
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/css; charset=utf-8",
    );
    assert.equal(await response.text(), "body{}");
    assert.equal(php.runs.length, 0);
  });

  it("uses application/octet-stream for unknown extensions", async () => {
    const php = fakePhp({ files: { [`${ROOT}/blob.bin`]: "x" } });
    const response = await wrapPhpInstance(php).request({ url: "/blob.bin" });
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
  });

  it("routes clean URLs through the front controller with CGI variables", async () => {
    const chdirs = [];
    const php = fakePhp({ chdir: (dir) => chdirs.push(dir) });
    const wrapped = wrapPhpInstance(php, {
      absoluteUrl: "https://demo.test/app/",
    });
    const response = await wrapped.request({
      url: "/Dashboard?page=2",
      method: "POST",
      headers: {
        host: "ignored",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "3",
        "x-custom-thing": "v",
      },
      body: encoder.encode("a=1"),
    });
    assert.equal(await response.text(), "ok");
    const [run] = php.runs;
    assert.equal(run.scriptPath, `${ROOT}/index.php`);
    assert.equal(run.method, "POST");
    assert.equal(run.relativeUri, "/Dashboard?page=2");
    assert.equal(new TextDecoder().decode(run.body), "a=1");
    const env = run.$_SERVER;
    assert.equal(env.SCRIPT_NAME, "/index.php");
    assert.equal(env.QUERY_STRING, "page=2");
    assert.equal(env.REQUEST_METHOD, "POST");
    assert.equal(env.SERVER_NAME, "demo.test");
    assert.equal(env.SERVER_PORT, "443");
    assert.equal(env.HTTPS, "on");
    assert.equal(env.HTTP_HOST, "demo.test");
    assert.equal(env.CONTENT_TYPE, "application/x-www-form-urlencoded");
    assert.equal(env.CONTENT_LENGTH, "3");
    assert.equal(env.HTTP_X_CUSTOM_THING, "v");
    assert.equal("HTTP_HOST_IGNORED" in env, false);
    assert.equal(chdirs[0], ROOT);
  });

  it("runs an existing PHP script with PATH_INFO and a plain-HTTP port", async () => {
    const php = fakePhp({ files: { [`${ROOT}/api/v3.php`]: "<?php" } });
    await wrapPhpInstance(php, {
      absoluteUrl: "http://localhost:9000",
    }).request({ url: "/api/v3.php/products/1" });
    const env = php.runs[0].$_SERVER;
    assert.equal(php.runs[0].scriptPath, `${ROOT}/api/v3.php`);
    assert.equal(php.runs[0].method, "GET");
    assert.equal(env.SCRIPT_NAME, "/api/v3.php");
    assert.equal(env.PATH_INFO, "/products/1");
    assert.equal(env.SERVER_PORT, "9000");
    assert.equal(env.HTTPS, "");
    assert.equal(env.QUERY_STRING, "");
  });

  it("defaults the port per scheme and maps a trailing slash to index.php", async () => {
    const php = fakePhp({ files: { [`${ROOT}/sub/index.php`]: "<?php" } });
    await wrapPhpInstance(php, { absoluteUrl: "http://plain.test" }).request({
      url: "/sub/",
    });
    assert.equal(php.runs[0].scriptPath, `${ROOT}/sub/index.php`);
    assert.equal(php.runs[0].$_SERVER.SERVER_PORT, "80");
  });

  it("falls back to the front controller for a missing PHP script and honours webRoot", async () => {
    const php = fakePhp();
    await wrapPhpInstance(php, { webRoot: "/srv" }).request({
      url: "/missing.php",
    });
    assert.equal(php.runs[0].scriptPath, "/srv/index.php");
    assert.equal(php.runs[0].$_SERVER.DOCUMENT_ROOT, "/srv");
    assert.equal(php.runs[0].relativeUri, "/missing.php");
  });

  it("treats an empty URL as the root", async () => {
    const php = fakePhp();
    await wrapPhpInstance(php).request({});
    assert.equal(php.runs[0].scriptPath, `${ROOT}/index.php`);
    assert.equal(php.runs[0].relativeUri, "/");
  });

  it("survives a failing chdir", async () => {
    const php = fakePhp({
      chdir: () => {
        throw new Error("no dir");
      },
    });
    const response = await wrapPhpInstance(php).request({ url: "/x" });
    assert.equal(response.status, 200);
  });

  it("normalizes a native Request including its body", async () => {
    const php = fakePhp();
    await wrapPhpInstance(php).request(
      new Request("http://localhost:8080/Login?x=1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );
    const [run] = php.runs;
    assert.equal(run.method, "POST");
    assert.equal(run.relativeUri, "/Login?x=1");
    assert.equal(new TextDecoder().decode(run.body), "hello");
    assert.equal(run.headers["content-length"], "5");
    assert.equal(run.$_SERVER.CONTENT_LENGTH, "5");
  });

  it("uses an empty body when reading a native Request body fails", async () => {
    const php = fakePhp();
    const request = new Request("http://localhost:8080/x", {
      method: "PUT",
      body: "data",
    });
    await request.text(); // consume so arrayBuffer() rejects
    await wrapPhpInstance(php).request(request);
    assert.equal(php.runs[0].body.byteLength, 0);
    assert.equal(php.runs[0].headers["content-length"], "0");
  });

  it("does not attach a body to a native GET Request", async () => {
    const php = fakePhp();
    await wrapPhpInstance(php).request(new Request("http://localhost:8080/"));
    assert.equal(php.runs[0].body, undefined);
    assert.equal(php.runs[0].method, "GET");
  });

  it("remembers Set-Cookie values, merges them with request cookies and expires them", async () => {
    const replies = [
      {
        headers: {
          "Set-Cookie": [
            "fsNick=admin; path=/",
            "fsLogkey=abc; HttpOnly",
            "=novalue",
            "broken",
          ],
        },
      },
      {
        headers: {
          "set-cookie": [
            "fsLogkey=gone; Max-Age=0",
            "fsNick=; path=/",
            "old=x; expires=Thu, 01 Jan 1970 00:00:00 GMT",
          ],
        },
      },
      {},
    ];
    const php = fakePhp({ response: () => replies.shift() });
    const wrapped = wrapPhpInstance(php);
    await wrapped.request({ url: "/" });
    assert.equal(php.runs[0].$_SERVER.HTTP_COOKIE, undefined);

    await wrapped.request({ url: "/", headers: { cookie: "lang=es" } });
    assert.equal(
      php.runs[1].$_SERVER.HTTP_COOKIE,
      "lang=es; fsNick=admin; fsLogkey=abc",
    );
    assert.equal(php.runs[1].headers.cookie, php.runs[1].$_SERVER.HTTP_COOKIE);

    await wrapped.request({ url: "/" });
    assert.equal(php.runs[2].$_SERVER.HTTP_COOKIE, undefined);
  });

  it("injects cookies set through setCookie() and deletes empty ones", async () => {
    const php = fakePhp();
    const wrapped = wrapPhpInstance(php);
    wrapped.setCookie("a", "1");
    wrapped.setCookie("b", "2");
    wrapped.setCookie("b", "");
    wrapped.setCookie("c", "3");
    wrapped.setCookie("c", null);
    await wrapped.request({ url: "/" });
    assert.equal(php.runs[0].$_SERVER.HTTP_COOKIE, "a=1");
    assert.equal(php.runs[0].headers.cookie, "a=1");
  });

  it("accepts a PHP response without headers", async () => {
    const php = fakePhp({ response: { headers: undefined } });
    const response = await wrapPhpInstance(php).request({ url: "/" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });

  it("awaits syncFs after each request", async () => {
    let synced = 0;
    const php = fakePhp();
    await wrapPhpInstance(php, { syncFs: async () => synced++ }).request({
      url: "/",
    });
    assert.equal(synced, 1);
  });
});

describe("wrapPhpInstance helpers", () => {
  it("serveStatic returns files, and null for PHP or missing paths", async () => {
    const php = fakePhp({
      files: {
        [`${ROOT}/logo.svg`]: "<svg/>",
        [`${ROOT}/index.php`]: "<?php",
      },
    });
    const wrapped = wrapPhpInstance(php);
    const response = wrapped.serveStatic("/logo.svg");
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    assert.equal(await response.text(), "<svg/>");
    assert.equal(wrapped.serveStatic("/index.php"), null);
    assert.equal(wrapped.serveStatic("/"), null);
    assert.equal(wrapped.serveStatic("/nope.png"), null);
  });

  it("analyzePath reports files, folders, missing paths and errors", async () => {
    const php = fakePhp({ files: { "/f.txt": "x" }, dirs: ["/d"] });
    const wrapped = wrapPhpInstance(php);
    assert.deepEqual(await wrapped.analyzePath("/f.txt"), {
      exists: true,
      object: { isFolder: false, mode: 0o100644 },
    });
    assert.deepEqual(await wrapped.analyzePath("/d"), {
      exists: true,
      object: { isFolder: true, mode: 0o40755 },
    });
    assert.deepEqual(await wrapped.analyzePath("/none"), { exists: false });
    php.fileExists = () => {
      throw new Error("fs down");
    };
    assert.deepEqual(await wrapped.analyzePath("/f.txt"), { exists: false });
  });

  it("delegates filesystem, run and event APIs to the PHP instance", async () => {
    const php = fakePhp({ chdir: () => {} });
    const wrapped = wrapPhpInstance(php);
    await wrapped.mkdir("/new");
    assert.equal(php.isDir("/new"), true);
    await wrapped.writeFile("/new/a.txt", "abc");
    assert.equal(php.fileMap.get("/new/a.txt"), "abc");
    assert.equal(
      new TextDecoder().decode(await wrapped.readFile("/new/a.txt")),
      "abc",
    );
    await wrapped.run("<?php echo 1;");
    assert.deepEqual(php.runs.at(-1), { code: "<?php echo 1;" });
    const handler = () => {};
    wrapped.addEventListener("request.end", handler);
    wrapped.removeEventListener("request.end", handler);
    assert.deepEqual(php.listeners, [
      ["add", "request.end", handler],
      ["remove", "request.end", handler],
    ]);
    assert.equal(wrapped._php, php);
    assert.equal(typeof (await wrapped.binary).FS.chdir, "function");
  });
});

describe("networking proxy resolution", () => {
  it("exposes the app root and resolves the configured proxy URL", () => {
    assert.ok(APP_LOCATION.endsWith("/"));
    assert.equal(
      resolveProxyUrl({ proxyUrl: "https://proxy.example/fetch" })?.href,
      "https://proxy.example/fetch",
    );
    assert.equal(resolveProxyUrl({}), null);
  });
});

describe("manifest loading", () => {
  let originalFetch;
  let calls;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches latest.json without a version and records its URL", async () => {
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init]);
      return Response.json({ release: "2025.1" });
    };
    const manifest = await fetchManifest();
    assert.match(calls[0][0], /assets\/manifests\/latest\.json$/);
    assert.deepEqual(calls[0][1], { cache: "no-cache" });
    assert.equal(manifest.release, "2025.1");
    assert.equal(manifest._manifestUrl, calls[0][0]);
  });

  it("encodes the requested core version into the manifest name", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({});
    };
    await fetchManifest("dev/branch");
    assert.match(calls[0], /assets\/manifests\/dev%2Fbranch\.json$/);
  });

  it("throws with the HTTP status on a failed response", async () => {
    globalThis.fetch = async () => new Response("", { status: 404 });
    await assert.rejects(fetchManifest("x"), /manifest: 404/);
  });

  it("builds the manifest state with and without a bundle hash", () => {
    assert.deepEqual(
      buildManifestState(
        { release: "r1", bundle: { sha256: "abc" }, generatedAt: "t" },
        "php83",
        "v1",
      ),
      {
        runtimeId: "php83",
        bundleVersion: "v1",
        release: "r1",
        sha256: "abc",
        generatedAt: "t",
      },
    );
    assert.equal(buildManifestState({}, "php83", "v1").sha256, null);
  });
});
