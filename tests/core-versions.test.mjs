import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCoreVersions } from "../src/shared/core-versions.js";

describe("supported core versions", () => {
  it("keeps valid stable and dev entries and selects the requested default", () => {
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
            channels: ["dev"],
            label: "2026.5 (Dev)",
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
            channels: ["dev"],
            label: "2026.5 (Dev)",
          },
        ],
      },
    );
  });

  it("deduplicates versions and filters unsupported channels", () => {
    const result = normalizeCoreVersions({
      default: "missing",
      versions: [
        { version: "2026.5", channels: ["dev", "nightly", "dev"] },
        { version: "2026.5", channels: ["stable"] },
        { version: "../bad", channels: ["stable"] },
      ],
    });

    assert.equal(result.defaultVersion, "2026.5");
    assert.deepEqual(result.versions[0].channels, ["dev"]);
    assert.equal(result.versions.length, 1);
  });
});
