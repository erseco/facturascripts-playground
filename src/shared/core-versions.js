import { resolveProjectUrl } from "./paths.js";

export function normalizeCoreVersions(payload = {}) {
  const seen = new Set();
  const versions = [];

  for (const entry of Array.isArray(payload.versions) ? payload.versions : []) {
    const version = String(entry?.version || "").trim();
    if (!/^\d{4}(?:\.\d+)?$/u.test(version) || seen.has(version)) {
      continue;
    }
    seen.add(version);
    const channels = Array.isArray(entry.channels)
      ? entry.channels.filter((channel) => ["stable", "beta"].includes(channel))
      : [];
    versions.push({
      version,
      channels: [...new Set(channels)],
      label: String(entry.label || version),
    });
  }

  const requestedDefault = String(payload.default || "");
  const defaultVersion = seen.has(requestedDefault)
    ? requestedDefault
    : versions[0]?.version || "";
  return { defaultVersion, versions };
}

export async function loadCoreVersions() {
  const url = resolveProjectUrl("assets/manifests/versions.json");
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return normalizeCoreVersions();
    }
    return normalizeCoreVersions(await response.json());
  } catch {
    return normalizeCoreVersions();
  }
}
