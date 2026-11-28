import { escapeHtml } from "@bunest/core/common";
import type {
  OpenApiDocument,
  SwaggerSetupOptions,
} from "./interfaces/openapi.interface";

function serializeSafeJsValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function renderCustomHeadAssets(options: SwaggerSetupOptions): string {
  const parts: string[] = [];
  if (options.customfavIcon) {
    parts.push(
      `  <link rel="icon" href="${escapeHtml(options.customfavIcon)}" />`,
    );
  }
  for (const cssUrl of toStringArray(options.customCssUrl)) {
    parts.push(`  <link rel="stylesheet" href="${escapeHtml(cssUrl)}" />`);
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

function renderCustomBodyScripts(options: SwaggerSetupOptions): string {
  const parts: string[] = [];
  for (const jsUrl of toStringArray(options.customJs)) {
    parts.push(`  <script src="${escapeHtml(jsUrl)}"></script>`);
  }
  for (const jsStr of toStringArray(options.customJsStr)) {
    const safeInline = jsStr.replace(/<\/script/gi, "<\\/script");
    parts.push(`  <script>${safeInline}</script>`);
  }
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

/**
 * Serializes an OpenAPI JSON document so it can be embedded safely inside an
 * inline HTML `<script>` tag without XSS breakout (`</script>`, `<!--`, etc.).
 */
export function serializeSafeJsonForHtml(document: OpenApiDocument): string {
  return serializeSafeJsValue(document);
}

interface SwaggerUrlEntry {
  url: string;
  name: string;
  yamlUrl?: string;
  version?: string;
}

function getSpecUrls(options: SwaggerSetupOptions): SwaggerUrlEntry[] {
  const raw = (options as { urls?: ReadonlyArray<SwaggerUrlEntry> }).urls;
  if (!Array.isArray(raw)) return [];
  const entries: SwaggerUrlEntry[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry.url === "string" &&
      typeof entry.name === "string"
    ) {
      entries.push({
        url: entry.url,
        name: entry.name,
        ...(typeof entry.yamlUrl === "string"
          ? { yamlUrl: entry.yamlUrl }
          : {}),
        ...(typeof entry.version === "string"
          ? { version: entry.version }
          : {}),
      });
    }
  }
  return entries;
}

function getDefaultVersion(options: SwaggerSetupOptions): string | undefined {
  const val = (options as { defaultVersion?: unknown }).defaultVersion;
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function resolveDefaultUrlIndex(
  urls: readonly SwaggerUrlEntry[],
  defaultVersion: string | undefined,
  effectiveJsonUrl: string,
): number {
  if (urls.length === 0) return -1;
  if (defaultVersion) {
    const byVersion = urls.findIndex((u) => u.version === defaultVersion);
    if (byVersion !== -1) return byVersion;
    const byName = urls.findIndex((u) => u.name === defaultVersion);
    if (byName !== -1) return byName;
    const normalized = defaultVersion.startsWith("v")
      ? defaultVersion.slice(1)
      : defaultVersion;
    const byNormalized = urls.findIndex((u) => {
      if (!u.version) return false;
      const uv = u.version.startsWith("v") ? u.version.slice(1) : u.version;
      return uv === normalized;
    });
    if (byNormalized !== -1) return byNormalized;
  }
  const byUrl = urls.findIndex((u) => u.url === effectiveJsonUrl);
  if (byUrl !== -1) return byUrl;
  return 0;
}

function renderScalarHtml(
  title: string,
  safeJsonUrl: string,
  embeddedSpec: string,
  customCss: string,
  headAssets: string,
  bodyScripts: string,
  specUrls: readonly SwaggerUrlEntry[],
  defaultUrlIndex: number,
): string {
  const apiRefScript =
    specUrls.length > 0
      ? `<script id="api-reference" data-configuration="${escapeHtml(
          JSON.stringify({
            sources: specUrls.map((u, idx) => ({
              title: u.name,
              url: u.url,
              default: idx === defaultUrlIndex,
            })),
          }),
        )}"></script>`
      : `<script id="api-reference" data-url="${safeJsonUrl}" type="application/json">${embeddedSpec}</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
${headAssets}  <style>body { margin: 0; } ${customCss}</style>
</head>
<body>
  ${apiRefScript}
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>${bodyScripts}
</body>
</html>`;
}

function renderSwaggerUiPresetHtml(
  title: string,
  rawJsonUrl: string,
  embeddedSpec: string,
  customCss: string,
  headAssets: string,
  bodyScripts: string,
  options: SwaggerSetupOptions,
  specUrls: readonly SwaggerUrlEntry[],
  defaultUrlIndex: number,
): string {
  const effectiveUrl = options.url ?? options.swaggerUrl ?? rawJsonUrl;
  const extraConfig: Record<string, unknown> = {
    ...(options.swaggerOptions ?? {}),
    ...(options.validatorUrl !== undefined
      ? { validatorUrl: options.validatorUrl }
      : {}),
    ...(options.explorer ? { filter: true } : {}),
  };

  if (specUrls.length > 0) {
    const swaggerUrls = specUrls.map((u) => ({ url: u.url, name: u.name }));
    const primaryName =
      specUrls[defaultUrlIndex >= 0 ? defaultUrlIndex : 0]?.name;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
${headAssets}  <style>body { margin: 0; } ${customCss}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.addEventListener("load", function () {
      if (window.SwaggerUIBundle) {
        window.SwaggerUIBundle(Object.assign({
          urls: ${serializeSafeJsValue(swaggerUrls)},
          "urls.primaryName": ${serializeSafeJsValue(primaryName)},
          dom_id: "#swagger-ui",
          deepLinking: true,
          layout: "StandaloneLayout",
          presets: [
            window.SwaggerUIBundle.presets.apis,
            window.SwaggerUIStandalonePreset,
          ],
        }, ${serializeSafeJsValue(extraConfig)}));
      }
    });
  </script>${bodyScripts}
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
${headAssets}  <style>body { margin: 0; } ${customCss}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script id="bunest-openapi-spec" type="application/json">${embeddedSpec}</script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.addEventListener("load", function () {
      const spec = JSON.parse(document.getElementById("bunest-openapi-spec").textContent || "{}");
      if (window.SwaggerUIBundle) {
        window.SwaggerUIBundle(Object.assign({
          url: ${serializeSafeJsValue(effectiveUrl)},
          spec,
          dom_id: "#swagger-ui",
          deepLinking: true,
        }, ${serializeSafeJsValue(extraConfig)}));
      }
    });
  </script>${bodyScripts}
</body>
</html>`;
}

/**
 * Renders a self-contained, zero-CDN interactive Try-It-Out HTML API Explorer
 * (or `"scalar"` / `"swagger-ui"` preset) for an OpenAPI 3.1 document.
 * All dynamic values are strictly escaped and rendered via DOM `.textContent`.
 */
export function renderSwaggerHtml(
  document: OpenApiDocument,
  jsonUrl: string,
  options: SwaggerSetupOptions = {},
  yamlUrl?: string,
): string {
  const title = escapeHtml(
    options.customSiteTitle ?? `${document.info.title} - API Explorer`,
  );
  const effectiveJsonUrl = options.url ?? options.swaggerUrl ?? jsonUrl;
  const specUrls = getSpecUrls(options);
  const defaultVersion = getDefaultVersion(options);
  const defaultUrlIndex = resolveDefaultUrlIndex(
    specUrls,
    defaultVersion,
    effectiveJsonUrl,
  );
  const safeJsonUrl = escapeHtml(effectiveJsonUrl);
  const embeddedSpec = serializeSafeJsonForHtml(document);
  const customCss = options.customCss
    ? options.customCss.replace(/<\/style/gi, "<\\/style")
    : "";
  const headAssets = renderCustomHeadAssets(options);
  const bodyScripts = renderCustomBodyScripts(options);

  if (options.ui === "scalar") {
    return renderScalarHtml(
      title,
      safeJsonUrl,
      embeddedSpec,
      customCss,
      headAssets,
      bodyScripts,
      specUrls,
      defaultUrlIndex,
    );
  }
  if (options.ui === "swagger-ui") {
    return renderSwaggerUiPresetHtml(
      title,
      effectiveJsonUrl,
      embeddedSpec,
      customCss,
      headAssets,
      bodyScripts,
      options,
      specUrls,
      defaultUrlIndex,
    );
  }

  const hasVersionSelector = specUrls.length > 1;
  const initialEntry =
    hasVersionSelector && defaultUrlIndex >= 0
      ? specUrls[defaultUrlIndex]
      : undefined;
  const initialJsonUrl = initialEntry?.url ?? effectiveJsonUrl;
  const initialYamlUrl = initialEntry?.yamlUrl ?? yamlUrl;
  const safeInitialJsonUrl = escapeHtml(initialJsonUrl);
  const safeInitialYamlUrl = initialYamlUrl
    ? escapeHtml(initialYamlUrl)
    : undefined;

  const yamlLinkHtml = safeInitialYamlUrl
    ? `\n        <a id="api-yaml-link" href="${safeInitialYamlUrl}" target="_blank" rel="noopener">OpenAPI YAML (${safeInitialYamlUrl})</a>`
    : "";

  let versionSelectorHtml = "";
  if (hasVersionSelector) {
    const optionTags = specUrls
      .map((entry, idx) => {
        const selected = idx === defaultUrlIndex ? " selected" : "";
        return `<option value="${escapeHtml(entry.url)}"${selected}>${escapeHtml(entry.name)}</option>`;
      })
      .join("");
    versionSelectorHtml = `\n      <select id="version-selector" aria-label="API Version" class="version-select">${optionTags}</select>`;
  }

  const explorerBarHtml = options.explorer
    ? `\n    <div style="margin-bottom: 16px;"><input id="explorer-filter" type="text" placeholder="Filter endpoints by path, summary, or tag..." /></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
${headAssets}  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f172a; --panel: #1e293b; --panel-2: #0b1220; --border: #334155;
      --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8;
      --get: #0284c7; --post: #16a34a; --put: #d97706;
      --patch: #7c3aed; --delete: #dc2626; --other: #475569;
      --ok: #16a34a; --err: #dc2626;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc; --panel: #ffffff; --panel-2: #f1f5f9; --border: #cbd5e1;
        --text: #0f172a; --muted: #475569; --accent: #0284c7;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    header { padding: 20px 32px; border-bottom: 1px solid var(--border); background: var(--panel); display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    header h1 { margin: 0 0 6px; font-size: 1.75rem; display: flex; align-items: center; gap: 10px; }
    .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; }
    .meta { color: var(--muted); font-size: 0.9rem; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
    .meta a { color: var(--accent); text-decoration: none; }
    .auth-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .version-select { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
    .auth-status { font-size: 0.8rem; color: var(--muted); }
    .auth-status.active { color: var(--ok); font-weight: 600; }
    main { max-width: 1120px; margin: 24px auto; padding: 0 24px 64px; }
    section.tag-group { margin-bottom: 28px; }
    section.tag-group h2 { margin: 0 0 12px; font-size: 1.2rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    details.op { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); margin-bottom: 10px; overflow: hidden; }
    details.op summary { cursor: pointer; padding: 12px 16px; display: flex; align-items: center; gap: 12px; list-style: none; }
    .method { font-weight: 700; font-size: 0.75rem; padding: 4px 10px; border-radius: 4px; color: #fff; min-width: 68px; text-align: center; text-transform: uppercase; }
    .method-get { background: var(--get); } .method-post { background: var(--post); }
    .method-put { background: var(--put); } .method-patch { background: var(--patch); }
    .method-delete { background: var(--delete); } .method-other { background: var(--other); }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .summary-text { color: var(--muted); font-size: 0.9rem; }
    .op-body { padding: 16px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; }
    .try-panel { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--panel-2); display: flex; flex-direction: column; gap: 12px; }
    .try-panel h4 { margin: 0 0 6px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .param-grid { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 8px 12px; align-items: center; }
    .param-label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
    .req-star { color: var(--err); margin-left: 3px; }
    input[type="text"], input[type="password"], textarea {
      width: 100%; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--panel); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem;
    }
    textarea.body-editor { min-height: 110px; resize: vertical; }
    .btn { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 7px 14px; font-weight: 600; cursor: pointer; font-size: 0.85rem; }
    .btn-secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    pre { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 0.83rem; margin: 0; }
    .resp-box { display: none; flex-direction: column; gap: 8px; }
    .resp-status { font-weight: 700; font-size: 0.85rem; }
    .resp-status.ok { color: var(--ok); }
    .resp-status.err { color: var(--err); }
    dialog.auth-modal { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); color: var(--text); max-width: 480px; width: 92%; padding: 20px; }
    dialog.auth-modal::backdrop { background: rgba(2, 6, 23, 0.7); }
    .auth-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .auth-field label { font-size: 0.85rem; font-weight: 600; }
    .schemas-section { margin-top: 32px; }
    ${customCss}
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="api-title"></h1>
      <p id="api-desc" style="margin: 6px 0 10px;"></p>
      <div id="api-meta" class="meta">
        <span id="api-openapi"></span>
        <a id="api-json-link" href="${safeInitialJsonUrl}" target="_blank" rel="noopener">OpenAPI JSON (${safeInitialJsonUrl})</a>${yamlLinkHtml}
      </div>
    </div>
    <div class="auth-bar">${versionSelectorHtml}
      <span id="auth-status" class="auth-status">Not authorized</span>
      <button id="open-auth-btn" class="btn btn-secondary" type="button">Authorize</button>
    </div>
  </header>

  <dialog id="auth-dialog" class="auth-modal">
    <h3 style="margin-top: 0;">Authorize Requests</h3>
    <div class="auth-field">
      <label for="auth-bearer">Bearer Token (Authorization: Bearer &lt;token&gt;)</label>
      <input id="auth-bearer" type="password" placeholder="Paste JWT or Bearer token" />
    </div>
    <div class="auth-field">
      <label for="auth-apikey-header">API Key Header Name</label>
      <input id="auth-apikey-header" type="text" value="X-API-Key" />
    </div>
    <div class="auth-field">
      <label for="auth-apikey-value">API Key Value</label>
      <input id="auth-apikey-value" type="password" placeholder="Paste API key" />
    </div>
    <div class="btn-row">
      <button id="save-auth-btn" class="btn" type="button">Apply</button>
      <button id="clear-auth-btn" class="btn btn-secondary" type="button">Clear</button>
      <button id="close-auth-btn" class="btn btn-secondary" type="button">Close</button>
    </div>
  </dialog>

  <main>${explorerBarHtml}
    <div id="endpoints"></div>
    <div id="schemas" class="schemas-section"></div>
  </main>

  <script id="bunest-openapi-spec" type="application/json">${embeddedSpec}</script>
  <script>
    (function () {
      const initialSpec = JSON.parse(document.getElementById("bunest-openapi-spec").textContent || "{}");
      const specUrls = ${serializeSafeJsValue(specUrls)};
      const defaultUrlIndex = ${defaultUrlIndex};
      const embeddedSpecUrl = ${serializeSafeJsValue(effectiveJsonUrl)};

      let currentSpec = initialSpec;
      let allSchemas = (currentSpec.components && currentSpec.components.schemas) || {};
      const authState = { bearer: "", apiKeyHeader: "X-API-Key", apiKeyValue: "" };

      const schemes = (currentSpec.components && currentSpec.components.securitySchemes) || {};
      for (const scheme of Object.values(schemes)) {
        if (scheme && scheme.type === "apiKey" && scheme.in === "header" && scheme.name) {
          authState.apiKeyHeader = scheme.name;
          break;
        }
      }

      const authDialog = document.getElementById("auth-dialog");
      const authStatus = document.getElementById("auth-status");
      const bearerInput = document.getElementById("auth-bearer");
      const apiKeyHeaderInput = document.getElementById("auth-apikey-header");
      const apiKeyValueInput = document.getElementById("auth-apikey-value");
      apiKeyHeaderInput.value = authState.apiKeyHeader;

      function updateAuthStatus() {
        const active = [];
        if (authState.bearer) active.push("Bearer");
        if (authState.apiKeyValue) active.push(authState.apiKeyHeader || "API Key");
        if (active.length > 0) {
          authStatus.textContent = "Authorized (" + active.join(", ") + ")";
          authStatus.className = "auth-status active";
        } else {
          authStatus.textContent = "Not authorized";
          authStatus.className = "auth-status";
        }
      }

      document.getElementById("open-auth-btn").addEventListener("click", () => {
        bearerInput.value = authState.bearer;
        apiKeyHeaderInput.value = authState.apiKeyHeader;
        apiKeyValueInput.value = authState.apiKeyValue;
        if (typeof authDialog.showModal === "function") authDialog.showModal();
        else authDialog.setAttribute("open", "open");
      });
      document.getElementById("save-auth-btn").addEventListener("click", () => {
        authState.bearer = bearerInput.value.trim();
        authState.apiKeyHeader = apiKeyHeaderInput.value.trim() || "X-API-Key";
        authState.apiKeyValue = apiKeyValueInput.value.trim();
        updateAuthStatus();
        if (typeof authDialog.close === "function") authDialog.close();
        else authDialog.removeAttribute("open");
      });
      document.getElementById("clear-auth-btn").addEventListener("click", () => {
        authState.bearer = "";
        authState.apiKeyValue = "";
        bearerInput.value = "";
        apiKeyValueInput.value = "";
        updateAuthStatus();
      });
      document.getElementById("close-auth-btn").addEventListener("click", () => {
        if (typeof authDialog.close === "function") authDialog.close();
        else authDialog.removeAttribute("open");
      });

      function setHeaderCaseInsensitive(target, key, value) {
        const lower = key.toLowerCase();
        for (const existing of Object.keys(target)) {
          if (existing.toLowerCase() === lower) {
            delete target[existing];
          }
        }
        target[lower === "accept" ? "Accept" : key] = value;
      }

      function resolveSchema(schema, depth) {
        if (!schema || depth > 6) return {};
        if (schema.$ref && typeof schema.$ref === "string") {
          const name = schema.$ref.replace(/^#\\/components\\/schemas\\//, "");
          return resolveSchema(allSchemas[name], depth + 1);
        }
        return schema;
      }

      function buildExampleValue(rawSchema, depth) {
        if (!rawSchema || depth > 5) return null;
        if (rawSchema.example !== undefined) return rawSchema.example;
        if (rawSchema.default !== undefined) return rawSchema.default;
        const schema = resolveSchema(rawSchema, depth);
        if (schema.example !== undefined) return schema.example;
        if (schema.default !== undefined) return schema.default;
        if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
        const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== "null") : schema.type;
        if (t === "object" || schema.properties) {
          const obj = {};
          for (const [k, prop] of Object.entries(schema.properties || {})) {
            obj[k] = buildExampleValue(prop, depth + 1);
          }
          return obj;
        }
        if (t === "array") {
          return schema.items ? [buildExampleValue(schema.items, depth + 1)] : [];
        }
        if (t === "integer" || t === "number") return 0;
        if (t === "boolean") return true;
        if (schema.format === "email") return "user@example.com";
        if (schema.format === "uuid") return "00000000-0000-0000-0000-000000000000";
        if (schema.format === "date-time") return new Date().toISOString();
        return "string";
      }

      const titleEl = document.getElementById("api-title");
      const descEl = document.getElementById("api-desc");
      const openapiEl = document.getElementById("api-openapi");
      const metaEl = document.getElementById("api-meta");
      const jsonLinkEl = document.getElementById("api-json-link");
      const endpointsRoot = document.getElementById("endpoints");
      const schemasRoot = document.getElementById("schemas");
      const filterInput = document.getElementById("explorer-filter");
      const versionSelect = document.getElementById("version-selector");

      function applyEndpointFilter() {
        if (!filterInput) return;
        const q = filterInput.value.trim().toLowerCase();
        for (const section of endpointsRoot.querySelectorAll("section.tag-group")) {
          let visibleCount = 0;
          for (const op of section.querySelectorAll("details.op")) {
            const match = !q || (op.dataset.search || "").includes(q);
            op.style.display = match ? "" : "none";
            if (match) visibleCount++;
          }
          section.style.display = visibleCount > 0 ? "" : "none";
        }
      }

      if (filterInput) {
        filterInput.addEventListener("input", applyEndpointFilter);
      }

      function isSafeNavigableUrl(url) {
        if (typeof url !== "string" || !url) return false;
        const trimmed = url.trim().toLowerCase();
        return !trimmed.startsWith("javascript:") && !trimmed.startsWith("data:") && !trimmed.startsWith("vbscript:");
      }

      function updateSpecLinks(activeEntry) {
        if (!activeEntry) return;
        if (jsonLinkEl && isSafeNavigableUrl(activeEntry.url)) {
          jsonLinkEl.setAttribute("href", activeEntry.url);
          jsonLinkEl.textContent = "OpenAPI JSON (" + activeEntry.url + ")";
        }
        let yamlLinkEl = document.getElementById("api-yaml-link");
        if (activeEntry.yamlUrl && isSafeNavigableUrl(activeEntry.yamlUrl)) {
          if (!yamlLinkEl && metaEl) {
            yamlLinkEl = document.createElement("a");
            yamlLinkEl.id = "api-yaml-link";
            yamlLinkEl.target = "_blank";
            yamlLinkEl.rel = "noopener";
            metaEl.appendChild(yamlLinkEl);
          }
          if (yamlLinkEl) {
            yamlLinkEl.style.display = "";
            yamlLinkEl.setAttribute("href", activeEntry.yamlUrl);
            yamlLinkEl.textContent = "OpenAPI YAML (" + activeEntry.yamlUrl + ")";
          }
        } else if (yamlLinkEl) {
          yamlLinkEl.style.display = "none";
        }
      }

      function renderSpec(spec, activeEntry) {
        currentSpec = spec || {};
        allSchemas = (currentSpec.components && currentSpec.components.schemas) || {};

        titleEl.textContent = (currentSpec.info && currentSpec.info.title) || "API Explorer";
        if (currentSpec.info && currentSpec.info.version) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "v" + currentSpec.info.version;
          titleEl.appendChild(badge);
        }
        descEl.textContent = (currentSpec.info && currentSpec.info.description) || "";
        openapiEl.textContent = "OpenAPI " + (currentSpec.openapi || "3.1.0");
        updateSpecLinks(activeEntry);

        const groups = new Map();
        for (const [path, item] of Object.entries(currentSpec.paths || {})) {
          for (const [method, op] of Object.entries(item || {})) {
            if (!op || typeof op !== "object" || !op.responses) continue;
            const tag = (op.tags && op.tags[0]) || "default";
            if (!groups.has(tag)) groups.set(tag, []);
            groups.get(tag).push({ path, method, op });
          }
        }

        endpointsRoot.textContent = "";
        for (const [tag, ops] of groups.entries()) {
          const section = document.createElement("section");
          section.className = "tag-group";
          section.dataset.tag = tag.toLowerCase();
          const heading = document.createElement("h2");
          heading.textContent = tag;
          section.appendChild(heading);

          for (const { path, method, op } of ops) {
            const details = document.createElement("details");
            details.className = "op";
            details.dataset.search = (path + " " + method + " " + (op.summary || "") + " " + tag).toLowerCase();
            const summary = document.createElement("summary");

            const badge = document.createElement("span");
            const known = ["get", "post", "put", "patch", "delete"].includes(method);
            badge.className = "method " + (known ? "method-" + method : "method-other");
            badge.textContent = method.toUpperCase();

            const pathEl = document.createElement("span");
            pathEl.className = "path";
            pathEl.textContent = path;

            const descNode = document.createElement("span");
            descNode.className = "summary-text";
            descNode.textContent = op.summary || op.operationId || "";

            summary.append(badge, pathEl, descNode);
            details.appendChild(summary);

            const body = document.createElement("div");
            body.className = "op-body";
            if (op.description) {
              const p = document.createElement("p");
              p.style.margin = "0";
              p.textContent = op.description;
              body.appendChild(p);
            }

            const tryPanel = document.createElement("div");
            tryPanel.className = "try-panel";
            const params = Array.isArray(op.parameters) ? op.parameters : [];
            const pathInputs = [];
            const queryInputs = [];
            const headerInputs = [];

            function appendParamSection(titleText, list, collector) {
              if (list.length === 0) return;
              const h4 = document.createElement("h4");
              h4.textContent = titleText;
              const grid = document.createElement("div");
              grid.className = "param-grid";
              for (const p of list) {
                const label = document.createElement("label");
                label.className = "param-label";
                label.textContent = p.name;
                if (p.required) {
                  const star = document.createElement("span");
                  star.className = "req-star";
                  star.textContent = "*";
                  label.appendChild(star);
                }
                const input = document.createElement("input");
                input.type = "text";
                input.placeholder = p.description || (p.schema && p.schema.type ? String(p.schema.type) : "value");
                if (p.example !== undefined) input.value = String(p.example);
                else if (p.schema && p.schema.default !== undefined) input.value = String(p.schema.default);
                else if (
                  typeof p.name === "string" &&
                  p.name.toLowerCase() === "accept" &&
                  p.schema &&
                  Array.isArray(p.schema.enum) &&
                  p.schema.enum.length > 0
                ) {
                  input.value = String(p.schema.enum[0]);
                }
                grid.append(label, input);
                collector.push({ name: p.name, input });
              }
              tryPanel.append(h4, grid);
            }

            appendParamSection("Path Parameters", params.filter((p) => p.in === "path"), pathInputs);
            appendParamSection("Query Parameters", params.filter((p) => p.in === "query"), queryInputs);
            appendParamSection("Header Parameters", params.filter((p) => p.in === "header"), headerInputs);

            const customHdrTitle = document.createElement("h4");
            customHdrTitle.textContent = "Custom Header (optional)";
            const customHdrGrid = document.createElement("div");
            customHdrGrid.className = "param-grid";
            const customHdrName = document.createElement("input");
            customHdrName.type = "text";
            customHdrName.placeholder = "Header-Name";
            const customHdrVal = document.createElement("input");
            customHdrVal.type = "text";
            customHdrVal.placeholder = "Header Value";
            customHdrGrid.append(customHdrName, customHdrVal);
            tryPanel.append(customHdrTitle, customHdrGrid);

            let bodyEditor = null;
            let bodyContentType = "application/json";
            if (op.requestBody && op.requestBody.content) {
              const mediaEntries = Object.entries(op.requestBody.content);
              if (mediaEntries.length > 0) {
                bodyContentType = mediaEntries[0][0];
                const mediaObj = mediaEntries[0][1] || {};
                const h4 = document.createElement("h4");
                h4.textContent = "Request Body (" + bodyContentType + ")";
                bodyEditor = document.createElement("textarea");
                bodyEditor.className = "body-editor";
                const initialExample =
                  mediaObj.example !== undefined
                    ? mediaObj.example
                    : buildExampleValue(mediaObj.schema, 0);
                bodyEditor.value =
                  initialExample !== null && initialExample !== undefined
                    ? JSON.stringify(initialExample, null, 2)
                    : "{}";
                tryPanel.append(h4, bodyEditor);
              }
            }

            const btnRow = document.createElement("div");
            btnRow.className = "btn-row";
            const execBtn = document.createElement("button");
            execBtn.type = "button";
            execBtn.className = "btn";
            execBtn.textContent = "Execute " + method.toUpperCase();
            btnRow.appendChild(execBtn);

            const respBox = document.createElement("div");
            respBox.className = "resp-box";
            const respStatusEl = document.createElement("div");
            respStatusEl.className = "resp-status";
            const respHeadersPre = document.createElement("pre");
            const respBodyPre = document.createElement("pre");
            respBox.append(respStatusEl, respHeadersPre, respBodyPre);

            execBtn.addEventListener("click", async () => {
              respBox.style.display = "flex";
              respStatusEl.className = "resp-status";
              respStatusEl.textContent = "Executing...";
              respHeadersPre.textContent = "";
              respBodyPre.textContent = "";

              let resolvedPath = path;
              for (const { name, input } of pathInputs) {
                resolvedPath = resolvedPath.replace(
                  "{" + name + "}",
                  encodeURIComponent(input.value),
                );
              }

              const qs = new URLSearchParams();
              for (const { name, input } of queryInputs) {
                if (input.value !== "") qs.append(name, input.value);
              }
              const finalUrl = qs.toString() ? resolvedPath + "?" + qs.toString() : resolvedPath;

              const headers = {};
              if (authState.bearer) {
                setHeaderCaseInsensitive(headers, "Authorization", "Bearer " + authState.bearer);
              }
              if (authState.apiKeyValue) {
                setHeaderCaseInsensitive(headers, authState.apiKeyHeader || "X-API-Key", authState.apiKeyValue);
              }
              for (const { name, input } of headerInputs) {
                if (input.value !== "") {
                  if (name.toLowerCase() === "accept") {
                    setHeaderCaseInsensitive(headers, "Accept", input.value.trim());
                  } else {
                    setHeaderCaseInsensitive(headers, name, input.value);
                  }
                }
              }
              if (customHdrName.value.trim() && customHdrVal.value !== "") {
                setHeaderCaseInsensitive(headers, customHdrName.value.trim(), customHdrVal.value);
              }

              const init = { method: method.toUpperCase(), headers };
              if (bodyEditor && !["GET", "HEAD"].includes(init.method)) {
                setHeaderCaseInsensitive(headers, "Content-Type", bodyContentType);
                init.body = bodyEditor.value;
              }

              try {
                const t0 = performance.now();
                const res = await fetch(finalUrl, init);
                const elapsed = Math.round(performance.now() - t0);
                const rawText = await res.text();

                respStatusEl.textContent = "HTTP " + res.status + " " + (res.statusText || "") + " (" + elapsed + "ms)";
                respStatusEl.className = "resp-status " + (res.ok ? "ok" : "err");

                const hdrLines = [];
                res.headers.forEach((v, k) => hdrLines.push(k + ": " + v));
                respHeadersPre.textContent = hdrLines.join("\\n");

                try {
                  respBodyPre.textContent = JSON.stringify(JSON.parse(rawText), null, 2);
                } catch {
                  respBodyPre.textContent = rawText;
                }
              } catch (err) {
                respStatusEl.textContent = "Network Error";
                respStatusEl.className = "resp-status err";
                respBodyPre.textContent = String(err);
              }
            });

            tryPanel.append(btnRow, respBox);
            body.appendChild(tryPanel);

            const specDetails = document.createElement("details");
            const specSum = document.createElement("summary");
            specSum.textContent = "Operation Schema";
            const pre = document.createElement("pre");
            pre.textContent = JSON.stringify({
              operationId: op.operationId,
              security: op.security,
              parameters: op.parameters,
              requestBody: op.requestBody,
              responses: op.responses
            }, null, 2);
            specDetails.append(specSum, pre);
            body.appendChild(specDetails);

            details.appendChild(body);
            section.appendChild(details);
          }
          endpointsRoot.appendChild(section);
        }

        applyEndpointFilter();

        schemasRoot.textContent = "";
        if (Object.keys(allSchemas).length > 0) {
          const h2 = document.createElement("h2");
          h2.textContent = "Schemas";
          schemasRoot.appendChild(h2);
          const pre = document.createElement("pre");
          pre.textContent = JSON.stringify(allSchemas, null, 2);
          schemasRoot.appendChild(pre);
        }
      }

      function findUrlIndexByVersionParam(param) {
        if (!param) return -1;
        for (let i = 0; i < specUrls.length; i++) {
          if (specUrls[i].version === param) return i;
        }
        for (let i = 0; i < specUrls.length; i++) {
          if (specUrls[i].name === param) return i;
        }
        const normalized = param.startsWith("v") ? param.slice(1) : param;
        for (let i = 0; i < specUrls.length; i++) {
          const v = specUrls[i].version;
          if (!v) continue;
          const uv = v.startsWith("v") ? v.slice(1) : v;
          if (uv === normalized) return i;
        }
        return -1;
      }

      let loadSeq = 0;
      async function loadVersionSpec(entry, updateHistory) {
        if (!entry || !entry.url) return;
        const seq = ++loadSeq;
        try {
          const res = await fetch(entry.url);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const nextSpec = await res.json();
          if (seq !== loadSeq) return;
          renderSpec(nextSpec, entry);
          if (updateHistory && window.history && typeof window.history.replaceState === "function") {
            const nextUrl = new URL(window.location.href);
            nextUrl.searchParams.set("version", entry.version || entry.name);
            window.history.replaceState(null, "", nextUrl.toString());
          }
        } catch (err) {
          if (seq !== loadSeq) return;
          const errEl = document.createElement("p");
          errEl.style.color = "var(--err)";
          errEl.textContent = "Failed to load OpenAPI spec (" + entry.url + "): " + String(err);
          endpointsRoot.textContent = "";
          endpointsRoot.appendChild(errEl);
        }
      }

      if (versionSelect && specUrls.length > 1) {
        const qp = new URLSearchParams(window.location.search).get("version");
        const matchedIdx = findUrlIndexByVersionParam(qp);
        const initialIdx = matchedIdx !== -1 ? matchedIdx : (defaultUrlIndex >= 0 ? defaultUrlIndex : 0);
        versionSelect.selectedIndex = initialIdx;

        const targetEntry = specUrls[initialIdx];
        if (matchedIdx !== -1 && initialIdx !== defaultUrlIndex && targetEntry && targetEntry.url !== embeddedSpecUrl) {
          renderSpec(initialSpec, specUrls[defaultUrlIndex >= 0 ? defaultUrlIndex : 0]);
          loadVersionSpec(targetEntry, false);
        } else {
          renderSpec(initialSpec, targetEntry);
        }

        versionSelect.addEventListener("change", () => {
          const selected = specUrls[versionSelect.selectedIndex];
          if (selected) {
            loadVersionSpec(selected, true);
          }
        });
      } else {
        renderSpec(initialSpec, null);
      }
    })();
  </script>${bodyScripts}
</body>
</html>`;
}
