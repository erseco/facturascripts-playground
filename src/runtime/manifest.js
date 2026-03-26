import { resolveProjectUrl } from "../shared/paths.js";

export async function fetchManifest() {
  const url = resolveProjectUrl("assets/manifests/latest.json");
  const response = await fetch(url, { cache: "no-cache" });
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
