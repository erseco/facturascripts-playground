// Drives the zip-proxy Cloudflare Worker (scripts/zip-proxy-worker.js) through
// its fetch handler with real Request objects and a stubbed global fetch.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import worker from "../scripts/zip-proxy-worker.js";

const ORIGIN = "https://zip-proxy.test";
const realFetch = globalThis.fetch;
let calls;
let routes;

// Each route is [predicate(url), handler(url, init)]. Unmatched URLs fail loudly.
function route(match, handler) {
  routes.push([match, handler]);
}

beforeEach(() => {
  calls = [];
  routes = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const found = routes.find(([match]) => match(String(url)));
    if (!found) {
      throw new Error(`unexpected fetch ${url}`);
    }
    const [, handler] = found;
    return handler(String(url), init);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (query, init = {}, env = {}) =>
  worker.fetch(new Request(`${ORIGIN}/${query}`, init), env);
const proxied = (target, init) =>
  call(`?url=${encodeURIComponent(target)}`, init);
// Byte bodies keep Response from inventing a text/plain Content-Type.
const ok = (body = "PK", headers = {}) =>
  new Response(new TextEncoder().encode(body), { status: 200, headers });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const redirect = (location, status = 302) =>
  new Response(null, {
    status,
    headers: location ? { Location: location } : {},
  });
const is = (url) => (candidate) => candidate === url;
const startsWith = (prefix) => (candidate) => candidate.startsWith(prefix);

async function expectJsonError(response, status, pattern) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Content-Type"), "application/json");
  const body = await response.json();
  assert.match(body.error, pattern);
  return body;
}

describe("zip-proxy worker: method and parameter handling", () => {
  it("answers CORS preflight with 204 and the CORS header set", async () => {
    const response = await call("", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET, HEAD, OPTIONS",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.equal(response.headers.get("Access-Control-Max-Age"), "86400");
  });

  it("rejects methods other than GET/HEAD with 405 JSON", async () => {
    await expectJsonError(
      await call("?url=x", { method: "POST", body: "x" }),
      405,
      /Method not allowed/u,
    );
  });

  it("serves the landing page to browsers", async () => {
    const response = await call("", { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    assert.match(html, /^<!DOCTYPE html>/u);
    assert.ok(html.includes(`${ORIGIN}/?repo=`));
    assert.equal(calls.length, 0);
  });

  it("returns JSON usage info to non-browser clients", async () => {
    const body = await expectJsonError(await call(""), 400, /Missing/u);
    assert.equal(body.usage.generic, "?url={full_url}");
    assert.ok(body.usage.asset_pattern.includes("asset-pattern"));
  });
});

describe("zip-proxy worker: GitHub repo mode", () => {
  it("rejects malformed and dot-segment repo slugs", async () => {
    for (const repo of ["owner", "a/b/c", "../x", "a/..", "./b"]) {
      await expectJsonError(
        await call(`?repo=${encodeURIComponent(repo)}`),
        400,
        /Invalid repo format/u,
      );
    }
    assert.equal(calls.length, 0);
  });

  it("proxies a branch archive with zip headers and a filename", async () => {
    route(
      is("https://github.com/o/r/archive/refs/heads/dev.zip"),
      async (_url, init) => {
        assert.equal(init.redirect, "manual");
        assert.equal(init.headers.get("Range"), null);
        return ok("PK");
      },
    );
    const response = await call("?repo=o/r&branch=dev");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="dev.zip"',
    );
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await response.text(), "PK");
  });

  it("follows allowlisted redirects and keeps upstream disposition/type", async () => {
    route(is("https://github.com/o/r/archive/abc123.zip"), async () =>
      redirect("https://codeload.github.com/o/r/zip/abc123"),
    );
    route(is("https://codeload.github.com/o/r/zip/abc123"), async () =>
      ok("PK", {
        "Content-Type": "application/x-zip",
        "Content-Disposition": 'attachment; filename="r-abc.zip"',
      }),
    );
    const response = await call("?repo=o/r&commit=abc123");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/x-zip");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="r-abc.zip"',
    );
    assert.equal(calls.length, 2);
  });

  it("blocks redirects into private or non-GitHub hosts with 400", async () => {
    route(startsWith("https://github.com/o/r/archive/c1"), async () =>
      redirect("http://169.254.169.254/latest"),
    );
    const body = await expectJsonError(
      await call("?repo=o/r&commit=c1"),
      400,
      /not an allowed proxy destination/u,
    );
    assert.match(body.details, /not authorized/u);

    route(startsWith("https://github.com/o/r/archive/c2"), async () =>
      redirect("https://evil.example/x.zip"),
    );
    await expectJsonError(await call("?repo=o/r&commit=c2"), 400, /allowed/u);
  });

  it("blocks non-http redirect protocols and invalid Location values", async () => {
    route(startsWith("https://github.com/o/r/archive/c3"), async () =>
      redirect("ftp://github.com/x"),
    );
    const body = await expectJsonError(
      await call("?repo=o/r&commit=c3"),
      400,
      /allowed/u,
    );
    assert.match(body.details, /unsupported protocol/u);

    route(startsWith("https://github.com/o/r/archive/c4"), async () =>
      redirect("http://[::1"),
    );
    const invalid = await expectJsonError(
      await call("?repo=o/r&commit=c4"),
      400,
      /allowed/u,
    );
    assert.match(invalid.details, /not a valid URL/u);
  });

  it("gives up after too many redirect hops", async () => {
    route(startsWith("https://github.com/"), async (url) =>
      redirect(`${url}x`, 301),
    );
    const body = await expectJsonError(
      await call("?repo=o/r&commit=loop"),
      400,
      /allowed/u,
    );
    assert.match(body.details, /Too many redirects/u);
    assert.equal(calls.length, 6);
  });

  it("passes a 3xx without Location through unchanged", async () => {
    route(startsWith("https://github.com/"), async () => redirect(null, 307));
    const response = await call("?repo=o/r&commit=nolocation");
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(calls.length, 1);
  });

  it("passes through upstream 404 but maps other failures to 502", async () => {
    route(
      startsWith("https://github.com/o/r/archive/refs/heads/gone"),
      () => new Response("nope", { status: 404, statusText: "Not Found" }),
    );
    const body = await expectJsonError(
      await call("?repo=o/r&branch=gone"),
      404,
      /Upstream server returned an error/u,
    );
    assert.equal(body.statusText, "Not Found");
    assert.equal(
      body.upstream_url,
      "https://github.com/o/r/archive/refs/heads/gone.zip",
    );

    route(
      startsWith("https://github.com/o/r/archive/refs/heads/boom"),
      () => new Response("x", { status: 500 }),
    );
    await expectJsonError(
      await call("?repo=o/r&branch=boom"),
      502,
      /Upstream/u,
    );
  });

  it("maps network failures to 502 with details", async () => {
    route(startsWith("https://github.com/"), async () => {
      throw new Error("socket hang up");
    });
    const body = await expectJsonError(
      await call("?repo=o/r&branch=x"),
      502,
      /Failed to fetch remote resource/u,
    );
    assert.equal(body.details, "socket hang up");
  });

  it("resolves the default branch through the API with the token", async () => {
    route(is("https://api.github.com/repos/o/r"), async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer tok");
      return json({ default_branch: "trunk" });
    });
    route(is("https://github.com/o/r/archive/refs/heads/trunk.zip"), () =>
      ok(),
    );
    const response = await call("?repo=o/r", {}, { GITHUB_TOKEN: "tok" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Disposition"), /trunk\.zip/u);
  });

  it("falls back to main then master when the API is unavailable", async () => {
    route(is("https://api.github.com/repos/o/r"), () => json({}, 403));
    route(
      is("https://github.com/o/r/archive/refs/heads/main.zip"),
      () => new Response("", { status: 404 }),
    );
    route(is("https://github.com/o/r/archive/refs/heads/master.zip"), () =>
      ok(),
    );
    const response = await call("?repo=o/r");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Disposition"), /master\.zip/u);
  });

  it("returns the last failure when no fallback branch exists", async () => {
    route(is("https://api.github.com/repos/o/r"), async () => {
      throw new Error("offline");
    });
    route(
      startsWith("https://github.com/o/r/archive/"),
      () => new Response("", { status: 404 }),
    );
    const body = await expectJsonError(
      await call("?repo=o/r"),
      404,
      /Upstream/u,
    );
    assert.match(body.upstream_url, /master\.zip$/u);
  });

  it("validates and resolves pull requests", async () => {
    await expectJsonError(await call("?repo=o/r&pr=abc"), 400, /Invalid pr/u);

    route(is("https://api.github.com/repos/o/r/pulls/7"), () =>
      json({ head: { sha: "deadbeef" } }),
    );
    route(is("https://github.com/o/r/archive/deadbeef.zip"), () => ok());
    assert.equal((await call("?repo=o/r&pr=7")).status, 200);

    route(is("https://api.github.com/repos/o/r/pulls/8"), () => json({}));
    await expectJsonError(
      await call("?repo=o/r&pr=8"),
      502,
      /Could not resolve PR #8/u,
    );
  });

  it("proxies fixed-tag and latest release source archives", async () => {
    route(is("https://github.com/o/r/archive/refs/tags/v1.zip"), () => ok());
    assert.equal((await call("?repo=o/r&release=v1")).status, 200);

    route(is("https://api.github.com/repos/o/r/releases/latest"), () =>
      json({ tag_name: "v2" }),
    );
    route(is("https://github.com/o/r/archive/refs/tags/v2.zip"), () => ok());
    const latest = await call("?repo=o/r&release=latest");
    assert.match(latest.headers.get("Content-Disposition"), /v2\.zip/u);
  });

  it("fails clearly when latest cannot be resolved", async () => {
    route(is("https://api.github.com/repos/o/r/releases/latest"), () =>
      json({ message: "rate limited" }, 403),
    );
    await expectJsonError(
      await call("?repo=o/r&release=latest"),
      502,
      /latest release/u,
    );
  });

  it("forwards Range on every archive mode and passes the 206 through", async () => {
    const ranges = {};
    const ranged =
      (status = 206) =>
      async (url, init) => {
        ranges[new URL(url).pathname] = init.headers.get("Range");
        return new Response("PK", {
          status,
          headers: { "Content-Range": "bytes 0-1/10" },
        });
      };
    route(is("https://api.github.com/repos/o/r"), () =>
      json({ default_branch: "trunk" }),
    );
    route(is("https://api.github.com/repos/o/r/pulls/7"), () =>
      json({ head: { sha: "deadbeef" } }),
    );
    route(is("https://api.github.com/repos/o/r/releases/latest"), () =>
      json({ tag_name: "v2" }),
    );
    route(is("https://api.github.com/repos/o/gone"), () => json({}, 404));
    route(
      is("https://github.com/o/gone/archive/refs/heads/main.zip"),
      ranged(404),
    );
    route(startsWith("https://github.com/o/"), ranged());

    for (const query of [
      "o/r",
      "o/r&branch=dev",
      "o/r&commit=abc123",
      "o/r&pr=7",
      "o/r&release=v1",
      "o/r&release=latest",
      "o/gone",
    ]) {
      const response = await call(`?repo=${query}`, {
        headers: { Range: "bytes=0-1" },
      });
      assert.equal(response.status, 206, query);
      assert.equal(response.headers.get("Content-Range"), "bytes 0-1/10");
    }
    assert.deepEqual(ranges, {
      "/o/r/archive/refs/heads/trunk.zip": "bytes=0-1",
      "/o/r/archive/refs/heads/dev.zip": "bytes=0-1",
      "/o/r/archive/abc123.zip": "bytes=0-1",
      "/o/r/archive/deadbeef.zip": "bytes=0-1",
      "/o/r/archive/refs/tags/v1.zip": "bytes=0-1",
      "/o/r/archive/refs/tags/v2.zip": "bytes=0-1",
      "/o/gone/archive/refs/heads/main.zip": "bytes=0-1",
      "/o/gone/archive/refs/heads/master.zip": "bytes=0-1",
    });
  });

  it("passes an upstream 416 and its Content-Range through instead of 502", async () => {
    const unsatisfiable = () =>
      new Response(null, {
        status: 416,
        statusText: "Range Not Satisfiable",
        headers: { "Content-Range": "bytes */10" },
      });
    route(is("https://github.com/o/r/archive/refs/heads/b.zip"), unsatisfiable);
    route(is("https://gitlab.com/g/p/x.zip"), unsatisfiable);

    const init = { headers: { Range: "bytes=20-" } };
    for (const response of [
      await call("?repo=o/r&branch=b", init),
      await proxied("https://gitlab.com/g/p/x.zip", init),
    ]) {
      const body = await expectJsonError(response, 416, /Upstream/u);
      assert.equal(body.status, 416);
      assert.equal(response.headers.get("Content-Range"), "bytes */10");
    }
  });
});

describe("zip-proxy worker: release assets", () => {
  const assets = [
    { name: "plugin-1.2.zip", browser_download_url: "https://github.com/dl/1" },
    { name: "notes.txt", browser_download_url: "https://github.com/dl/2" },
  ];

  it("forwards Range on release-asset downloads and passes the 206 through", async () => {
    let range;
    route(is("https://api.github.com/repos/o/r/releases/tags/v1"), () =>
      json({ tag_name: "v1", assets }),
    );
    route(is("https://github.com/dl/1"), async (_url, init) => {
      range = init.headers.get("Range");
      return new Response("PK", {
        status: 206,
        headers: { "Content-Range": "bytes 0-1/10" },
      });
    });
    const response = await call("?repo=o/r&release=v1&asset=plugin-1.2.zip", {
      headers: { Range: "bytes=0-1" },
    });
    assert.equal(range, "bytes=0-1");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 0-1/10");
  });

  it("resolves an exact asset name case-insensitively and names the download", async () => {
    route(is("https://api.github.com/repos/o/r/releases/tags/v1"), () =>
      json({ tag_name: "v1", assets }),
    );
    route(is("https://github.com/dl/1"), () => ok());
    const response = await call("?repo=o/r&release=v1&asset=PLUGIN-1.2.ZIP");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="plugin-1.2.zip"',
    );
  });

  it("matches an asset-pattern glob against the latest release", async () => {
    route(is("https://api.github.com/repos/o/r/releases/latest"), () =>
      json({ tag_name: "v3", assets }),
    );
    route(is("https://github.com/dl/1"), () => ok());
    const response = await call(
      `?repo=o/r&release=latest&asset-pattern=${encodeURIComponent("plugin-?.*.zip")}`,
    );
    assert.equal(response.status, 200);
  });

  it("treats regex metacharacters in a glob literally", async () => {
    route(is("https://api.github.com/repos/o/r/releases/latest"), () =>
      json({ assets: [{ name: "a+b.zip", browser_download_url: "x" }] }),
    );
    const body = await expectJsonError(
      await call(
        `?repo=o/r&release=latest&asset-pattern=${encodeURIComponent("a.b.zip")}`,
      ),
      404,
      /No asset matching pattern "a\.b\.zip" found in release latest \(unknown tag\)/u,
    );
    assert.deepEqual(body.available_assets, ["a+b.zip"]);
  });

  it("lists available assets on an exact-name typo", async () => {
    route(is("https://api.github.com/repos/o/r/releases/tags/v1"), () =>
      json({ tag_name: "v1", assets }),
    );
    const body = await expectJsonError(
      await call("?repo=o/r&release=v1&asset=missing.zip"),
      404,
      /Asset "missing\.zip" not found in release "v1"/u,
    );
    assert.deepEqual(body.available_assets, ["plugin-1.2.zip", "notes.txt"]);
  });

  it("falls back to the deterministic download URL and forwards Range", async () => {
    route(startsWith("https://api.github.com/"), () => json({}, 404));
    route(
      is("https://github.com/o/r/releases/download/v%201/my%20file.zip"),
      async (_url, init) => {
        assert.equal(init.headers.get("Range"), "bytes=0-9");
        return new Response("PK", { status: 206 });
      },
    );
    const response = await call("?repo=o/r&release=v%201&asset=my%20file.zip", {
      headers: { Range: "bytes=0-9" },
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="my_file.zip"',
    );
  });

  it("refuses latest/asset-pattern without the API", async () => {
    route(startsWith("https://api.github.com/"), () => json({}, 500));
    await expectJsonError(
      await call("?repo=o/r&release=latest&asset=a.zip"),
      502,
      /requires a successful API call/u,
    );
    await expectJsonError(
      await call("?repo=o/r&release=v1&asset-pattern=*.zip"),
      502,
      /requires a successful API call/u,
    );
  });
});

describe("zip-proxy worker: raw files and Atom feeds", () => {
  it("serves a raw JSON file at an explicit ref with JSON content type", async () => {
    route(
      is("https://raw.githubusercontent.com/o/r/feat/x/blueprint.json"),
      () => ok("{}", { "Content-Type": "text/plain" }),
    );
    const response = await call("?repo=o/r&path=/blueprint.json&ref=feat/x");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/json; charset=utf-8",
    );
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
  });

  it("uses the default branch for raw files, then main as last resort", async () => {
    route(is("https://api.github.com/repos/o/r"), () =>
      json({ default_branch: "dev" }),
    );
    route(is("https://raw.githubusercontent.com/o/r/dev/README"), () =>
      ok("hi", { "Content-Type": "text/markdown" }),
    );
    const response = await call("?repo=o/r&path=README");
    assert.equal(response.headers.get("Content-Type"), "text/markdown");

    routes = [];
    route(is("https://api.github.com/repos/o/s"), () => json({}, 404));
    route(is("https://raw.githubusercontent.com/o/s/main/notes"), () =>
      ok("hi"),
    );
    const fallback = await call("?repo=o/s&path=notes");
    assert.equal(fallback.status, 200);
  });

  it("defaults raw text content type and maps raw errors", async () => {
    route(
      is("https://raw.githubusercontent.com/o/r/v1/a"),
      () => new Response("x", { status: 200, headers: {} }),
    );
    const plain = await call("?repo=o/r&path=a&release=v1");
    assert.match(plain.headers.get("Content-Type"), /^text\/plain/u);

    route(
      is("https://raw.githubusercontent.com/o/r/c/missing.json"),
      () => new Response("", { status: 404 }),
    );
    await expectJsonError(
      await call("?repo=o/r&path=missing.json&commit=c"),
      404,
      /Upstream/u,
    );

    route(is("https://raw.githubusercontent.com/o/r/b/x"), async () => {
      throw new Error("dns");
    });
    const failed = await expectJsonError(
      await call("?repo=o/r&path=x&branch=b"),
      502,
      /Failed to fetch raw file/u,
    );
    assert.equal(failed.details, "dns");

    route(is("https://raw.githubusercontent.com/o/r/b/moved"), () =>
      redirect("https://raw.githubusercontent.com/o/r/b/new"),
    );
    route(is("https://raw.githubusercontent.com/o/r/b/new"), () => ok("v2"));
    const moved = await call("?repo=o/r&path=moved&branch=b");
    assert.equal(await moved.text(), "v2");

    route(is("https://raw.githubusercontent.com/o/r/b/redir"), () =>
      redirect("http://localhost/x"),
    );
    await expectJsonError(
      await call("?repo=o/r&path=redir&branch=b"),
      400,
      /allowed/u,
    );
  });

  it("serves releases and tags Atom feeds and rejects other types", async () => {
    route(is("https://github.com/o/r/releases.atom"), () => ok("<feed/>"));
    const response = await call("?repo=o/r&atom=releases");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/atom+xml; charset=utf-8",
    );
    assert.equal(await response.text(), "<feed/>");

    await expectJsonError(
      await call("?repo=o/r&atom=commits"),
      400,
      /Invalid atom type. Use one of: releases, tags/u,
    );
  });

  it("maps Atom feed upstream errors, failures and blocked redirects", async () => {
    route(
      is("https://github.com/o/r/tags.atom"),
      () => new Response("", { status: 429 }),
    );
    await expectJsonError(await call("?repo=o/r&atom=tags"), 429, /Upstream/u);

    route(is("https://github.com/o/s/tags.atom"), async () => {
      throw new Error("reset");
    });
    await expectJsonError(
      await call("?repo=o/s&atom=tags"),
      502,
      /Failed to fetch Atom feed/u,
    );

    route(is("https://github.com/o/t/tags.atom"), () =>
      redirect("https://example.com/feed"),
    );
    await expectJsonError(await call("?repo=o/t&atom=tags"), 400, /allowed/u);
  });
});

describe("zip-proxy worker: generic ?url= proxy", () => {
  it("rejects invalid URLs and non-http protocols", async () => {
    await expectJsonError(await proxied("not a url"), 400, /Invalid URL/u);
    await expectJsonError(
      await proxied("file:///etc/passwd"),
      400,
      /Invalid protocol/u,
    );
  });

  it("rejects private, loopback and link-local hosts", async () => {
    const blocked = [
      "http://localhost/a.zip",
      "http://foo.localhost/a.zip",
      "http://printer.local/a.zip",
      "http://metadata.google.internal/a.zip",
      "http://metadata/a.zip",
      "http://127.0.0.1/s/token",
      "http://10.0.0.1/s/token",
      "http://0.0.0.0/s/token",
      "http://169.254.169.254/s/token",
      "http://172.16.5.4/s/token",
      "http://192.168.1.1/s/token",
      "http://[::1]/s/token",
      "http://[::]/s/token",
      "http://[fe80::1]/s/token",
      "http://[fc00::1]/s/token",
      "http://[fd12::1]/s/token",
      "http://[::ffff:127.0.0.1]/s/token",
      "http://[::ffff:a9fe:a9fe]/s/token",
    ];
    for (const target of blocked) {
      await expectJsonError(
        await proxied(target),
        400,
        /not a supported direct GitHub\/resource URL/u,
      );
    }
    assert.equal(calls.length, 0);
  });

  it("rejects zip-like paths on hosts that are not allowlisted", async () => {
    await expectJsonError(
      await proxied("https://evil.example/archive.zip"),
      400,
      /not a supported/u,
    );
    await expectJsonError(
      await proxied("https://drive.google.com/drive/folders/x"),
      400,
      /not a supported/u,
    );
    await expectJsonError(
      await proxied("https://drive.usercontent.google.com/other"),
      400,
      /not a supported/u,
    );
    await expectJsonError(
      await proxied("https://www.dropbox.com/home/file"),
      400,
      /not a supported/u,
    );
  });

  it("allows public IPs and non-private v6 ranges on share paths", async () => {
    for (const target of [
      "http://172.32.0.1/s/tok",
      "http://8.8.8.8/s/tok",
      "http://[2001:db8::1]/s/tok",
      "http://[::ffff:8.8.8.8]/s/tok",
      "http://[::ffff:1:2:3]/s/tok",
    ]) {
      route(
        () => true,
        () => ok("data"),
      );
      const response = await proxied(target);
      assert.equal(response.status, 200, target);
    }
  });

  it("sandboxes proxied bodies and strips cookies", async () => {
    route(is("https://gitlab.com/g/p/-/raw/main/file.txt"), () =>
      ok("text", {
        "Set-Cookie": "session=1",
        "Content-Type": "text/plain",
      }),
    );
    const response = await proxied(
      "https://gitlab.com/g/p/-/raw/main/file.txt",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Content-Security-Policy"), "sandbox");
    assert.equal(response.headers.get("Content-Type"), "text/plain");
    assert.equal(response.headers.get("Content-Disposition"), null);
    assert.equal(
      calls[0].init.headers.get("Accept"),
      "application/octet-stream, text/plain;q=0.9, */*;q=0.8",
    );
  });

  it("forwards conditional and range headers and the client Accept", async () => {
    route(is("https://cdn.jsdelivr.net/npm/x/file.js"), async (_url, init) => {
      assert.equal(init.headers.get("Accept"), "text/javascript");
      assert.equal(init.headers.get("Range"), "bytes=1-2");
      assert.equal(init.headers.get("If-None-Match"), '"etag"');
      assert.equal(init.headers.get("If-Modified-Since"), "yesterday");
      return new Response(null, {
        status: 304,
        headers: { ETag: '"etag"', "Set-Cookie": "s=1" },
      });
    });
    const response = await proxied("https://cdn.jsdelivr.net/npm/x/file.js", {
      headers: {
        Accept: "text/javascript",
        Range: "bytes=1-2",
        "If-None-Match": '"etag"',
        "If-Modified-Since": "yesterday",
      },
    });
    // The client's conditional request gets its 304 back (no longer a 502),
    // still sandboxed: CORS added, upstream cookies stripped.
    assert.equal(response.status, 304);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("ETag"), '"etag"');
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Set-Cookie"), null);
  });

  it("relays a 206 partial response to a Range request", async () => {
    route(
      is("https://github.com/o/r/raw/main/a.zip"),
      () =>
        new Response("PK", {
          status: 206,
          headers: { "Content-Range": "bytes 0-1/9" },
        }),
    );
    const response = await proxied("https://github.com/o/r/raw/main/a.zip", {
      headers: { Range: "bytes=0-1" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 0-1/9");
    assert.equal(await response.text(), "PK");
  });

  it("names zip downloads and defaults their content type", async () => {
    route(is("https://facturascripts.com/DownloadBuild/12/stable"), () =>
      ok("PK"),
    );
    const build = await proxied(
      "https://facturascripts.com/DownloadBuild/12/stable",
    );
    assert.equal(build.headers.get("Content-Type"), "application/zip");
    assert.equal(
      build.headers.get("Content-Disposition"),
      'attachment; filename="stable.zip"',
    );
    assert.match(calls[0].init.headers.get("Accept"), /^application\/zip/u);

    route(is("https://objects.githubusercontent.com/x/My%20Plugin.zip"), () =>
      ok("PK"),
    );
    const zip = await proxied(
      "https://objects.githubusercontent.com/x/My%20Plugin.zip",
    );
    assert.equal(
      zip.headers.get("Content-Disposition"),
      'attachment; filename="My_20Plugin.zip"',
    );
  });

  it("recognises other zip-like path shapes on allowlisted hosts", async () => {
    for (const target of [
      "https://codeload.github.com/o/r/zip/refs/heads/main",
      "https://github.com/o/r/archive/refs/heads/main",
      "https://github.com/o/r/archive/refs/tags/v1",
      "https://download.moodle.org/download.php/direct/langpack/4.5/es.zip",
    ]) {
      route(is(target), () => ok("PK"));
      const response = await proxied(target);
      assert.equal(response.headers.get("Content-Type"), "application/zip");
      assert.match(response.headers.get("Content-Disposition"), /\.zip"$/u);
    }
  });

  it("serves FacturaScripts plugin pages as HTML", async () => {
    route(is("https://facturascripts.com/plugins/sample"), () =>
      ok("<html>", {}),
    );
    const response = await proxied("https://facturascripts.com/plugins/sample");
    assert.equal(
      calls[0].init.headers.get("Accept"),
      "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    );
    assert.equal(
      response.headers.get("Content-Type"),
      "text/html; charset=utf-8",
    );
  });

  it("applies default content types when upstream sends none", async () => {
    const empty = () => {
      const response = new Response(null, { status: 200 });
      response.headers.delete("Content-Type");
      return response;
    };
    route(is("https://facturascripts.com/plugins/a"), empty);
    route(is("https://dev.omeka.org/feed.atom"), empty);
    route(is("https://omeka.org/file.bin"), empty);
    assert.equal(
      (await proxied("https://facturascripts.com/plugins/a")).headers.get(
        "Content-Type",
      ),
      "text/html; charset=utf-8",
    );
    const atom = await proxied("https://dev.omeka.org/feed.atom");
    assert.equal(
      atom.headers.get("Content-Type"),
      "application/atom+xml; charset=utf-8",
    );
    assert.match(calls[1].init.headers.get("Accept"), /^application\/atom/u);
    assert.equal(
      (await proxied("https://omeka.org/file.bin")).headers.get("Content-Type"),
      "application/octet-stream",
    );
  });

  it("routes github.com Atom URLs through the feed handler", async () => {
    route(is("https://github.com/o/r/releases.atom"), () => ok("<feed/>"));
    route(is("https://github.com/o/r/tags.atom"), () => ok("<feed/>"));
    for (const kind of ["releases", "tags"]) {
      const response = await proxied(`https://github.com/o/r/${kind}.atom`);
      assert.equal(
        response.headers.get("Content-Type"),
        "application/atom+xml; charset=utf-8",
      );
      assert.equal(
        response.headers.get("Cache-Control"),
        "public, max-age=300",
      );
    }
  });

  it("proxies release-download URLs directly without the API", async () => {
    route(is("https://github.com/o/r/releases/download/v1/a.zip"), () =>
      redirect("https://release-assets.githubusercontent.com/a"),
    );
    route(is("https://release-assets.githubusercontent.com/a"), () => ok("PK"));
    const response = await proxied(
      "https://github.com/o/r/releases/download/v1/a.zip",
    );
    assert.equal(response.status, 200);
    assert.ok(calls.every((c) => !c.url.startsWith("https://api.github.com")));
  });

  it("normalises Google Drive file links to the direct download endpoint", async () => {
    route(startsWith("https://drive.google.com/uc"), () => ok("data"));
    await proxied(
      "https://drive.google.com/file/d/FILEID/view?resourcekey=rk&usp=sharing",
    );
    const first = new URL(calls[0].url);
    assert.equal(first.pathname, "/uc");
    assert.equal(first.searchParams.get("id"), "FILEID");
    assert.equal(first.searchParams.get("export"), "download");
    assert.equal(first.searchParams.get("resourcekey"), "rk");
    assert.equal(first.searchParams.get("usp"), null);

    await proxied("https://drive.google.com/open?id=OPENID&confirm=t");
    const second = new URL(calls[1].url);
    assert.equal(second.searchParams.get("id"), "OPENID");
    assert.equal(second.searchParams.get("confirm"), "t");

    route(startsWith("https://drive.usercontent.google.com/"), () => ok("d"));
    await proxied("https://drive.usercontent.google.com/download?id=X");
    assert.equal(
      calls[2].url,
      "https://drive.usercontent.google.com/download?id=X",
    );
  });

  it("keeps a Drive /uc link whose id is empty unchanged", async () => {
    route(startsWith("https://drive.google.com/uc"), () => ok("d"));
    await proxied("https://drive.google.com/uc?id=");
    assert.equal(calls[0].url, "https://drive.google.com/uc?id=");
  });

  it("rewrites Nextcloud shares to /download and allows same-host DAV hops", async () => {
    route(is("https://cloud.example.org/s/AbC123/download"), () =>
      redirect("/public.php/dav/files/AbC123/", 303),
    );
    route(is("https://cloud.example.org/public.php/dav/files/AbC123/"), () =>
      ok("bytes"),
    );
    const response = await proxied("https://cloud.example.org/s/AbC123/");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "bytes");

    route(is("https://cloud.example.org/index.php/s/Tok/download"), () =>
      redirect("https://other.example.org/public.php/dav/x"),
    );
    await expectJsonError(
      await proxied("https://cloud.example.org/index.php/s/Tok/download"),
      400,
      /allowed/u,
    );

    route(is("https://cloud.example.org/s/Tok2/download"), () =>
      redirect("/apps/files/secret"),
    );
    await expectJsonError(
      await proxied("https://cloud.example.org/s/Tok2/download"),
      400,
      /allowed/u,
    );
  });

  it("follows Dropbox shares to the Dropbox CDN only", async () => {
    route(is("https://www.dropbox.com/scl/fi/h4sh/file.zip?rlkey=k&dl=1"), () =>
      redirect("https://uc123.dl.dropboxusercontent.com/cd/file.zip"),
    );
    route(is("https://uc123.dl.dropboxusercontent.com/cd/file.zip"), () =>
      ok("PK"),
    );
    const response = await proxied(
      "https://www.dropbox.com/scl/fi/h4sh/file.zip?rlkey=k&dl=1",
    );
    assert.equal(response.status, 200);

    route(is("https://dropbox.com/s/abc/file.zip"), () =>
      redirect("https://evil.example/file.zip"),
    );
    await expectJsonError(
      await proxied("https://dropbox.com/s/abc/file.zip"),
      400,
      /allowed/u,
    );
  });

  it("maps generic upstream failures to passthrough or 502", async () => {
    route(
      is("https://gitlab.com/a"),
      () => new Response("", { status: 410, statusText: "Gone" }),
    );
    const gone = await expectJsonError(
      await proxied("https://gitlab.com/a"),
      410,
      /Upstream/u,
    );
    assert.equal(gone.upstream_url, undefined);

    route(is("https://gitlab.com/b"), async () => {
      throw new Error("tls");
    });
    const failed = await expectJsonError(
      await proxied("https://gitlab.com/b"),
      502,
      /Failed to fetch remote resource/u,
    );
    assert.equal(failed.details, "tls");
  });

  it("authorises Moodle langpack index files", async () => {
    route(
      is("https://download.moodle.org/download.php/langpack/4.5/languages.md5"),
      () => ok("md5"),
    );
    const response = await proxied(
      "https://download.moodle.org/download.php/langpack/4.5/languages.md5",
    );
    assert.equal(response.status, 200);
    await expectJsonError(
      await proxied("https://packaging.moodle.org/other/languages.md5"),
      400,
      /not a supported/u,
    );
  });
});
