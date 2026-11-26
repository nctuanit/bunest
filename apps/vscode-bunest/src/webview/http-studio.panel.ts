import { existsSyncPath, resolve } from "@bunest/core";
import * as vscode from "vscode";
import type { ExtractedRouteEntry } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";
import {
  buildSampleObjectFromFields,
  extractRouteSchema,
  parseDtoFields,
  type ExtractedRouteSchema,
} from "./route-schema-extractor";
import {
  BUNEST_PREVIEW_SCHEME,
  buildPlannedFilesWorkspaceEdit,
  bunestPreviewProvider,
  extractCandidateResponseFields,
  isBinaryOrStreamContentType,
  planHttpExchangeAsTest,
  readExistingFileMap,
  type HttpStudioExchange,
} from "./save-as-test";

export interface HttpHistoryEntry {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly status: number;
  readonly elapsedMs: number;
  readonly timestamp: string;
}

const requestHistory: HttpHistoryEntry[] = [];
let savedBearerToken = "";

/**
 * Re-exported for backwards compatibility with existing unit tests.
 */
export function parseDtoClassBodyToSample(
  classBody: string,
): Record<string, unknown> {
  return buildSampleObjectFromFields(parseDtoFields(classBody));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStudioHtml(payload: {
  readonly baseUrl: string;
  readonly environments: readonly { name: string; baseUrl: string }[];
  readonly schemas: readonly ExtractedRouteSchema[];
  readonly selectedKey?: string;
  readonly bearerToken: string;
  readonly history: readonly HttpHistoryEntry[];
}): string {
  const safeDataJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  :root {
    --radius: 6px;
    --border: var(--vscode-panel-border, rgba(128,128,128,0.22));
    --bg: var(--vscode-editor-background);
    --bg-side: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --bg-elev: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --focus: var(--vscode-focusBorder, #3b82f6);
    --mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  body {
    margin: 0;
    height: 100vh;
    display: grid;
    grid-template-columns: 260px 1fr;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
    overflow: hidden;
  }

  /* Left Sidebar — Swagger/Scalar Endpoint Explorer */
  .sidebar {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-side);
    overflow: hidden;
  }
  .sidebar-head {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sidebar-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .sidebar-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px;
  }
  .ctrl-group {
    margin-bottom: 10px;
  }
  .ctrl-name {
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    padding: 4px 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ep-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
    border: 1px solid transparent;
  }
  .ep-item:hover { background: var(--vscode-list-hoverBackground); }
  .ep-item.active {
    background: var(--vscode-list-activeSelectionBackground, rgba(59,130,246,0.16));
    color: var(--vscode-list-activeSelectionForeground, var(--fg));
    border-color: var(--focus);
  }
  .ep-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 11.5px;
    flex: 1;
  }

  /* Method Pills */
  .m-pill {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 800;
    padding: 2px 5px;
    border-radius: 4px;
    min-width: 44px;
    text-align: center;
    letter-spacing: 0.02em;
    color: #fff;
  }
  .m-GET { background: #16a34a; }
  .m-POST { background: #2563eb; }
  .m-PUT { background: #d97706; }
  .m-PATCH { background: #ca8a04; }
  .m-DELETE { background: #dc2626; }
  .m-HEAD, .m-OPTIONS { background: #64748b; }

  /* Main Workspace */
  .main {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .endpoint-banner {
    padding: 10px 16px 6px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    background: var(--bg-side);
  }
  .endpoint-title { font-weight: 700; font-size: 14px; }
  .tag-pill {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-weight: 600;
  }
  .lock-pill {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(234, 179, 8, 0.18);
    color: #eab308;
    border: 1px solid rgba(234, 179, 8, 0.4);
    font-weight: 600;
  }

  /* URL Bar */
  .url-bar {
    display: flex;
    gap: 8px;
    padding: 8px 16px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-side);
    align-items: center;
  }
  input, select, textarea {
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: var(--radius);
    padding: 6px 9px;
    font-size: 12px;
    font-family: var(--mono);
  }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--focus); border-color: var(--focus); }
  #urlInput { flex: 1; font-size: 12.5px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 14px;
    border-radius: var(--radius);
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.ghost {
    background: transparent;
    color: var(--muted);
    padding: 4px 8px;
  }
  button.ghost:hover { color: var(--fg); background: var(--vscode-list-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: wait; }

  /* Split Request / Response */
  .split {
    display: grid;
    grid-template-rows: minmax(230px, 1fr) minmax(210px, 1fr);
    flex: 1;
    overflow: hidden;
  }
  .pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .pane.req-pane { border-bottom: 1px solid var(--border); }

  .tabs {
    display: flex;
    gap: 4px;
    padding: 6px 16px 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    align-items: center;
  }
  .tab {
    background: transparent;
    color: var(--muted);
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .tab:hover { color: var(--fg); background: transparent; }
  .tab.active { color: var(--fg); border-bottom-color: var(--focus); }
  .cnt {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    margin-left: 4px;
  }

  .pane-body {
    flex: 1;
    overflow: auto;
    padding: 12px 16px;
  }

  /* Swagger-style Param & Schema Tables */
  .section-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .kv-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 14px;
  }
  .kv-table th {
    text-align: left;
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  .kv-table td {
    padding: 5px 6px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .kv-table input[type="text"], .kv-table input[type="number"], .kv-table select {
    width: 100%;
    padding: 4px 7px;
  }
  .req-star { color: #ef4444; font-weight: 800; margin-left: 2px; }
  .type-chip {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--muted);
    background: var(--vscode-textBlockQuote-background);
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .constraint-chip {
    font-size: 10px;
    color: #38bdf8;
    background: rgba(56,189,248,0.12);
    padding: 1px 5px;
    border-radius: 4px;
    margin-right: 4px;
  }

  /* Body Sub-tabs */
  .sub-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .seg {
    display: inline-flex;
    background: var(--bg-side);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px;
  }
  .seg button {
    background: transparent;
    color: var(--muted);
    padding: 4px 10px;
    font-size: 11.5px;
    border-radius: 4px;
  }
  .seg button.active {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  #rawBody {
    width: 100%;
    min-height: 150px;
    resize: vertical;
    line-height: 1.5;
  }

  /* Response Bar & Syntax Highlight */
  .res-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-side);
    flex-wrap: wrap;
  }
  .status-pill {
    padding: 3px 9px;
    border-radius: 999px;
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 700;
    color: #fff;
    background: #64748b;
  }
  .status-pill.ok { background: #16a34a; }
  .status-pill.warn { background: #ca8a04; }
  .status-pill.err { background: #dc2626; }
  .stat { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  pre.code {
    margin: 0;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--vscode-textBlockQuote-background);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .jk { color: #7dd3fc; }
  .js { color: #86efac; }
  .jn { color: #fcd34d; }
  .jb { color: #f472b6; }
  .jl { color: #94a3b8; font-style: italic; }

  .token-banner {
    display: none;
    margin: 8px 16px 0;
    padding: 7px 12px;
    border-radius: var(--radius);
    background: rgba(37, 99, 235, 0.14);
    border: 1px solid rgba(59, 130, 246, 0.45);
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }
  .empty { color: var(--muted); font-size: 12px; padding: 10px 0; }
</style>
</head>
<body>
  <!-- Left Endpoints Explorer -->
  <aside class="sidebar">
    <div class="sidebar-head">
      <div class="sidebar-title">
        <span>Endpoints (<span id="epTotal">0</span>)</span>
      </div>
      <input id="epSearch" type="search" placeholder="Filter routes..." oninput="renderSidebar()" />
    </div>
    <div id="epList" class="sidebar-list"></div>
  </aside>

  <!-- Right Request + Response Studio -->
  <main class="main">
    <div class="endpoint-banner">
      <span id="epMethodBadge" class="m-pill m-GET">GET</span>
      <span id="epTitle" class="endpoint-title">/live</span>
      <span id="epHandler" class="stat"></span>
      <span id="epTags"></span>
      <span id="epLock" class="lock-pill" style="display:none">🔒 Auth Required</span>
    </div>

    <div class="url-bar">
      <select id="envSelect" title="Environment" onchange="onEnvChange()"></select>
      <select id="methodSelect" onchange="onMethodChange()">
        <option>GET</option><option>POST</option><option>PUT</option>
        <option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option>
      </select>
      <input id="urlInput" type="text" placeholder="http://localhost:3000/items" />
      <button id="sendBtn" onclick="sendRequest()">▶ Send</button>
    </div>

    <div class="split">
      <!-- Request Builder Pane -->
      <section class="pane req-pane">
        <div class="tabs">
          <button class="tab active" data-rtab="params" onclick="switchReqTab('params', this)">Params<span id="cntParams" class="cnt">0</span></button>
          <button class="tab" data-rtab="headers" onclick="switchReqTab('headers', this)">Headers<span id="cntHeaders" class="cnt">0</span></button>
          <button class="tab" data-rtab="auth" onclick="switchReqTab('auth', this)">Auth</button>
          <button class="tab" data-rtab="body" onclick="switchReqTab('body', this)">Body<span id="cntBody" class="cnt">0</span></button>
          <button class="tab" data-rtab="history" onclick="switchReqTab('history', this)">History<span id="cntHist" class="cnt">0</span></button>
        </div>

        <div class="pane-body">
          <!-- PARAMS TAB (Path + Query like Swagger) -->
          <div id="rtab-params">
            <div id="pathParamsSection" style="display:none;">
              <div class="section-hdr"><span>Path Parameters</span></div>
              <table class="kv-table">
                <thead><tr><th style="width:160px">Name</th><th style="width:100px">Type</th><th>Value</th></tr></thead>
                <tbody id="pathParamsBody"></tbody>
              </table>
            </div>

            <div class="section-hdr">
              <span>Query Parameters</span>
              <button class="ghost" onclick="addQueryRow()">+ Add Query Param</button>
            </div>
            <table class="kv-table">
              <thead><tr><th style="width:28px"></th><th style="width:150px">Key</th><th style="width:95px">Type</th><th>Value</th><th style="width:28px"></th></tr></thead>
              <tbody id="queryParamsBody"></tbody>
            </table>
          </div>

          <!-- HEADERS TAB -->
          <div id="rtab-headers" style="display:none;">
            <div class="section-hdr">
              <span>Request Headers</span>
              <button class="ghost" onclick="addHeaderRow()">+ Add Header</button>
            </div>
            <table class="kv-table">
              <thead><tr><th style="width:28px"></th><th style="width:190px">Header</th><th>Value</th><th style="width:28px"></th></tr></thead>
              <tbody id="headersBody"></tbody>
            </table>
          </div>

          <!-- AUTH TAB -->
          <div id="rtab-auth" style="display:none;">
            <div class="section-hdr"><span>Authorization</span></div>
            <div style="display:grid; grid-template-columns:160px 1fr; gap:10px; max-width:620px; align-items:center;">
              <label class="stat">Auth Type</label>
              <select id="authType" onchange="renderAuthFields()">
                <option value="bearer">Bearer Token (JWT)</option>
                <option value="apikey">API Key Header</option>
                <option value="none">No Auth</option>
              </select>
              <label class="stat" id="authLabel1">Bearer Token</label>
              <input id="bearerInput" type="text" placeholder="eyJhbGciOiJIUzI1NiIs..." />
              <label class="stat" id="authLabel2" style="display:none;">Header Name</label>
              <input id="apiKeyHeader" type="text" value="x-api-key" style="display:none;" />
            </div>
          </div>

          <!-- BODY TAB (Swagger Form + Raw JSON + Schema) -->
          <div id="rtab-body" style="display:none;">
            <div class="sub-bar">
              <div class="seg">
                <button id="bmode-form" class="active" onclick="setBodyMode('form')">Form Fields</button>
                <button id="bmode-json" onclick="setBodyMode('json')">Raw JSON</button>
                <button id="bmode-schema" onclick="setBodyMode('schema')">DTO Schema</button>
              </div>
              <div style="display:flex; gap:6px; align-items:center;">
                <span id="bodyDtoLabel" class="type-chip" style="display:none;"></span>
                <button class="secondary" onclick="resetBodySample()">Reset Sample</button>
                <button class="secondary" onclick="formatRawJson()">Format JSON</button>
              </div>
            </div>

            <div id="body-form-view"></div>
            <div id="body-json-view" style="display:none;">
              <textarea id="rawBody" oninput="onRawJsonEdit()" spellcheck="false"></textarea>
            </div>
            <div id="body-schema-view" style="display:none;"></div>
          </div>

          <!-- HISTORY TAB -->
          <div id="rtab-history" style="display:none;"></div>
        </div>
      </section>

      <!-- Response Inspector Pane -->
      <section class="pane res-pane">
        <div class="res-bar">
          <span id="resStatus" class="status-pill">Ready</span>
          <span id="resTime" class="stat"></span>
          <span id="resSize" class="stat"></span>
          <span id="resExpected" class="stat" style="margin-left:auto;"></span>
          <button id="saveAsTestBtn" class="secondary" style="display:none;" onclick="saveAsTest()">🧪 Save as Test</button>
          <button class="secondary" onclick="copyResBody()">Copy Body</button>
          <button class="secondary" onclick="copyCurl()">Copy cURL</button>
        </div>

        <div id="tokenBanner" class="token-banner">
          <span>Detected access token in JSON response.</span>
          <button onclick="useDetectedToken()">Use as Bearer Token</button>
        </div>

        <div class="tabs">
          <button class="tab active" onclick="switchResTab('pretty', this)">Response Body</button>
          <button class="tab" onclick="switchResTab('headers', this)">Headers<span id="cntResHeaders" class="cnt">0</span></button>
          <button class="tab" onclick="switchResTab('curl', this)">cURL</button>
        </div>

        <div class="pane-body">
          <div id="restab-pretty"><pre id="resPretty" class="code">Select an endpoint or click ▶ Send (⌘/Ctrl+Enter).</pre></div>
          <div id="restab-headers" style="display:none;"><table class="kv-table"><tbody id="resHeadersBody"></tbody></table></div>
          <div id="restab-curl" style="display:none;"><pre id="resCurl" class="code"></pre></div>
        </div>
      </section>
    </div>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const INIT = ${safeDataJson};

    let currentSchema = null;
    let currentBaseUrl = INIT.baseUrl;
    let pathValues = {};
    let queryRows = [];
    let headerRows = [];
    let bodyMode = "form";
    let bodyObj = {};
    let lastRawBody = "";
    let lastCurl = "";
    let detectedToken = "";
    let historyList = INIT.history || [];

    function esc(s) {
      return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function highlightJson(text) {
      try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        return esc(pretty).replace(
          /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
          (m) => {
            if (/^"/.test(m)) return /:$/.test(m) ? '<span class="jk">' + m + '</span>' : '<span class="js">' + m + '</span>';
            if (/true|false/.test(m)) return '<span class="jb">' + m + '</span>';
            if (/null/.test(m)) return '<span class="jl">' + m + '</span>';
            return '<span class="jn">' + m + '</span>';
          }
        );
      } catch {
        return esc(text);
      }
    }

    function initEnvs() {
      const sel = document.getElementById("envSelect");
      sel.innerHTML = INIT.environments.map((e) =>
        '<option value="' + esc(e.baseUrl) + '">' + esc(e.name) + ' · ' + esc(e.baseUrl) + '</option>'
      ).join("");
      sel.value = currentBaseUrl;
      document.getElementById("bearerInput").value = INIT.bearerToken || "";
    }

    function renderSidebar() {
      const q = document.getElementById("epSearch").value.trim().toLowerCase();
      const filtered = INIT.schemas.filter((s) =>
        !q || (s.method + " " + s.path + " " + s.controllerName + " " + s.handlerName + " " + (s.summary || "")).toLowerCase().includes(q)
      );
      document.getElementById("epTotal").textContent = String(filtered.length);
      const groups = new Map();
      for (const s of filtered) {
        const list = groups.get(s.controllerName) || [];
        list.push(s);
        groups.set(s.controllerName, list);
      }
      let html = "";
      for (const [ctrl, list] of groups.entries()) {
        html += '<div class="ctrl-group"><div class="ctrl-name">' + esc(ctrl) + '</div>';
        for (const r of list) {
          const active = currentSchema && currentSchema.key === r.key ? " active" : "";
          html += '<div class="ep-item' + active + '" onclick="selectRoute(' + JSON.stringify(r.key) + ')">' +
            '<span class="m-pill m-' + esc(r.method) + '">' + esc(r.method) + '</span>' +
            '<span class="ep-path" title="' + esc(r.path) + '">' + esc(r.path) + '</span>' +
            (r.isGuarded ? '<span title="Auth Guard">🔒</span>' : '') +
            '</div>';
        }
        html += '</div>';
      }
      document.getElementById("epList").innerHTML = html || '<div class="empty" style="padding:12px;">No matching routes.</div>';
    }

    function selectRoute(key) {
      const found = INIT.schemas.find((s) => s.key === key);
      if (!found) return;
      currentSchema = found;

      // Update header banner
      const mBadge = document.getElementById("epMethodBadge");
      mBadge.textContent = found.method;
      mBadge.className = "m-pill m-" + found.method;
      document.getElementById("epTitle").textContent = found.summary ? (found.summary + "  (" + found.path + ")") : found.path;
      document.getElementById("epHandler").textContent = found.controllerName + "." + found.handlerName + "()";
      document.getElementById("epTags").innerHTML = (found.tags || []).map((t) => '<span class="tag-pill">' + esc(t) + '</span>').join(" ");
      document.getElementById("epLock").style.display = found.isGuarded ? "inline-block" : "none";
      document.getElementById("resExpected").textContent = found.responseTypeText ? ("Returns: " + found.responseTypeText) : "";
      document.getElementById("methodSelect").value = found.method;

      // Populate Path Params
      pathValues = {};
      for (const p of found.pathParams) {
        pathValues[p.name] = p.defaultValue || "1";
      }

      // Populate Query Params
      queryRows = found.queryParams.map((q) => ({
        enabled: q.required || q.defaultValue !== "",
        key: q.name,
        type: q.type,
        required: q.required,
        value: q.defaultValue || "",
        description: q.description || "",
        enumValues: q.enumValues,
      }));

      // Populate Headers
      headerRows = [
        ...(found.method === "POST" || found.method === "PUT" || found.method === "PATCH"
          ? [{ enabled: true, key: "Content-Type", value: "application/json", required: false }]
          : []),
        ...found.headerParams.map((h) => ({
          enabled: h.required,
          key: h.name,
          value: h.defaultValue || "",
          required: h.required,
        })),
      ];

      // Populate Body
      const dtoLbl = document.getElementById("bodyDtoLabel");
      if (found.bodyTypeName) {
        dtoLbl.textContent = found.bodyTypeName;
        dtoLbl.style.display = "inline-block";
      } else {
        dtoLbl.style.display = "none";
      }
      try {
        bodyObj = found.bodySampleJson ? JSON.parse(found.bodySampleJson) : {};
      } catch {
        bodyObj = {};
      }
      document.getElementById("rawBody").value = found.bodySampleJson || "";

      renderParamsTab();
      renderHeadersTab();
      renderBodyTab();
      rebuildUrl();
      renderSidebar();

      // Auto-focus Body tab on POST/PUT/PATCH if body fields exist, otherwise Params
      const targetTab = (found.bodyFields.length > 0 && (found.method === "POST" || found.method === "PUT" || found.method === "PATCH")) ? "body" : "params";
      const btn = document.querySelector('[data-rtab="' + targetTab + '"]');
      if (btn) switchReqTab(targetTab, btn);
    }

    function rebuildUrl() {
      const base = currentBaseUrl.replace(/\\/+$/, "");
      let path = currentSchema ? currentSchema.path : "/live";
      for (const [k, v] of Object.entries(pathValues)) {
        path = path.replace(":" + k, encodeURIComponent(v || ""));
      }
      const qs = queryRows
        .filter((r) => r.enabled && r.key.trim())
        .map((r) => encodeURIComponent(r.key.trim()) + "=" + encodeURIComponent(r.value))
        .join("&");
      document.getElementById("urlInput").value = base + (path.startsWith("/") ? path : "/" + path) + (qs ? "?" + qs : "");
    }

    function onEnvChange() {
      currentBaseUrl = document.getElementById("envSelect").value;
      rebuildUrl();
    }

    function onMethodChange() {
      const m = document.getElementById("methodSelect").value;
      const b = document.getElementById("epMethodBadge");
      b.textContent = m;
      b.className = "m-pill m-" + m;
    }

    function renderParamsTab() {
      const pList = currentSchema ? currentSchema.pathParams : [];
      document.getElementById("pathParamsSection").style.display = pList.length ? "block" : "none";
      document.getElementById("pathParamsBody").innerHTML = pList.map((p) =>
        '<tr>' +
        '<td><code>:' + esc(p.name) + '</code><span class="req-star">*</span></td>' +
        '<td><span class="type-chip">' + esc(p.type) + '</span></td>' +
        '<td><input type="text" value="' + esc(pathValues[p.name] ?? "") + '" oninput="setPathParam(' + JSON.stringify(p.name) + ', this.value)" /></td>' +
        '</tr>'
      ).join("");

      const qHtml = queryRows.map((r, i) => {
        const valInput = r.enumValues && r.enumValues.length
          ? '<select onchange="setQueryVal(' + i + ', this.value)">' + r.enumValues.map((ev) => '<option value="' + esc(ev) + '"' + (ev === r.value ? ' selected' : '') + '>' + esc(ev) + '</option>').join("") + '</select>'
          : '<input type="text" value="' + esc(r.value) + '" placeholder="' + esc(r.description || "value") + '" oninput="setQueryVal(' + i + ', this.value)" />';
        return '<tr>' +
          '<td><input type="checkbox"' + (r.enabled ? ' checked' : '') + ' onchange="toggleQuery(' + i + ', this.checked)" /></td>' +
          '<td><input type="text" value="' + esc(r.key) + '" oninput="setQueryKey(' + i + ', this.value)" />' + (r.required ? '<span class="req-star">*</span>' : '') + '</td>' +
          '<td><span class="type-chip">' + esc(r.type || "string") + '</span></td>' +
          '<td>' + valInput + '</td>' +
          '<td><button class="ghost" onclick="removeQueryRow(' + i + ')">✕</button></td>' +
          '</tr>';
      }).join("");
      document.getElementById("queryParamsBody").innerHTML = qHtml || '<tr><td colspan="5" class="empty">No query parameters defined. Click "+ Add Query Param" to add one.</td></tr>';
      document.getElementById("cntParams").textContent = String(pList.length + queryRows.filter((r) => r.enabled && r.key).length);
    }

    function setPathParam(name, val) { pathValues[name] = val; rebuildUrl(); }
    function toggleQuery(i, en) { queryRows[i].enabled = en; rebuildUrl(); updateParamCount(); }
    function setQueryKey(i, k) { queryRows[i].key = k; rebuildUrl(); }
    function setQueryVal(i, v) { queryRows[i].value = v; if (v && !queryRows[i].enabled) { queryRows[i].enabled = true; renderParamsTab(); } rebuildUrl(); }
    function addQueryRow() { queryRows.push({ enabled: true, key: "", type: "string", required: false, value: "" }); renderParamsTab(); }
    function removeQueryRow(i) { queryRows.splice(i, 1); renderParamsTab(); rebuildUrl(); }
    function updateParamCount() {
      const pLen = currentSchema ? currentSchema.pathParams.length : 0;
      document.getElementById("cntParams").textContent = String(pLen + queryRows.filter((r) => r.enabled && r.key).length);
    }

    function renderHeadersTab() {
      const html = headerRows.map((h, i) =>
        '<tr>' +
        '<td><input type="checkbox"' + (h.enabled ? ' checked' : '') + ' onchange="headerRows[' + i + '].enabled=this.checked;updateHeaderCount()" /></td>' +
        '<td><input type="text" value="' + esc(h.key) + '" oninput="headerRows[' + i + '].key=this.value" /></td>' +
        '<td><input type="text" value="' + esc(h.value) + '" oninput="headerRows[' + i + '].value=this.value" /></td>' +
        '<td><button class="ghost" onclick="headerRows.splice(' + i + ',1);renderHeadersTab()">✕</button></td>' +
        '</tr>'
      ).join("");
      document.getElementById("headersBody").innerHTML = html || '<tr><td colspan="4" class="empty">No custom headers.</td></tr>';
      updateHeaderCount();
    }
    function addHeaderRow() { headerRows.push({ enabled: true, key: "", value: "" }); renderHeadersTab(); }
    function updateHeaderCount() { document.getElementById("cntHeaders").textContent = String(headerRows.filter((h) => h.enabled && h.key).length); }

    function renderAuthFields() {
      const t = document.getElementById("authType").value;
      document.getElementById("authLabel1").textContent = t === "apikey" ? "API Key Value" : "Bearer Token";
      document.getElementById("authLabel1").style.display = t === "none" ? "none" : "block";
      document.getElementById("bearerInput").style.display = t === "none" ? "none" : "block";
      document.getElementById("authLabel2").style.display = t === "apikey" ? "block" : "none";
      document.getElementById("apiKeyHeader").style.display = t === "apikey" ? "block" : "none";
    }

    function setBodyMode(mode) {
      bodyMode = mode;
      ["form", "json", "schema"].forEach((m) => {
        document.getElementById("bmode-" + m).classList.toggle("active", m === mode);
        document.getElementById("body-" + m + "-view").style.display = m === mode ? "block" : "none";
      });
    }

    function renderBodyTab() {
      const fields = currentSchema ? currentSchema.bodyFields : [];
      document.getElementById("cntBody").textContent = String(fields.length);

      if (!fields.length) {
        document.getElementById("body-form-view").innerHTML = '<div class="empty">No DTO fields detected for this route. Switch to Raw JSON to enter a custom payload.</div>';
        document.getElementById("body-schema-view").innerHTML = '<div class="empty">No DTO schema available.</div>';
        setBodyMode("json");
        return;
      }

      const formRows = fields.map((f) => {
        const val = bodyObj[f.name];
        let ctrl = "";
        if (f.type === "boolean") {
          ctrl = '<input type="checkbox"' + (val ? " checked" : "") + ' onchange="setBodyField(' + JSON.stringify(f.name) + ', this.checked)" />';
        } else if (f.type === "enum" && f.enumValues && f.enumValues.length) {
          ctrl = '<select onchange="setBodyField(' + JSON.stringify(f.name) + ', this.value)">' +
            f.enumValues.map((ev) => '<option value="' + esc(ev) + '"' + (ev === val ? " selected" : "") + '>' + esc(ev) + '</option>').join("") + '</select>';
        } else if (f.type === "number") {
          ctrl = '<input type="number" value="' + esc(val ?? "") + '" oninput="setBodyField(' + JSON.stringify(f.name) + ', this.value === \\'\\' ? undefined : Number(this.value))" />';
        } else if (f.type === "array" || f.type === "object") {
          ctrl = '<input type="text" value="' + esc(typeof val === "string" ? val : JSON.stringify(val ?? (f.type === "array" ? [] : {}))) + '" oninput="setBodyJsonField(' + JSON.stringify(f.name) + ', this.value)" />';
        } else {
          ctrl = '<input type="text" value="' + esc(val ?? "") + '" oninput="setBodyField(' + JSON.stringify(f.name) + ', this.value)" />';
        }
        const chips = (f.constraints || []).map((c) => '<span class="constraint-chip">' + esc(c) + '</span>').join("");
        return '<tr>' +
          '<td><code>' + esc(f.name) + '</code>' + (f.required ? '<span class="req-star">*</span>' : '') + '</td>' +
          '<td><span class="type-chip">' + esc(f.rawType) + '</span></td>' +
          '<td>' + ctrl + '</td>' +
          '<td class="stat">' + chips + esc(f.description || "") + '</td>' +
          '</tr>';
      }).join("");

      document.getElementById("body-form-view").innerHTML =
        '<table class="kv-table"><thead><tr><th style="width:145px">Field</th><th style="width:95px">Type</th><th>Value</th><th>Constraints / Description</th></tr></thead><tbody>' +
        formRows + '</tbody></table>';

      document.getElementById("body-schema-view").innerHTML =
        '<table class="kv-table"><thead><tr><th>Property</th><th>Type</th><th>Required</th><th>Constraints</th><th>Description</th></tr></thead><tbody>' +
        fields.map((f) =>
          '<tr><td><code>' + esc(f.name) + '</code></td><td><span class="type-chip">' + esc(f.rawType) + '</span></td>' +
          '<td>' + (f.required ? '<strong style="color:#ef4444">required</strong>' : '<span class="stat">optional</span>') + '</td>' +
          '<td>' + (f.constraints || []).map((c) => '<span class="constraint-chip">' + esc(c) + '</span>').join("") + '</td>' +
          '<td class="stat">' + esc(f.description || "—") + '</td></tr>'
        ).join("") + '</tbody></table>';

      setBodyMode("form");
    }

    function setBodyField(name, val) {
      if (val === undefined) delete bodyObj[name];
      else bodyObj[name] = val;
      document.getElementById("rawBody").value = JSON.stringify(bodyObj, null, 2);
    }
    function setBodyJsonField(name, text) {
      try { bodyObj[name] = JSON.parse(text); } catch { bodyObj[name] = text; }
      document.getElementById("rawBody").value = JSON.stringify(bodyObj, null, 2);
    }
    function onRawJsonEdit() {
      try { bodyObj = JSON.parse(document.getElementById("rawBody").value || "{}"); } catch {}
    }
    function resetBodySample() {
      if (!currentSchema) return;
      document.getElementById("rawBody").value = currentSchema.bodySampleJson || "{}";
      try { bodyObj = JSON.parse(currentSchema.bodySampleJson || "{}"); } catch { bodyObj = {}; }
      renderBodyTab();
    }
    function formatRawJson() {
      const el = document.getElementById("rawBody");
      try { el.value = JSON.stringify(JSON.parse(el.value), null, 2); } catch {}
    }

    function switchReqTab(name, btn) {
      ["params", "headers", "auth", "body", "history"].forEach((t) => {
        document.getElementById("rtab-" + t).style.display = t === name ? "block" : "none";
      });
      btn.parentElement.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (name === "history") renderHistory();
    }

    function switchResTab(name, btn) {
      ["pretty", "headers", "curl"].forEach((t) => {
        document.getElementById("restab-" + t).style.display = t === name ? "block" : "none";
      });
      btn.parentElement.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    }

    function renderHistory() {
      document.getElementById("cntHist").textContent = String(historyList.length);
      const el = document.getElementById("rtab-history");
      if (!historyList.length) {
        el.innerHTML = '<div class="empty">No requests sent yet.</div>';
        return;
      }
      el.innerHTML = '<table class="kv-table"><tbody>' + historyList.map((h, i) =>
        '<tr style="cursor:pointer" onclick="replayHistory(' + i + ')">' +
        '<td style="width:58px"><span class="m-pill m-' + esc(h.method) + '">' + esc(h.method) + '</span></td>' +
        '<td><code>' + esc(h.url) + '</code></td>' +
        '<td style="width:90px" class="stat">' + h.status + ' · ' + h.elapsedMs.toFixed(0) + 'ms</td>' +
        '</tr>'
      ).join("") + '</tbody></table>';
    }

    function replayHistory(i) {
      const h = historyList[i];
      if (!h) return;
      document.getElementById("methodSelect").value = h.method;
      onMethodChange();
      document.getElementById("urlInput").value = h.url;
      document.getElementById("rawBody").value = h.body || "";
    }

    function sendRequest() {
      const btn = document.getElementById("sendBtn");
      btn.disabled = true;
      btn.textContent = "Sending...";
      const hdrs = {};
      for (const h of headerRows) {
        if (h.enabled && h.key.trim()) hdrs[h.key.trim()] = h.value;
      }
      const authType = document.getElementById("authType").value;
      const authVal = document.getElementById("bearerInput").value.trim();
      if (authType === "bearer" && authVal) {
        hdrs["Authorization"] = "Bearer " + authVal;
      } else if (authType === "apikey" && authVal) {
        const hdrName = document.getElementById("apiKeyHeader").value.trim() || "x-api-key";
        hdrs[hdrName] = authVal;
      }

      vscode.postMessage({
        type: "send",
        method: document.getElementById("methodSelect").value,
        url: document.getElementById("urlInput").value.trim(),
        body: document.getElementById("rawBody").value,
        bearerToken: authType === "bearer" ? authVal : "",
        headers: hdrs,
        selectedKey: currentSchema ? currentSchema.key : undefined,
      });
    }

    function copyResBody() { vscode.postMessage({ type: "copy", text: lastRawBody, label: "response body" }); }
    function copyCurl() { vscode.postMessage({ type: "copy", text: lastCurl, label: "cURL command" }); }
    function saveAsTest() { vscode.postMessage({ type: "saveAsTest" }); }
    function useDetectedToken() {
      document.getElementById("authType").value = "bearer";
      renderAuthFields();
      document.getElementById("bearerInput").value = detectedToken;
      document.getElementById("tokenBanner").style.display = "none";
      vscode.postMessage({ type: "saveToken", token: detectedToken });
    }

    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        sendRequest();
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "response") return;
      const btn = document.getElementById("sendBtn");
      btn.disabled = false;
      btn.textContent = "▶ Send";

      const pill = document.getElementById("resStatus");
      pill.textContent = msg.error ? "NETWORK ERROR" : (msg.status + " " + msg.statusText);
      pill.className = "status-pill " + (msg.error || msg.status >= 400 ? "err" : msg.status >= 300 ? "warn" : "ok");
      document.getElementById("resTime").textContent = msg.elapsedMs.toFixed(1) + " ms";
      document.getElementById("resSize").textContent = msg.sizeBytes + " B";

      lastRawBody = msg.body || "";
      lastCurl = msg.curl || "";
      const saveBtn = document.getElementById("saveAsTestBtn");
      if (saveBtn) {
        saveBtn.style.display = msg.error ? "none" : "inline-flex";
      }
      document.getElementById("resPretty").innerHTML = msg.isBinaryOrStream
        ? esc(lastRawBody)
        : highlightJson(lastRawBody);
      document.getElementById("resCurl").textContent = lastCurl;
      const hdrs = msg.headers || [];
      document.getElementById("cntResHeaders").textContent = String(hdrs.length);
      document.getElementById("resHeadersBody").innerHTML = hdrs.map(([k, v]) =>
        '<tr><td style="width:220px"><code>' + esc(k) + '</code></td><td><code>' + esc(v) + '</code></td></tr>'
      ).join("");

      if (msg.detectedToken) {
        detectedToken = msg.detectedToken;
        document.getElementById("tokenBanner").style.display = "flex";
      } else {
        document.getElementById("tokenBanner").style.display = "none";
      }

      if (msg.history) {
        historyList = msg.history;
        document.getElementById("cntHist").textContent = String(historyList.length);
      }
    });

    initEnvs();
    renderSidebar();
    document.getElementById("cntHist").textContent = String(historyList.length);
    if (INIT.selectedKey) {
      selectRoute(INIT.selectedKey);
    } else if (INIT.schemas.length > 0) {
      selectRoute(INIT.schemas[0].key);
    } else {
      document.getElementById("urlInput").value = currentBaseUrl + "/live";
      renderParamsTab();
      renderHeadersTab();
    }
  </script>
</body>
</html>`;
}

async function readStreamBounded(
  res: Response,
  maxBytes = 65536,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          truncated = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore stream cancel errors
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: merged, truncated };
}

export class BunestHttpStudioPanel {
  private static current: vscode.WebviewPanel | undefined;
  private static listener: vscode.Disposable | undefined;
  private static lastExchange: HttpStudioExchange | undefined;

  static open(
    index: BunestWorkspaceIndex,
    route?: ExtractedRouteEntry,
  ): void {
    const config = vscode.workspace.getConfiguration("bunest");
    const defaultBase = (
      config.get<string>("http.baseUrl") ?? "http://localhost:3000"
    ).replace(/\/+$/, "");

    const configuredEnvs =
      config.get<Array<{ name: string; baseUrl: string }>>(
        "http.environments",
      ) ?? [];
    const environments = [
      { name: "Local", baseUrl: defaultBase },
      ...configuredEnvs.filter((e) => e?.name && e?.baseUrl),
    ];

    const allRoutes = index
      .getAllSnapshots()
      .flatMap((s) => s.scan.routes);
    const routeByKey = new Map<string, ExtractedRouteEntry>();
    for (const r of allRoutes) {
      routeByKey.set(r.key, r);
    }
    const schemas = allRoutes.map((r) => extractRouteSchema(index, r));

    if (this.current) {
      this.current.reveal(vscode.ViewColumn.Beside);
    } else {
      this.current = vscode.window.createWebviewPanel(
        "bunestHttpStudio",
        "Bunest HTTP Studio",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.current.onDidDispose(() => {
        this.listener?.dispose();
        this.listener = undefined;
        this.lastExchange = undefined;
        this.current = undefined;
      });
    }

    this.current.title = route
      ? `HTTP Studio: ${route.method} ${route.path}`
      : "Bunest HTTP Studio";
    this.current.webview.html = buildStudioHtml({
      baseUrl: defaultBase,
      environments,
      schemas,
      selectedKey: route?.key,
      bearerToken: savedBearerToken,
      history: requestHistory,
    });

    this.listener?.dispose();
    this.listener = this.current.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "copy" && typeof msg.text === "string") {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage(`Copied ${msg.label ?? "text"}.`);
        return;
      }
      if (msg.type === "saveToken" && typeof msg.token === "string") {
        savedBearerToken = msg.token;
        vscode.window.showInformationMessage(
          "Saved Bearer token for HTTP Studio session.",
        );
        return;
      }
      if (msg.type === "saveAsTest") {
        await this.handleSaveAsTest(index);
        return;
      }
      if (msg.type === "send") {
        const reqMethod = String(msg.method || "GET").toUpperCase();
        const reqUrl = String(msg.url || "").trim();
        const reqBody =
          reqMethod === "POST" || reqMethod === "PUT" || reqMethod === "PATCH"
            ? String(msg.body || "")
            : undefined;
        const headers: Record<string, string> = {
          ...(typeof msg.headers === "object" && msg.headers ? msg.headers : {}),
        };
        if (msg.bearerToken) {
          savedBearerToken = String(msg.bearerToken);
        }
        if (reqBody && !headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }

        const curlParts = [`curl -X ${reqMethod}`];
        for (const [k, v] of Object.entries(headers)) {
          curlParts.push(`-H ${JSON.stringify(`${k}: ${v}`)}`);
        }
        if (reqBody) {
          curlParts.push(`-d ${JSON.stringify(reqBody)}`);
        }
        curlParts.push(JSON.stringify(reqUrl));
        const curl = curlParts.join(" ");

        const activeRoute =
          typeof msg.selectedKey === "string"
            ? routeByKey.get(msg.selectedKey)
            : route;

        const start = performance.now();
        try {
          const res = await fetch(reqUrl, {
            method: reqMethod,
            headers,
            body: reqBody,
          });
          const elapsedMs = performance.now() - start;
          const resHeadersEntries = [...res.headers.entries()];
          const resHeadersObj: Record<string, string> = {};
          for (const [k, v] of resHeadersEntries) {
            resHeadersObj[k] = v;
          }
          const contentType = res.headers.get("content-type") ?? undefined;
          const isBinary = isBinaryOrStreamContentType(contentType);

          let displayBody = "";
          let sizeBytes = 0;
          let detectedToken = "";
          let parsedJsonBody: unknown = undefined;
          let rawBodyForScenario: string | Uint8Array | undefined = undefined;

          if (isBinary) {
            const isEventStream = /^text\/event-stream\b/i.test(
              contentType ?? "",
            );
            const { bytes, truncated } = isEventStream
              ? await readStreamBounded(res)
              : { bytes: new Uint8Array(await res.arrayBuffer()), truncated: false };
            sizeBytes = bytes.byteLength;
            rawBodyForScenario = bytes;
            const mime = contentType?.split(";")[0]?.trim() ?? "application/octet-stream";
            displayBody = `[Binary/Stream response detected: ${mime} · ${sizeBytes} byte(s)${truncated ? " (truncated preview)" : ""}]\nRaw bytes are intentionally not rendered as text.\nClick "🧪 Save as Test" to assert status & Content-Type (with optional binary fixture).`;
          } else {
            const rawText = await res.text();
            sizeBytes = new TextEncoder().encode(rawText).length;
            rawBodyForScenario = rawText;
            displayBody = rawText;
            try {
              const parsed = JSON.parse(rawText) as Record<string, unknown>;
              parsedJsonBody = parsed;
              displayBody = JSON.stringify(parsed, null, 2);
              const candidate =
                parsed?.accessToken ?? parsed?.access_token ?? parsed?.token;
              if (typeof candidate === "string" && candidate.length >= 10) {
                detectedToken = candidate;
              }
            } catch {
              // non-JSON text response
            }
          }

          this.lastExchange = {
            method: reqMethod,
            url: reqUrl,
            requestHeaders: headers,
            requestBody: reqBody,
            status: res.status,
            responseContentType: contentType,
            responseHeaders: resHeadersObj,
            responseJsonBody: parsedJsonBody,
            responseRawBody: rawBodyForScenario,
            isBinaryOrStream: isBinary,
            sizeBytes,
            route: activeRoute,
          };

          requestHistory.unshift({
            id: `${Date.now()}`,
            method: reqMethod,
            url: reqUrl,
            body: reqBody ?? "",
            status: res.status,
            elapsedMs,
            timestamp: new Date().toISOString(),
          });
          if (requestHistory.length > 20) requestHistory.pop();

          this.current?.webview.postMessage({
            type: "response",
            status: res.status,
            statusText: res.statusText,
            elapsedMs,
            sizeBytes,
            contentType,
            isBinaryOrStream: isBinary,
            headers: resHeadersEntries,
            body: displayBody,
            curl,
            detectedToken,
            history: requestHistory,
          });
        } catch (err) {
          this.current?.webview.postMessage({
            type: "response",
            error: true,
            status: 0,
            statusText: "Network Error",
            elapsedMs: performance.now() - start,
            sizeBytes: 0,
            headers: [],
            body: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
            curl,
          });
        }
      }
    });
  }

  private static async handleSaveAsTest(
    index: BunestWorkspaceIndex,
  ): Promise<void> {
    const exchange = this.lastExchange;
    if (!exchange) {
      vscode.window.showInformationMessage(
        "Send an HTTP request first before saving it as a regression test.",
      );
      return;
    }

    const ctx =
      (exchange.route?.location?.filePath
        ? index.getContextForFile(exchange.route.location.filePath)
        : undefined) ?? index.getAllContexts()[0];
    const cwd =
      ctx?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      vscode.window.showWarningMessage(
        "Open a workspace folder before saving a generated regression test.",
      );
      return;
    }

    let assertFields: string[] | undefined;
    let saveBinaryFixture = false;

    if (exchange.isBinaryOrStream) {
      const binaryChoice = await vscode.window.showQuickPick(
        [
          {
            label: "Assert status & Content-Type only (Recommended)",
            description: "Do not write binary bytes into test fixtures",
            saveFixture: false,
          },
          {
            label: "Also save binary fixture file (opt-in)",
            description: `${exchange.responseContentType ?? "application/octet-stream"} (${exchange.sizeBytes} bytes)`,
            saveFixture: true,
          },
        ],
        {
          title: "Save Binary/Stream Response as Test",
          placeHolder: "Choose how to handle the binary/stream response...",
        },
      );
      if (!binaryChoice) return;
      saveBinaryFixture = binaryChoice.saveFixture;
    } else if (
      exchange.responseJsonBody &&
      typeof exchange.responseJsonBody === "object" &&
      !Array.isArray(exchange.responseJsonBody)
    ) {
      const candidates = extractCandidateResponseFields(
        exchange.responseJsonBody,
      );
      if (candidates.length > 0) {
        const picked = await vscode.window.showQuickPick(
          candidates.map((c) => ({
            label: c.path,
            description: c.isVolatile
              ? `${c.valuePreview} (volatile — shape assertion)`
              : c.valuePreview,
            picked: !c.isVolatile,
            fieldPath: c.path,
          })),
          {
            title: "Save as Test — Pick Response Fields to Assert",
            placeHolder:
              "Select stable fields to assert (volatile IDs/timestamps are unchecked by default)",
            canPickMany: true,
          },
        );
        if (!picked) return;
        assertFields = picked.map((p) => p.fieldPath);
      }
    }

    // First dry-plan to discover target relative paths, then read any existing files for accurate diffs
    const initial = planHttpExchangeAsTest(exchange, {
      index,
      cwd,
      assertFields,
      saveBinaryFixture,
    });
    const existingContents = readExistingFileMap(
      cwd,
      initial.plan.files.map((f) => f.relativePath),
    );
    const { plan } = planHttpExchangeAsTest(exchange, {
      index,
      cwd,
      assertFields,
      saveBinaryFixture,
      existingContents,
    });

    const primaryFile = plan.files[0];
    if (!primaryFile) return;

    // Preview sanitized generated test via vscode.diff
    const targetAbs = resolve(cwd, primaryFile.relativePath);
    const targetExists = existsSyncPath(targetAbs);
    const leftUri = targetExists
      ? vscode.Uri.file(targetAbs)
      : vscode.Uri.parse(
          `${BUNEST_PREVIEW_SCHEME}:/empty/${primaryFile.relativePath}`,
        );
    if (!targetExists) {
      bunestPreviewProvider.setContent(leftUri, "");
    }
    const rightUri = vscode.Uri.parse(
      `${BUNEST_PREVIEW_SCHEME}:/generated/${primaryFile.relativePath}`,
    );
    bunestPreviewProvider.setContent(rightUri, primaryFile.content);

    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `Bunest Save as Test Preview: ${primaryFile.relativePath}`,
    );

    const summaryNotes: string[] = [];
    if (plan.sanitized.length > 0) {
      summaryNotes.push(`${plan.sanitized.length} secret(s) sanitized`);
    }
    if (plan.warnings.length > 0) {
      summaryNotes.push(`${plan.warnings.length} warning(s)`);
    }
    const noteText =
      summaryNotes.length > 0 ? ` (${summaryNotes.join(", ")})` : "";

    const action = await vscode.window.showInformationMessage(
      `Apply generated test to ${primaryFile.relativePath}${noteText}?`,
      "Apply Test",
      "Cancel",
    );
    if (action !== "Apply Test") return;

    const wsEdit = buildPlannedFilesWorkspaceEdit(cwd, plan);
    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (applied) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(targetAbs),
      );
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(
        `Saved regression test: ${primaryFile.relativePath} (use Undo to revert).`,
      );
    }
  }
}
