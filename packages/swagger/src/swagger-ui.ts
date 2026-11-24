import type {
  OpenApiDocument,
  SwaggerSetupOptions,
} from "./interfaces/openapi.interface";

function escapeHtml(text: string): string {
  return Bun.escapeHTML(text);
}

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

function renderScalarHtml(
  title: string,
  safeJsonUrl: string,
  embeddedSpec: string,
  customCss: string,
  headAssets: string,
  bodyScripts: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
${headAssets}  <style>body { margin: 0; } ${customCss}</style>
</head>
<body>
  <script id="api-reference" data-url="${safeJsonUrl}" type="application/json">${embeddedSpec}</script>
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
): string {
  const effectiveUrl = options.url ?? options.swaggerUrl ?? rawJsonUrl;
  const extraConfig: Record<string, unknown> = {
    ...(options.swaggerOptions ?? {}),
    ...(options.validatorUrl !== undefined
      ? { validatorUrl: options.validatorUrl }
      : {}),
    ...(options.urls !== undefined ? { urls: options.urls } : {}),
    ...(options.explorer ? { filter: true } : {}),
  };
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
  const safeJsonUrl = escapeHtml(effectiveJsonUrl);
  const safeYamlUrl = yamlUrl ? escapeHtml(yamlUrl) : undefined;
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
    );
  }

  const yamlLinkHtml = safeYamlUrl
    ? `\n        <a href="${safeYamlUrl}" target="_blank" rel="noopener">OpenAPI YAML (${safeYamlUrl})</a>`
    : "";

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
    .auth-bar { display: flex; align-items: center; gap: 10px; }
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
      <div class="meta">
        <span id="api-openapi"></span>
        <a href="${safeJsonUrl}" target="_blank" rel="noopener">OpenAPI JSON (${safeJsonUrl})</a>${yamlLinkHtml}
      </div>
    </div>
    <div class="auth-bar">
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
      const spec = JSON.parse(document.getElementById("bunest-openapi-spec").textContent || "{}");
      const allSchemas = (spec.components && spec.components.schemas) || {};
      const authState = { bearer: "", apiKeyHeader: "X-API-Key", apiKeyValue: "" };

      const schemes = (spec.components && spec.components.securitySchemes) || {};
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
      titleEl.textContent = (spec.info && spec.info.title) || "API Explorer";
      if (spec.info && spec.info.version) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "v" + spec.info.version;
        titleEl.appendChild(badge);
      }
      document.getElementById("api-desc").textContent = (spec.info && spec.info.description) || "";
      document.getElementById("api-openapi").textContent = "OpenAPI " + (spec.openapi || "3.1.0");

      const groups = new Map();
      for (const [path, item] of Object.entries(spec.paths || {})) {
        for (const [method, op] of Object.entries(item || {})) {
          if (!op || typeof op !== "object" || !op.responses) continue;
          const tag = (op.tags && op.tags[0]) || "default";
          if (!groups.has(tag)) groups.set(tag, []);
          groups.get(tag).push({ path, method, op });
        }
      }

      const endpointsRoot = document.getElementById("endpoints");
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

          const descEl = document.createElement("span");
          descEl.className = "summary-text";
          descEl.textContent = op.summary || op.operationId || "";

          summary.append(badge, pathEl, descEl);
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
              headers["Authorization"] = "Bearer " + authState.bearer;
            }
            if (authState.apiKeyValue) {
              headers[authState.apiKeyHeader || "X-API-Key"] = authState.apiKeyValue;
            }
            for (const { name, input } of headerInputs) {
              if (input.value !== "") headers[name] = input.value;
            }
            if (customHdrName.value.trim() && customHdrVal.value !== "") {
              headers[customHdrName.value.trim()] = customHdrVal.value;
            }

            const init = { method: method.toUpperCase(), headers };
            if (bodyEditor && !["GET", "HEAD"].includes(init.method)) {
              headers["Content-Type"] = bodyContentType;
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

      const filterInput = document.getElementById("explorer-filter");
      if (filterInput) {
        filterInput.addEventListener("input", () => {
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
        });
      }

      if (Object.keys(allSchemas).length > 0) {
        const root = document.getElementById("schemas");
        const h2 = document.createElement("h2");
        h2.textContent = "Schemas";
        root.appendChild(h2);
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(allSchemas, null, 2);
        root.appendChild(pre);
      }
    })();
  </script>${bodyScripts}
</body>
</html>`;
}
