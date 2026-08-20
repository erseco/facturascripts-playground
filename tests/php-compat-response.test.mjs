import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { phpResponseToResponse } from "../src/runtime/php-compat.js";

const encoder = new TextEncoder();

function phpResponse(status, headers = {}, body = "<html>hi</html>") {
  return {
    httpStatusCode: status,
    headers,
    bytes: encoder.encode(body),
  };
}

describe("phpResponseToResponse null-body statuses", () => {
  // "TypeError: Response with null body status cannot have body" blanked the
  // page whenever PHP answered a conditional GET. (101/103 are in the same set
  // but the Response constructor rejects any status outside 200-599 anyway.)
  for (const status of [204, 205, 304]) {
    it(`drops the body for ${status}`, async () => {
      const response = phpResponseToResponse(phpResponse(status));
      assert.equal(response.status, status);
      assert.equal(response.body, null);
      assert.equal(await response.text(), "");
    });
  }

  it("keeps the body for 200", async () => {
    const response = phpResponseToResponse(phpResponse(200));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<html>hi</html>");
  });

  it("keeps the body for an error status", async () => {
    const response = phpResponseToResponse(phpResponse(500, {}, "boom"));
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "boom");
  });

  it("preserves headers on a 304", () => {
    const response = phpResponseToResponse(
      phpResponse(304, { etag: ['"abc"'] }),
    );
    assert.equal(response.headers.get("etag"), '"abc"');
  });
});

describe("phpResponseToResponse invalid headers", () => {
  it("skips a malformed header name and keeps the rest of the response", async () => {
    const response = phpResponseToResponse(
      phpResponse(200, {
        "content-type": ["text/html"],
        "bad header": ["nope"],
        "x-ok": ["yes"],
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html");
    assert.equal(response.headers.get("x-ok"), "yes");
    // Headers.get() itself rejects an invalid name, so assert on the entries.
    const names = [...response.headers.keys()];
    assert.deepEqual(names.sort(), ["content-type", "x-ok"]);
    assert.equal(await response.text(), "<html>hi</html>");
  });

  it("skips a malformed header value", () => {
    const response = phpResponseToResponse(
      phpResponse(200, { "x-broken": ["line\nbreak"], "x-ok": ["yes"] }),
    );

    assert.equal(response.headers.get("x-ok"), "yes");
    assert.equal(response.headers.get("x-broken"), null);
    assert.deepEqual([...response.headers.keys()], ["x-ok"]);
  });
});
