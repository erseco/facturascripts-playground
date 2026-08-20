import { fetchBootAsset } from "../../lib/facturascripts-loader.js";
import { resolveProjectUrl } from "../shared/paths.js";

export async function fetchManifest(coreVersion = "") {
  const manifestName = coreVersion
    ? `${encodeURIComponent(coreVersion)}.json`
    : "latest.json";
  const url = resolveProjectUrl(`assets/manifests/${manifestName}`);
  const response = await fetchBootAsset(url, { cache: "no-cache" }, "manifest");
  if (!response.ok) {
    throw new Error(
      `Unable to load FacturaScripts manifest: ${response.status}`,
    );
  }
  const manifest = await response.json();
  manifest._manifestUrl = url.toString();
  return manifest;
}

export function buildManifestState(manifest, runtimeId, bundleVersion) {
  return {
    runtimeId,
    bundleVersion,
    release: manifest.release,
    sha256: manifest.bundle?.sha256 || null,
    generatedAt: manifest.generatedAt,
  };
}
