import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCoreVersions } from "../src/shared/core-versions.js";

describe("supported core versions", () => {
  it("keeps valid stable and beta entries and selects the requested default", () => {
    assert.deepEqual(
      normalizeCoreVersions({
        default: "2026.41",
        versions: [
          {
            version: "2026.41",
            channels: ["stable"],
            label: "2026.41 (Stable)",
          },
          {
            version: "2026.5",
            channels: ["beta"],
            label: "2026.5 (Beta)",
          },
        ],
      }),
      {
        defaultVersion: "2026.41",
        versions: [
          {
            version: "2026.41",
            channels: ["stable"],
            label: "2026.41 (Stable)",
          },
          {
            version: "2026.5",
            channels: ["beta"],
            label: "2026.5 (Beta)",
          },
        ],
      },
    );
  });

  it("deduplicates versions and filters unsupported channels", () => {
    const result = normalizeCoreVersions({
      default: "missing",
      versions: [
        { version: "2026.5", channels: ["beta", "nightly", "beta"] },
        { version: "2026.5", channels: ["stable"] },
        { version: "../bad", channels: ["stable"] },
      ],
    });

    assert.equal(result.defaultVersion, "2026.5");
    assert.deepEqual(result.versions[0].channels, ["beta"]);
    assert.equal(result.versions.length, 1);
  });
});
