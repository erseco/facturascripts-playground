// Cloudflare Worker used by the public GitHub Pages deployment.
// We keep this source in-repo because the static site cannot serve /__addon_proxy__,
// and remote GitHub ZIP downloads are not reliable via direct browser fetches due to CORS.
// Production uses https://zip-proxy.erseco.workers.dev/ while local development keeps
// using the same-origin proxy from scripts/dev-server.mjs.

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        {
          error: "Method not allowed. Only GET is supported.",
        },
        405,
      );
    }

    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return jsonResponse(
        {
          error: 'Missing "url" query parameter.',
        },
        400,
      );
    }

    let parsedTargetUrl;

    try {
      parsedTargetUrl = new URL(targetUrl);
    } catch (error) {
      return jsonResponse(
        {
          error: "Invalid URL.",
          details: error.message,
        },
        400,
      );
    }

    if (
      parsedTargetUrl.protocol !== "https:" &&
      parsedTargetUrl.protocol !== "http:"
    ) {
      return jsonResponse(
        {
          error: "Invalid protocol. Only http and https are allowed.",
        },
        400,
      );
    }

    try {
      const acceptHeader = isFacturaScriptsPluginPage(parsedTargetUrl)
        ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
        : looksLikeZipUrl(parsedTargetUrl)
          ? "application/zip, application/octet-stream;q=0.9, */*;q=0.8"
          : "*/*";

      const upstreamResponse = await fetch(parsedTargetUrl.toString(), {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "zip-proxy-worker",
          Accept: acceptHeader,
        },
      });

      if (!upstreamResponse.ok) {
        return jsonResponse(
          {
            error: "Upstream server returned an error.",
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
          },
          502,
        );
      }

      const headers = new Headers(upstreamResponse.headers);

      applyCorsHeaders(headers);

      headers.set(
        "Content-Type",
        headers.get("Content-Type") ||
          (looksLikeZipUrl(parsedTargetUrl)
            ? "application/zip"
            : "text/html; charset=utf-8"),
      );

      if (
        !headers.get("Content-Disposition") &&
        looksLikeZipUrl(parsedTargetUrl)
      ) {
        headers.set(
          "Content-Disposition",
          `attachment; filename="${buildZipFilename(parsedTargetUrl)}"`,
        );
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    } catch (error) {
      return jsonResponse(
        {
          error: "Failed to fetch remote plugin resource.",
          details: error.message,
        },
        502,
      );
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Expose-Headers":
      "Content-Disposition, Content-Type, Content-Length, X-Playground-Cors-Proxy",
    "X-Playground-Cors-Proxy": "true",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCorsHeaders(headers) {
  const cors = corsHeaders();

  Object.entries(cors).forEach(([key, value]) => {
    headers.set(key, value);
  });
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function looksLikeZipUrl(url) {
  const pathname = url.pathname.toLowerCase();

  if (pathname.endsWith(".zip")) {
    return true;
  }

  if (pathname.includes("/zip/")) {
    return true;
  }

  if (pathname.includes("archive/refs/heads/")) {
    return true;
  }

  if (pathname.includes("archive/refs/tags/")) {
    return true;
  }

  if (/\/downloadbuild\/\d+\/(stable|beta)$/u.test(pathname)) {
    return true;
  }

  return false;
}

function isFacturaScriptsPluginPage(url) {
  return (
    url.hostname.toLowerCase() === "facturascripts.com" &&
    /^\/plugins\/[^/]+\/?$/u.test(url.pathname)
  );
}

function buildZipFilename(url) {
  const pathnameParts = url.pathname.split("/").filter(Boolean);
  const lastPart = pathnameParts[pathnameParts.length - 1] || "download.zip";

  if (lastPart.toLowerCase().endsWith(".zip")) {
    return sanitizeFilename(lastPart);
  }

  return sanitizeFilename(`${lastPart}.zip`);
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}
