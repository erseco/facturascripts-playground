import { SNAPSHOT_VERSION } from "./protocol.js";

const BLUEPRINT_KEY_PREFIX = "facturascripts-playground:blueprint";

function hasWindow() {
  return typeof window !== "undefined";
}

function absolutizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (!hasWindow()) {
    return text;
  }

  try {
    return new URL(text, window.location.href).toString();
  } catch {
    return text;
  }
}

function getBlueprintStorageKey(scopeId) {
  return `${BLUEPRINT_KEY_PREFIX}:${scopeId}`;
}

function decodeBase64Text(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Blueprint data payload is empty.");
  }

  const normalized = text
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .replace(/\s+/gu, "");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;

  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Blueprint data payload is not valid base64.");
  }

  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Blueprint data payload is not valid UTF-8.");
  }
}

function parseBlueprintDataParam(value, config) {
  let rawPayload;
  try {
    rawPayload = JSON.parse(decodeBase64Text(value));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Blueprint data payload is not valid JSON.");
    }
    throw error;
  }

  return normalizeBlueprint(rawPayload, config);
}

function normalizePath(path, fallback = "/") {
  if (!path || typeof path !== "string") {
    return fallback;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function isHttpUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//iu.test(text);
}

function normalizePluginSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: "bundled" };
  }

  const type = String(input.type || (input.url ? "url" : "") || "bundled")
    .trim()
    .toLowerCase();

  if (type === "bundled") {
    return { type };
  }

  if (type === "url") {
    const url = absolutizeUrl(input.url || "");
    if (!url) {
      throw new Error(
        "Blueprint plugin source.type='url' requires source.url.",
      );
    }
    return { type, url };
  }

  throw new Error(`Unsupported blueprint plugin source type "${type}".`);
}

function normalizePluginCollection(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  return input
    .map((entry) => {
      if (typeof entry === "string") {
        const text = entry.trim();
        if (!text) {
          return null;
        }

        const isUrl = isHttpUrl(text);
        const normalized = isUrl
          ? {
              name: "",
              source: {
                type: "url",
                url: absolutizeUrl(text),
              },
              state: "activate",
            }
          : {
              name: text,
              source: { type: "bundled" },
              state: "activate",
            };

        if (
          !isUrl &&
          (/[\\/]/u.test(normalized.name) ||
            normalized.name === "." ||
            normalized.name === "..")
        ) {
          throw new Error(
            `Blueprint plugin name "${normalized.name}" must be a single path segment.`,
          );
        }

        const dedupeKey = isUrl
          ? `url:${normalized.source.url.toLowerCase()}`
          : `name:${normalized.name.toLowerCase()}`;
        if (seen.has(dedupeKey)) {
          throw new Error(
            `Blueprint plugins cannot include duplicate entry "${normalized.name}".`,
          );
        }
        seen.add(dedupeKey);
        return normalized;
      }

      const source = normalizePluginSource(entry?.source);
      const normalized = {
        name: String(entry?.name || "").trim(),
        source,
        state: entry?.state === "install" ? "install" : "activate",
      };

      if (!normalized.name && source.type !== "url") {
        return null;
      }

      if (
        normalized.name &&
        (/[\\/]/u.test(normalized.name) ||
          normalized.name === "." ||
          normalized.name === "..")
      ) {
        throw new Error(
          `Blueprint plugin name "${normalized.name}" must be a single path segment.`,
        );
      }

      const dedupeKey = normalized.name
        ? `name:${normalized.name.toLowerCase()}`
        : `url:${normalized.source.url.toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        throw new Error(
          `Blueprint plugins cannot include duplicate entry "${normalized.name || normalized.source.url}".`,
        );
      }
      seen.add(dedupeKey);

      return normalized;
    })
    .filter(Boolean);
}

function normalizeSeedCollection(input, primaryKey) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Blueprint seed.${primaryKey} entries must be objects.`);
    }

    const normalized = structuredClone(entry);
    const key = String(normalized[primaryKey] || "").trim();
    if (!key) {
      throw new Error(`Blueprint seed entry requires "${primaryKey}".`);
    }

    normalized[primaryKey] = key;
    const dedupeKey = key.toLowerCase();
    if (seen.has(dedupeKey)) {
      throw new Error(
        `Blueprint seed cannot include duplicate ${primaryKey} "${key}".`,
      );
    }
    seen.add(dedupeKey);
    return normalized;
  });
}

export function normalizeInstall(input) {
  const defaults = {
    codpais: "ESP",
    empresa: "Empresa Playground",
    cifnif: "00000014Z",
    tipoidfiscal: "",
    direccion: "",
    codpostal: "",
    ciudad: "",
    provincia: "",
    regimeniva: "General",
    codimpuesto: "",
    defaultplan: true,
    costpricepolicy: "",
    ventasinstock: false,
    updatesupplierprices: true,
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...defaults };
  }

  const result = { ...defaults };
  for (const key of Object.keys(input)) {
    if (key in defaults) {
      result[key] =
        typeof defaults[key] === "boolean"
          ? input[key] === true
          : String(input[key] ?? defaults[key]);
    }
  }
  return result;
}

function normalizeSeed(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      customers: [],
      suppliers: [],
      products: [],
    };
  }

  return {
    customers: normalizeSeedCollection(input.customers, "codcliente"),
    suppliers: normalizeSeedCollection(input.suppliers, "codproveedor"),
    products: normalizeSeedCollection(input.products, "referencia"),
  };
}

export function getBlueprintSchemaUrl() {
  return new URL(
    "../../assets/blueprints/blueprint-schema.json",
    import.meta.url,
  ).toString();
}

export function buildDefaultBlueprint(config) {
  return {
    $schema: getBlueprintSchemaUrl(),
    meta: {
      title: `${config.siteTitle} Blueprint`,
      author: "facturascripts-playground",
      description: "Default FacturaScripts Playground blueprint.",
    },
    debug: {
      enabled: false,
    },
    landingPage: "/",
    siteOptions: {
      title: config.siteTitle,
      locale: config.locale,
      timezone: config.timezone,
    },
    login: {
      username: config.admin.username,
      password: config.admin.password,
    },
    plugins: [],
    seed: {
      customers: [],
      suppliers: [],
      products: [],
    },
    install: normalizeInstall(undefined),
  };
}

export function normalizeBlueprint(input, config) {
  const blueprint =
    input && typeof input === "object" && !Array.isArray(input)
      ? structuredClone(input)
      : {};
  const fallback = buildDefaultBlueprint(config);

  return {
    $schema:
      typeof blueprint.$schema === "string"
        ? blueprint.$schema
        : fallback.$schema,
    meta: {
      title: blueprint.meta?.title || fallback.meta.title,
      author: blueprint.meta?.author || fallback.meta.author,
      description: blueprint.meta?.description || fallback.meta.description,
    },
    debug: {
      enabled: blueprint.debug?.enabled === true,
    },
    landingPage: normalizePath(
      blueprint.landingPage || blueprint.landingPath || fallback.landingPage,
      fallback.landingPage,
    ),
    siteOptions: {
      title: blueprint.siteOptions?.title || fallback.siteOptions.title,
      locale: blueprint.siteOptions?.locale || fallback.siteOptions.locale,
      timezone:
        blueprint.siteOptions?.timezone || fallback.siteOptions.timezone,
    },
    login: {
      username: blueprint.login?.username || fallback.login.username,
      password: blueprint.login?.password || fallback.login.password,
    },
    plugins: normalizePluginCollection(blueprint.plugins),
    seed: normalizeSeed(blueprint.seed),
    install: normalizeInstall(blueprint.install),
  };
}

export function buildEffectivePlaygroundConfig(config, blueprint) {
  const normalized = normalizeBlueprint(blueprint, config);

  return {
    ...config,
    siteTitle: normalized.siteOptions.title,
    locale: normalized.siteOptions.locale,
    timezone: normalized.siteOptions.timezone,
    landingPath: normalized.landingPage,
    debug: normalized.debug,
    admin: {
      username: normalized.login.username,
      email: config.admin.email,
      password: normalized.login.password,
    },
    install: normalized.install,
  };
}

export function exportBlueprintPayload(config, blueprint) {
  return normalizeBlueprint(blueprint, config);
}

export function saveActiveBlueprint(scopeId, blueprint) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.setItem(
    getBlueprintStorageKey(scopeId),
    JSON.stringify(blueprint),
  );
}

export function loadActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.sessionStorage.getItem(getBlueprintStorageKey(scopeId));
  return raw ? JSON.parse(raw) : null;
}

export function clearActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.removeItem(getBlueprintStorageKey(scopeId));
}

export async function resolveBlueprintForShell(scopeId, config) {
  if (!hasWindow()) {
    return buildDefaultBlueprint(config);
  }

  const url = new URL(window.location.href);

  // 1. ?blueprint= (inline base64/JSON — primary, matches moodle-playground)
  const blueprintParam = url.searchParams.get("blueprint");
  if (blueprintParam) {
    const payload = parseBlueprintDataParam(blueprintParam, config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // 2. ?blueprint-url= (remote URL — primary, matches moodle-playground)
  const blueprintUrlParam = url.searchParams.get("blueprint-url");
  if (blueprintUrlParam) {
    const response = await fetch(
      new URL(blueprintUrlParam, window.location.href),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(
        `Unable to load blueprint from ${blueprintUrlParam}: ${response.status}`,
      );
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // 3. ?blueprint-data= (legacy alias for ?blueprint=, kept for backward compat)
  const blueprintDataParam = url.searchParams.get("blueprint-data");
  if (blueprintDataParam) {
    console.warn(
      "[blueprint] ?blueprint-data= is deprecated, use ?blueprint= instead.",
    );
    const payload = parseBlueprintDataParam(blueprintDataParam, config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // sessionStorage blueprints are not reloaded on bare URL navigations —
  // the ephemeral runtime should boot clean.

  if (config.defaultBlueprintUrl) {
    const response = await fetch(
      new URL(config.defaultBlueprintUrl, window.location.href),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`Unable to load default blueprint: ${response.status}`);
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  const payload = buildDefaultBlueprint(config);
  saveActiveBlueprint(scopeId, payload);
  return payload;
}

export function parseImportedBlueprintPayload(rawPayload, config) {
  if (rawPayload?.version === SNAPSHOT_VERSION) {
    return {
      type: "snapshot",
      runtimeId: rawPayload.runtimeId,
      path: normalizePath(rawPayload.path, config.landingPath || "/"),
    };
  }

  return {
    type: "blueprint",
    blueprint: normalizeBlueprint(rawPayload, config),
  };
}
