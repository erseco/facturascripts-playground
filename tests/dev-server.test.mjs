// Starts scripts/dev-server.mjs as a real process on a free port and drives it
// over HTTP. Outbound fetches of the addon proxy are answered by a stub fetch
// preloaded into the server process (--import), keyed on the target path.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

// String bodies would get an implicit text/plain content-type, so the stub
// answers with bytes. SIGTERM exits normally so V8 coverage is flushed.
const FETCH_STUB = `
process.on("SIGTERM", () => process.exit(0));
const bytes = (text) => new TextEncoder().encode(text);
globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  const path = target.pathname;
  if (path.endsWith("/throws.zip")) throw new Error("socket hang up");
  if (path.endsWith("/missing.zip")) {
    return new Response("nope", { status: 404, statusText: "Not Found" });
  }
  if (path.startsWith("/plugins/")) {
    return new Response(bytes("<h1>plugin</h1>"), { status: 200 });
  }
  if (path.endsWith("/empty.zip")) {
    return new Response(null, {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  }
  if (path.endsWith("/disposition.zip")) {
    return new Response("PK", {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="upstream.zip"',
        "content-length": "2",
      },
    });
  }
  return new Response(bytes("PK-" + init.method + "-" + init.headers["User-Agent"]), {
    status: 200,
  });
};
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server;
let base;

before(async () => {
  const port = await freePort();
  server = spawn(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`,
      "scripts/dev-server.mjs",
    ],
    { cwd: repoDir, env: { ...process.env, PORT: String(port) } },
  );
  await new Promise((resolve, reject) => {
    server.once("exit", (code) => reject(new Error(`exited early: ${code}`)));
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`listening on http://127.0.0.1:${port}`)) {
        resolve();
      }
    });
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await exited;
});

const proxy = (target, init) =>
  fetch(`${base}/__addon_proxy__?url=${encodeURIComponent(target)}`, init);

describe("dev-server static files", () => {
  it("serves / as index.html with a no-store HTML response", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      await response.text(),
      readFileSync(new URL("../index.html", import.meta.url), "utf8"),
    );
  });

  it("maps extensions to MIME types, falling back to octet-stream", async () => {
    const json = await fetch(`${base}/playground.config.json?v=1`);
    assert.equal(
      json.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal((await json.json()).siteTitle, "FacturaScripts Playground");
    const unknown = await fetch(`${base}/LICENSE`);
    assert.equal(
      unknown.headers.get("content-type"),
      "application/octet-stream",
    );
    await unknown.arrayBuffer();
  });

  it("answers 404 for missing files and for directories without index.html", async () => {
    for (const path of ["/does-not-exist.js", "/src"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), "Not found");
    }
  });

  it("keeps encoded traversal inside the repository", async () => {
    const response = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    assert.equal(response.status, 404);
  });

  it("rejects methods other than GET and HEAD", async () => {
    const response = await fetch(`${base}/index.html`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(await response.text(), "Method not allowed");
  });
});

describe("dev-server addon proxy", () => {
  it("answers the CORS preflight", async () => {
    const response = await fetch(`${base}/__addon_proxy__`, {
      method: "OPTIONS",
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(
      response.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
  });

  it("rejects missing, invalid and non-http URLs with a JSON 400", async () => {
    const missing = await fetch(`${base}/__addon_proxy__`);
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      error: 'Missing "url" query parameter.',
    });

    const invalid = await proxy("not a url");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "Invalid URL.");

    const ftp = await proxy("ftp://github.com/a.zip");
    assert.equal(ftp.status, 400);
    assert.match((await ftp.json()).error, /Only http and https/);
  });

  it("refuses hosts outside the allowlist with 403", async () => {
    const response = await proxy("https://evil.example/plugin.zip");
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json()).error,
      'Outbound HTTP host "evil.example" is not allowed.',
    );
  });

  it("refuses allowed hosts that are not plugin downloads or pages", async () => {
    const response = await proxy("https://github.com/erseco/readme");
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not a supported plugin page/);
  });

  it("streams a ZIP download with a derived attachment filename", async () => {
    const response = await proxy(
      "https://codeload.github.com/erseco/plugin/zip/refs/heads/main",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="main.zip"',
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      await response.text(),
      "PK-GET-facturascripts-playground-dev-proxy",
    );
  });

  it("sanitizes the filename of a .zip path and accepts subdomains", async () => {
    const response = await proxy(
      "https://objects.githubusercontent.com/a/my%20plugin.zip",
    );
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="my_20plugin.zip"',
    );
    await response.text();
  });

  it("passes upstream content-disposition and content-length through", async () => {
    const response = await proxy("https://github.com/x/disposition.zip");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="upstream.zip"',
    );
    assert.equal(response.headers.get("content-length"), "2");
    assert.equal(await response.text(), "PK");
  });

  it("proxies facturascripts.com plugin pages as HTML", async () => {
    const response = await proxy("https://facturascripts.com/plugins/ventas/");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(await response.text(), "<h1>plugin</h1>");
  });

  it("accepts downloadbuild URLs and sends HEAD without a body", async () => {
    const response = await proxy(
      "https://facturascripts.com/DownloadBuild/12/stable",
      { method: "HEAD" },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="stable.zip"',
    );
  });

  it("ends an empty upstream body cleanly", async () => {
    const response = await proxy("https://github.com/x/empty.zip");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });

  it("maps upstream errors and fetch failures to a JSON 502", async () => {
    const notFound = await proxy("https://github.com/x/missing.zip");
    assert.equal(notFound.status, 502);
    assert.deepEqual(await notFound.json(), {
      error: "Upstream server returned an error.",
      status: 404,
      statusText: "Not Found",
    });

    const thrown = await proxy("https://github.com/x/throws.zip");
    assert.equal(thrown.status, 502);
    assert.deepEqual(await thrown.json(), {
      error: "Failed to fetch remote plugin resource.",
      details: "socket hang up",
    });
  });
});
