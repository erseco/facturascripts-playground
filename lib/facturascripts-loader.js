import { resolveProjectUrl } from "../src/shared/paths.js";

const CACHE_NAME = "facturascripts-playground-bundles";
const DEFAULT_MANIFEST_URL = resolveProjectUrl(
  "assets/manifests/latest.json",
).toString();

/**
 * Download a resource with streaming progress reporting.
 */
export async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!contentLength || !response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength, ratio: 1 });
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({
      loaded,
      total: contentLength,
      ratio: Math.min(loaded / contentLength, 1),
    });
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Load and normalize a manifest JSON file.
 */
export async function fetchManifest(manifestUrl) {
  const url = manifestUrl || DEFAULT_MANIFEST_URL;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load manifest: ${response.status}`);
  }
  const manifest = await response.json();
  manifest._manifestUrl = url.toString();
  return manifest;
}

/**
 * Compute SHA-256 hex digest of a Uint8Array.
 */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the absolute bundle URL from a manifest.
 */
function resolveBundleUrl(manifest) {
  const bundlePath = manifest.bundle?.path;
  if (!bundlePath) {
    throw new Error("Manifest does not describe a bundle.");
  }
  return new URL(bundlePath, manifest._manifestUrl).toString();
}

/**
 * Download the bundle ZIP with Cache API caching and SHA-256 verification.
 */
export async function fetchBundleWithCache(manifest, onProgress) {
  const url = resolveBundleUrl(manifest);
  const expectedSha = manifest.bundle?.sha256;

  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    // Cache API unavailable (e.g. opaque origin); fall through to network.
  }

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (expectedSha) {
        const actual = await sha256Hex(bytes);
        if (actual === expectedSha) {
          onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
          return bytes;
        }
        // Hash mismatch — discard and re-download.
        await cache.delete(url);
      } else {
        onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
        return bytes;
      }
    }
  }

  const bytes = await fetchWithProgress(url, onProgress);

  if (expectedSha) {
    const actual = await sha256Hex(bytes);
    if (actual !== expectedSha) {
      throw new Error(
        `Bundle SHA-256 mismatch: expected ${expectedSha}, got ${actual}`,
      );
    }
  }

  if (cache) {
    try {
      const resp = new Response(bytes, {
        headers: { "content-type": "application/zip" },
      });
      await cache.put(url, resp);
    } catch {
      // Non-fatal — caching is best-effort.
    }
  }

  return bytes;
}

/**
 * Main entry point: load manifest + download bundle.
 *
 * Pass `options.manifest` to reuse an already-fetched manifest and skip the
 * redundant manifest round-trip — the boot path otherwise fetches it twice.
 */
export async function resolveBootstrapArchive(options = {}, onProgress) {
  const manifest = options.manifest ?? (await fetchManifest(options.manifestUrl));
  const bytes = await fetchBundleWithCache(manifest, onProgress);
  return { manifest, bytes };
}

/**
 * Sanitize a ZIP entry path to prevent ZIP-slip (path traversal). Normalizes
 * "\\" to "/" (Windows-built archives), strips leading slashes, and drops empty
 * and "." segments. Returns null when the entry contains a ".." segment (so the
 * caller can skip it) — without this a crafted archive could write outside the
 * target root via entries like "../../evil".
 */
export function sanitizeArchivePath(rawPath) {
  const segments = String(rawPath)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  return segments.length > 0 ? segments.join("/") : null;
}
