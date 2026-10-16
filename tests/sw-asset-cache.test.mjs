import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCacheableAssetResponse,
  isStaticAssetPath,
} from "../src/shared/sw-asset-cache.js";

const response = (headers = {}, status = 200) =>
  new Response("x", {
    status,
    headers: { "content-type": "text/css", ...headers },
  });

describe("service worker asset cache policy", () => {
  it("only considers paths with a static extension", () => {
    assert.equal(isStaticAssetPath("/Dinamic/Assets/CSS/app.css?v=3"), true);
    assert.equal(isStaticAssetPath("/EditProducto?code=1"), false);
    assert.equal(isStaticAssetPath("/index.php?page=ListCliente"), false);
  });

  it("keeps caching real static files", () => {
    for (const path of [
      "/Dinamic/Assets/CSS/app.css?v=3",
      "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js",
      "/MyFiles/logo.png?myft=token",
    ]) {
      assert.equal(isCacheableAssetResponse(path, response()), true, path);
    }
  });

  it("does not freeze a PHP route that only looks like an asset", () => {
    const path = "/index.php/export/report.png";
    assert.equal(isCacheableAssetResponse(path, response()), false);
    assert.equal(
      isCacheableAssetResponse(
        path,
        response({ "cache-control": "public, max-age=3600" }),
      ),
      true,
    );
  });

  it("never stores HTML, partial/error responses or no-store/no-cache", () => {
    const path = "/Dinamic/Assets/JS/missing.js";
    // A front-controller page (login, not found) must not be kept as a script.
    assert.equal(
      isCacheableAssetResponse(path, response({ "content-type": "text/html" })),
      false,
    );
    for (const status of [206, 404, 500]) {
      assert.equal(isCacheableAssetResponse(path, response({}, status)), false);
    }
    for (const cacheControl of ["no-store", "private, no-cache"]) {
      assert.equal(
        isCacheableAssetResponse(
          path,
          response({ "cache-control": cacheControl }),
        ),
        false,
      );
    }
  });
});
