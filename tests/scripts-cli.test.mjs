// Runs the build/maintenance CLIs under scripts/ as real child processes and
// asserts what they print, write and exit with. External tools are faked at
// the process boundary (a stub `npx` on PATH for wrangler).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { isValidBuildVersion } from "../scripts/lib/build-version.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const script = (name) => join(repoDir, "scripts", name);
const tempDirs = [];
const makeTemp = () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-scripts-"));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function run(name, args = [], env = {}) {
  return spawnSync(process.execPath, [script(name), ...args], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("sync-browser-deps.mjs", () => {
  it("reports there is nothing to vendor", () => {
    const result = run("sync-browser-deps.mjs");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "No browser dependencies to vendor.\n");
  });
});

describe("prepare-runtime.mjs", () => {
  it("creates the cache, asset and vendor directories", () => {
    const result = run("prepare-runtime.mjs");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Prepared cache, asset, and vendor/);
    for (const dir of [
      ".cache/facturascripts-source",
      "assets/facturascripts",
      "assets/manifests",
      "vendor",
    ]) {
      assert.ok(existsSync(join(repoDir, dir)), dir);
    }
  });
});

describe("write-build-version.mjs --print-version", () => {
  it("replays BUILD_VERSION verbatim", () => {
    const result = run("write-build-version.mjs", ["--print-version"], {
      BUILD_VERSION: "20260101T000000Z-0123abcd",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "20260101T000000Z-0123abcd\n");
  });

  it("derives a canonical ID from git when no override is given", () => {
    const env = { ...process.env };
    delete env.BUILD_VERSION;
    delete env.BUILD_SHA;
    const out = execFileSync(
      process.execPath,
      [script("write-build-version.mjs"), "--print-version"],
      { cwd: repoDir, encoding: "utf8", env },
    ).trim();
    assert.ok(isValidBuildVersion(out), out);
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    assert.ok(out.includes(`-${head.slice(0, 8)}`), out);
  });
});

describe("build-tar-zst-bundle.mjs", () => {
  it("packs every regular file into a zstd tar and prints the file count", () => {
    const stage = makeTemp();
    mkdirSync(join(stage, "Core/Lib"), { recursive: true });
    writeFileSync(join(stage, "index.php"), "<?php echo 1;");
    writeFileSync(join(stage, "Core/Lib/Tool.php"), "<?php class Tool {}");
    const out = join(makeTemp(), "core.tar.zst");

    const result = run("build-tar-zst-bundle.mjs", [stage, out]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "2");

    const tar = zlib.zstdDecompressSync(readFileSync(out)).toString("latin1");
    assert.ok(tar.includes("index.php"));
    assert.ok(tar.includes("Core/Lib/Tool.php"));
    assert.ok(tar.includes("<?php class Tool {}"));
  });

  it("is deterministic for the same tree", () => {
    const stage = makeTemp();
    writeFileSync(join(stage, "a.txt"), "same");
    const dir = makeTemp();
    run("build-tar-zst-bundle.mjs", [stage, join(dir, "1.tar.zst")]);
    run("build-tar-zst-bundle.mjs", [stage, join(dir, "2.tar.zst")]);
    assert.deepEqual(
      readFileSync(join(dir, "1.tar.zst")),
      readFileSync(join(dir, "2.tar.zst")),
    );
  });

  it("prints usage and exits 1 without arguments", () => {
    const result = run("build-tar-zst-bundle.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: build-tar-zst-bundle\.mjs/);
  });
});

describe("generate-manifest.mjs", () => {
  it("writes a schema 2 manifest describing the bundle", () => {
    const dir = makeTemp();
    mkdirSync(join(dir, "bundles"));
    const bundle = join(dir, "bundles/core.tar.zst");
    writeFileSync(bundle, "bundle-bytes");
    const manifestPath = join(dir, "latest.json");

    const result = run("generate-manifest.mjs", [
      "--manifest",
      manifestPath,
      "--bundle",
      bundle,
      "--channel",
      "stable",
      "--release",
      "2025.1",
      "--sourceRepository",
      "https://github.com/erseco/facturascripts",
      "--sourceBranch",
      "feature/add-sqlite-support-stable",
      "--sourceCommit",
      "abc123",
      "--fileCount",
      "42",
      "ignored-positional",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.channel, "stable");
    assert.equal(manifest.release, "2025.1");
    assert.deepEqual(manifest.source, {
      repository: "https://github.com/erseco/facturascripts",
      branch: "feature/add-sqlite-support-stable",
      commit: "abc123",
    });
    assert.equal(manifest.bundle.path, "bundles/core.tar.zst");
    assert.equal(manifest.bundle.size, 12);
    assert.equal(manifest.bundle.fileCount, 42);
    assert.equal(
      manifest.bundle.sha256,
      createHash("sha256").update("bundle-bytes").digest("hex"),
    );
    assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
  });

  it("defaults fileCount to 0", () => {
    const dir = makeTemp();
    const bundle = join(dir, "core.tar.zst");
    writeFileSync(bundle, "x");
    const manifestPath = join(dir, "m.json");
    const result = run("generate-manifest.mjs", [
      "--manifest",
      manifestPath,
      "--bundle",
      bundle,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(readFileSync(manifestPath, "utf8")).bundle.fileCount,
      0,
    );
  });

  it("rejects a flag without a value", () => {
    const result = run("generate-manifest.mjs", ["--manifest", "--bundle"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing value for --manifest/);
  });
});

describe("cleanup-cloudflare-pages.mjs", () => {
  // A stub `npx` first on PATH answers `npx wrangler pages deployment ...`:
  // `list` prints $FAKE_DEPLOYMENTS, `delete` logs its id (failing for
  // "broken"), and a missing file makes `list` itself fail.
  const binDir = makeTemp();
  writeFileSync(
    join(binDir, "npx"),
    `#!/bin/sh
if [ "$3" = "deployment" ] && [ "$4" = "list" ]; then
  [ -f "$FAKE_DEPLOYMENTS" ] || { echo "list exploded" >&2; exit 3; }
  cat "$FAKE_DEPLOYMENTS"; exit 0
fi
if [ "$4" = "delete" ]; then
  [ "$5" = "broken" ] && { echo "delete refused" >&2; exit 1; }
  echo "$5" >> "$FAKE_DELETED"; exit 0
fi
exit 9
`,
  );
  chmodSync(join(binDir, "npx"), 0o755);

  const deployment = (Id, Environment, Branch) => ({
    Id,
    Environment,
    Branch,
    Source: `src-${Id}`,
  });

  function cleanup(deployments, env = {}) {
    const dir = makeTemp();
    const listFile = join(dir, "list.json");
    if (deployments) writeFileSync(listFile, JSON.stringify(deployments));
    const deletedFile = join(dir, "deleted.txt");
    const result = run("cleanup-cloudflare-pages.mjs", [], {
      PATH: `${binDir}:${process.env.PATH}`,
      CLOUDFLARE_PAGES_PROJECT: "fs-playground",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_PAGES_BRANCH: "",
      CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "",
      CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "",
      FAKE_DEPLOYMENTS: listFile,
      FAKE_DELETED: deletedFile,
      ...env,
    });
    const deleted = existsSync(deletedFile)
      ? readFileSync(deletedFile, "utf8").trim().split("\n")
      : [];
    return { ...result, deleted };
  }

  it("requires the project name and the account id", () => {
    const noProject = cleanup([], { CLOUDFLARE_PAGES_PROJECT: "" });
    assert.notEqual(noProject.status, 0);
    assert.match(noProject.stderr, /CLOUDFLARE_PAGES_PROJECT is required/);
    const noAccount = cleanup([], { CLOUDFLARE_ACCOUNT_ID: "" });
    assert.notEqual(noAccount.status, 0);
    assert.match(noAccount.stderr, /CLOUDFLARE_ACCOUNT_ID is required/);
  });

  it("keeps the newest deployment per environment/branch and deletes the rest", () => {
    const result = cleanup([
      deployment("p1", "production", "main"),
      deployment("v1", "preview", "feature/x"),
      deployment("p0", "production", "main"),
      deployment("v0", "preview", "feature/x"),
      deployment("w1", "preview", "feature/y"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.deleted, ["p0", "v0"]);
    assert.match(result.stdout, /Deleted p0 \(production\/main\/src-p0\)/);
  });

  it("deletes every deployment of the target branch when asked to", () => {
    const result = cleanup(
      [
        deployment("p1", "production", "main"),
        deployment("x2", "preview", "feature/gone"),
        deployment("x1", "preview", "feature/gone"),
      ],
      {
        CLOUDFLARE_PAGES_BRANCH: "feature/gone",
        CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "true",
      },
    );
    assert.deepEqual(result.deleted, ["x2", "x1"]);
  });

  it("only reports deletions in dry-run mode", () => {
    const result = cleanup(
      [deployment("a", "preview", "b"), deployment("c", "preview", "b")],
      { CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "true" },
    );
    assert.deepEqual(result.deleted, []);
    assert.match(
      result.stdout,
      /\[dry-run\] Would delete c \(preview\/b\/src-c\)/,
    );
  });

  it("says so when there is nothing stale", () => {
    const result = cleanup([deployment("only", "production", "main")]);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /No stale Cloudflare Pages deployments found for fs-playground/,
    );
  });

  it("skips a deployment wrangler refuses to delete and carries on", () => {
    const result = cleanup([
      deployment("keep", "preview", "b"),
      deployment("broken", "preview", "b"),
      deployment("old", "preview", "b"),
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Skipped broken .*delete refused/s);
    assert.deepEqual(result.deleted, ["old"]);
  });

  it("fails with wrangler's output when listing fails", () => {
    const result = cleanup(null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wrangler pages deployment list .*failed/);
    assert.match(result.stderr, /list exploded/);
  });
});

describe("esbuild.worker.mjs", () => {
  it("bundles the PHP worker with only the offered PHP runtimes, and the classic SW", () => {
    const result = run("esbuild.worker.mjs");
    assert.equal(result.status, 0, result.stderr);
    const offered = JSON.parse(
      readFileSync(join(repoDir, "playground.config.json"), "utf8"),
    ).runtimes.map((r) => r.phpVersion.replace(".", "_"));
    assert.match(
      result.stdout,
      /Built dist\/php-worker\.bundle\.js \(bundled PHP runtimes: /,
    );

    const emitted = readdirSync(join(repoDir, "dist"));
    for (const version of offered) {
      assert.ok(
        emitted.some(
          (f) => f.startsWith(`php_${version}-`) && f.endsWith(".wasm"),
        ),
        `wasm for ${version}`,
      );
    }
    assert.ok(!emitted.some((f) => f.startsWith("php_7_4-")));
    assert.ok(!emitted.some((f) => f.startsWith("php_5_2-")));

    const worker = readFileSync(
      join(repoDir, "dist/php-worker.bundle.js"),
      "utf8",
    );
    assert.ok(
      worker.startsWith(
        'const __APP_ROOT__ = new URL("../", import.meta.url).href;',
      ),
    );
    assert.match(
      worker,
      /PHP runtime not bundled in this build: @php-wasm\/web-7-4/,
    );
    assert.match(worker, /unpkg\.com\/@php-wasm\/web@[^/]+\/shared\/icu\.dat/);

    const sw = readFileSync(join(repoDir, "sw.bundle.js"), "utf8");
    assert.match(sw, /^\(\(\) => \{/);
    assert.doesNotMatch(sw, /^\s*import\s/m);
  });
});
