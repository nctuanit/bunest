import * as vscode from "vscode";
import type { AnalyzedQueryMethod, AnalyzedRepository } from "@bunest/cli";
import {
  coerceSqlParamValue,
  detectSqlDialect,
  discoverWorkspaceDatabaseCandidates,
  executeRawSql,
  extractSqlPlaceholders,
  isWriteSqlStatement,
  maskDatabaseUrl,
  normalizeDatabaseUrl,
  type ExecuteRawSqlResult,
  type SqlConnectionConfig,
} from "../sql/raw-query-runner";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export interface RawQueryExecutionRequest {
  readonly sql?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly repo?: AnalyzedRepository;
  readonly method?: AnalyzedQueryMethod;
}

const lastParamValues = new Map<string, string>();
const lastConnectionByCwd = new Map<string, SqlConnectionConfig>();
let activeResultPanel: vscode.WebviewPanel | undefined;
let activeMessageListener: vscode.Disposable | undefined;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const encodeCell = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str =
      typeof val === "object" ? JSON.stringify(val) : String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const header = columns.map(encodeCell).join(",");
  const body = rows.map((row) =>
    columns.map((col) => encodeCell(row[col])).join(","),
  );
  return [header, ...body].join("\n");
}

function getConfiguredConnections(cwd: string): SqlConnectionConfig[] {
  const raw = vscode.workspace
    .getConfiguration("bunest")
    .get<SqlConnectionConfig[]>("sql.connections");
  if (!Array.isArray(raw)) return [];
  const out: SqlConnectionConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    if (!entry.url && !(entry.accountId && entry.databaseId)) continue;
    const normalizedUrl = entry.url
      ? normalizeDatabaseUrl(entry.url, cwd)
      : `d1://${entry.accountId}/${entry.databaseId}`;
    const dialect = detectSqlDialect(normalizedUrl, entry.dialect);
    out.push({
      ...entry,
      url: normalizedUrl,
      dialect,
    });
  }
  return out;
}

function formatConnectionDisplay(
  conn: SqlConnectionConfig,
  cwd: string,
): string {
  const masked = maskDatabaseUrl(conn.url ?? "", cwd, conn.dialect);
  return conn.name ? `${conn.name} (${masked})` : masked;
}

/**
 * Prompts the user to choose or enter a database connection (SQLite, PostgreSQL,
 * CockroachDB, MySQL, MariaDB, LibSQL/Turso, or Cloudflare D1).
 */
export async function pickDatabaseConnection(
  cwd: string,
  current?: SqlConnectionConfig,
): Promise<SqlConnectionConfig | undefined> {
  const configuredProfiles = getConfiguredConnections(cwd);
  const candidates = discoverWorkspaceDatabaseCandidates(cwd);
  const items: Array<
    vscode.QuickPickItem & {
      readonly connection?: SqlConnectionConfig;
      readonly custom?: boolean;
    }
  > = [];
  const seenKeys = new Set<string>();

  const addItem = (
    conn: SqlConnectionConfig,
    label: string,
    description: string,
    detail?: string,
  ): void => {
    const key = `${conn.dialect ?? ""}:${conn.url ?? ""}:${conn.name ?? ""}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    items.push({ label, description, detail, connection: conn });
  };

  if (current?.url) {
    const dialect = detectSqlDialect(current.url, current.dialect);
    addItem(
      current,
      `$(database) Current: ${formatConnectionDisplay(current, cwd)}`,
      dialect,
      "Keep current connection",
    );
  }

  for (const profile of configuredProfiles) {
    const dialect = detectSqlDialect(profile.url ?? "", profile.dialect);
    addItem(
      profile,
      `$(plug) ${profile.name ?? `${dialect}: ${maskDatabaseUrl(profile.url ?? "", cwd, dialect)}`}`,
      `${dialect} · bunest.sql.connections`,
      profile.name ? maskDatabaseUrl(profile.url ?? "", cwd, dialect) : undefined,
    );
  }

  for (const c of candidates) {
    addItem(c.connection, `$(database) ${c.label}`, c.source);
  }

  items.push({
    label: "$(edit) Enter connection URL or SQLite path...",
    description:
      "sqlite://, postgres://, cockroachdb://, mysql://, mariadb://, libsql://, d1://",
    custom: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Bunest SQL Runner — Select Database Connection",
    placeHolder:
      "SQLite, PostgreSQL, CockroachDB, MySQL, MariaDB, LibSQL/Turso, or Cloudflare D1",
  });
  if (!picked) return undefined;

  let chosen = picked.connection;
  if (picked.custom) {
    const entered = await vscode.window.showInputBox({
      title: "Bunest SQL Runner — Database Connection",
      prompt:
        "Enter URL: postgres://, cockroachdb://, mysql://, mariadb://, libsql://, d1://accountId/dbId, sqlite://./dev.db, or :memory:",
      value: current?.url ?? "",
      placeHolder:
        "mysql://root:pass@localhost:3306/app  |  sqlite://./dev.db  |  libsql://db.turso.io",
    });
    if (!entered?.trim()) return undefined;
    const normalizedUrl = normalizeDatabaseUrl(entered, cwd);
    const dialect = detectSqlDialect(normalizedUrl);
    let authToken: string | undefined;
    if (dialect === "libsql" || dialect === "d1") {
      authToken = await vscode.window.showInputBox({
        title:
          dialect === "libsql"
            ? "LibSQL / Turso Auth Token (optional for local sqld)"
            : "Cloudflare D1 API Token",
        prompt:
          dialect === "libsql"
            ? "Enter Turso/LibSQL Bearer authToken (leave empty if none)"
            : "Enter Cloudflare API Token with D1 Query permission",
        password: true,
      });
      if (authToken === undefined) return undefined;
    }
    chosen = {
      url: normalizedUrl,
      dialect,
      ...(authToken
        ? dialect === "d1"
          ? { apiToken: authToken }
          : { authToken }
        : {}),
    };
  }

  if (!chosen?.url) return undefined;
  lastConnectionByCwd.set(cwd, chosen);

  const cfg = vscode.workspace.getConfiguration("bunest");
  const configured = cfg.get<string>("sql.databaseUrl")?.trim();
  const canSaveUrlOnly = !chosen.authToken && !chosen.apiToken;
  if (canSaveUrlOnly && (!configured || configured !== chosen.url)) {
    const saveChoice = await vscode.window.showInformationMessage(
      `Use "${formatConnectionDisplay(chosen, cwd)}" as default Bunest SQL Runner database for this workspace?`,
      "Save to Workspace Settings",
      "Session Only",
    );
    if (saveChoice === "Save to Workspace Settings") {
      await cfg.update(
        "sql.databaseUrl",
        chosen.url,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  }

  return chosen;
}

async function resolveConnection(
  cwd: string,
): Promise<SqlConnectionConfig | undefined> {
  const configuredUrl = vscode.workspace
    .getConfiguration("bunest")
    .get<string>("sql.databaseUrl")
    ?.trim();
  if (configuredUrl) {
    const normalizedUrl = normalizeDatabaseUrl(configuredUrl, cwd);
    return {
      url: normalizedUrl,
      dialect: detectSqlDialect(normalizedUrl),
    };
  }

  const cached = lastConnectionByCwd.get(cwd);
  if (cached) {
    return cached;
  }

  const profiles = getConfiguredConnections(cwd);
  if (profiles.length === 1) {
    const only = profiles[0]!;
    lastConnectionByCwd.set(cwd, only);
    return only;
  }

  const candidates = discoverWorkspaceDatabaseCandidates(cwd);
  if (profiles.length === 0 && candidates.length === 1) {
    const only = candidates[0]!.connection;
    lastConnectionByCwd.set(cwd, only);
    return only;
  }

  return pickDatabaseConnection(cwd);
}

interface ParamInputSpec {
  readonly key: string;
  readonly label: string;
  readonly tsType?: string;
  readonly rawValue: string;
}

async function promptForParameters(
  sql: string,
  cacheKey: string,
  method?: AnalyzedQueryMethod,
): Promise<{
  readonly cancelled: boolean;
  readonly specs: readonly ParamInputSpec[];
  readonly params: Record<string, unknown> | readonly unknown[];
}> {
  const placeholders = extractSqlPlaceholders(sql);
  if (placeholders.style === "none") {
    return { cancelled: false, specs: [], params: [] };
  }

  if (placeholders.style === "named") {
    const specs: ParamInputSpec[] = [];
    const params: Record<string, unknown> = {};
    for (const name of placeholders.named) {
      const mParam = method?.params.find(
        (p) => p.sqlParamName === name || p.name === name,
      );
      const key = `${cacheKey}:named:${name}`;
      const entered = await vscode.window.showInputBox({
        title: `SQL Parameter :${name}`,
        prompt: mParam
          ? `Value for :${name} (${mParam.name}: ${mParam.tsType}) — type "null" for SQL NULL`
          : `Value for :${name} — type "null" for SQL NULL`,
        value: lastParamValues.get(key) ?? "",
      });
      if (entered === undefined) {
        return { cancelled: true, specs: [], params: {} };
      }
      lastParamValues.set(key, entered);
      specs.push({
        key: name,
        label: `:${name}${mParam ? ` (${mParam.tsType})` : ""}`,
        tsType: mParam?.tsType,
        rawValue: entered,
      });
      params[name] = coerceSqlParamValue(entered, mParam?.tsType);
    }
    return { cancelled: false, specs, params };
  }

  // Positional (`?` or `$1`)
  const specs: ParamInputSpec[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < placeholders.positionalCount; i++) {
    const mParam = method?.params[i];
    const key = `${cacheKey}:pos:${i + 1}`;
    const label = mParam
      ? `$${i + 1} (${mParam.name}: ${mParam.tsType})`
      : `$${i + 1}`;
    const entered = await vscode.window.showInputBox({
      title: `SQL Parameter ${label}`,
      prompt: `Value for positional parameter #${i + 1}${mParam ? ` (${mParam.name}: ${mParam.tsType})` : ""} — type "null" for SQL NULL`,
      value: lastParamValues.get(key) ?? "",
    });
    if (entered === undefined) {
      return { cancelled: true, specs: [], params: [] };
    }
    lastParamValues.set(key, entered);
    specs.push({
      key: String(i + 1),
      label,
      tsType: mParam?.tsType,
      rawValue: entered,
    });
    params.push(coerceSqlParamValue(entered, mParam?.tsType));
  }
  return { cancelled: false, specs, params };
}

async function confirmWriteIfNeeded(sql: string): Promise<boolean> {
  if (!isWriteSqlStatement(sql)) return true;
  const confirmWrites =
    vscode.workspace
      .getConfiguration("bunest")
      .get<boolean>("sql.confirmWrites") ?? true;
  if (!confirmWrites) return true;

  const preview = sql.trim().replace(/\s+/g, " ").slice(0, 140);
  const answer = await vscode.window.showWarningMessage(
    `This SQL query modifies data/schema:\n${preview}`,
    { modal: true },
    "Execute Query",
  );
  return answer === "Execute Query";
}

function renderSqlResultHtml(state: {
  readonly title: string;
  readonly sql: string;
  readonly maskedUrl: string;
  readonly specs: readonly ParamInputSpec[];
  readonly result: ExecuteRawSqlResult;
}): string {
  const { result } = state;
  const statusColor = result.ok ? "#22c55e" : "#ef4444";
  const statusLabel = result.ok ? "OK" : "ERROR";

  const paramInputsHtml =
    state.specs.length > 0
      ? `<div class="params-grid">${state.specs
          .map(
            (p) =>
              `<label class="param-item"><span>${escapeHtml(p.label)}</span><input type="text" data-param-key="${escapeHtml(p.key)}" data-param-type="${escapeHtml(p.tsType ?? "")}" value="${escapeHtml(p.rawValue)}" /></label>`,
          )
          .join("")}</div>`
      : "";

  const payloadJson = JSON.stringify({
    columns: result.columns,
    rows: result.rows,
    ok: result.ok,
    error: result.error ?? null,
    compiledSql: result.compiledSql,
    csv: toCsv(result.columns, result.rows),
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 14px 16px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .title-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .title { font-weight: 700; font-size: 14px; }
  .dialect-badge {
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .conn-url {
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    opacity: 0.85;
  }
  .sql-box {
    width: 100%;
    box-sizing: border-box;
    min-height: 76px;
    resize: vertical;
    padding: 9px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .params-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 8px;
    margin-top: 8px;
  }
  .param-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11.5px;
  }
  .param-item input {
    padding: 5px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    margin: 10px 0 12px;
  }
  .toolbar-left, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 11px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .status-pill {
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 700;
    font-size: 11px;
    color: #fff;
    background: ${statusColor};
  }
  .meta { opacity: 0.85; font-size: 12px; }
  .filter-input {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 12px;
    width: 170px;
  }
  .error-box {
    border: 1px solid #ef4444;
    background: rgba(239, 68, 68, 0.12);
    border-radius: 6px;
    padding: 12px;
    font-family: var(--vscode-editor-font-family);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .table-wrap {
    overflow: auto;
    max-height: calc(100vh - 260px);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
    text-align: left;
    padding: 7px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  thead th:hover { text-decoration: underline; }
  tbody td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    vertical-align: top;
    max-width: 380px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  .null-val {
    opacity: 0.55;
    font-style: italic;
  }
  .num-val { color: var(--vscode-debugTokenExpression-number, #4fc1ff); }
  .bool-val { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
  pre.json-view {
    margin: 0;
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-textBlockQuote-background);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    overflow: auto;
    max-height: calc(100vh - 260px);
  }
  .empty-state {
    padding: 20px;
    text-align: center;
    opacity: 0.75;
  }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="header">
    <div class="title-group">
      <span class="title">${escapeHtml(state.title)}</span>
      <span class="dialect-badge">${escapeHtml(result.dialect)}</span>
      <span class="conn-url">${escapeHtml(state.maskedUrl)}</span>
    </div>
    <button class="secondary" onclick="switchDb()">Switch DB</button>
  </div>

  <textarea id="sqlInput" class="sql-box" spellcheck="false" title="Press Cmd/Ctrl+Enter to run">${escapeHtml(state.sql)}</textarea>
  ${paramInputsHtml}

  <div class="toolbar">
    <div class="toolbar-left">
      <button onclick="rerun()">▶ Run (⌘/Ctrl+Enter)</button>
      <button class="secondary" onclick="explainQuery()" title="Run EXPLAIN / Query Plan">Explain Plan</button>
      <span class="status-pill">${statusLabel}</span>
      <span class="meta">
        ${
          result.ok
            ? `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}${result.affectedRows !== undefined ? ` · ${result.affectedRows} affected` : ""}${result.truncated ? " (truncated)" : ""} · ${result.elapsedMs.toFixed(1)} ms`
            : `${result.elapsedMs.toFixed(1)} ms`
        }
      </span>
    </div>
    <div class="toolbar-right">
      ${
        result.ok && result.rows.length > 0
          ? `<input id="filterInput" class="filter-input" type="text" placeholder="Filter rows..." oninput="renderTable()" />
             <button class="secondary" id="toggleViewBtn" onclick="toggleView()">JSON View</button>
             <button class="secondary" onclick="copyJson()">Copy JSON</button>
             <button class="secondary" onclick="copyCsv()">Copy CSV</button>`
          : ""
      }
    </div>
  </div>

  ${
    !result.ok
      ? `<div class="error-box"><strong>SQL Error:</strong>\n${escapeHtml(result.error ?? "Unknown error")}\n\n<strong>Compiled SQL:</strong>\n${escapeHtml(result.compiledSql)}</div>`
      : result.rows.length === 0
        ? `<div class="empty-state">Query succeeded with 0 rows returned${result.affectedRows !== undefined ? ` (${result.affectedRows} affected)` : ""}.</div>`
        : `<div id="tableWrap" class="table-wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
           <pre id="jsonView" class="json-view hidden"></pre>`
  }

  <script>
    const vscode = acquireVsCodeApi();
    const data = ${payloadJson};
    let sortCol = null;
    let sortAsc = true;
    let showingJson = false;

    const sqlInput = document.getElementById("sqlInput");
    sqlInput.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        rerun();
      }
    });

    function collectParams() {
      const inputs = document.querySelectorAll("[data-param-key]");
      const items = [];
      inputs.forEach((el) => {
        items.push({
          key: el.getAttribute("data-param-key"),
          tsType: el.getAttribute("data-param-type") || undefined,
          rawValue: el.value,
        });
      });
      return items;
    }

    function rerun() {
      vscode.postMessage({
        type: "rerun",
        sql: sqlInput.value,
        paramInputs: collectParams(),
      });
    }

    function explainQuery() {
      vscode.postMessage({
        type: "explain",
        sql: sqlInput.value,
        paramInputs: collectParams(),
      });
    }

    function switchDb() {
      vscode.postMessage({
        type: "switchDb",
        sql: sqlInput.value,
        paramInputs: collectParams(),
      });
    }

    function copyJson() {
      vscode.postMessage({
        type: "copy",
        label: "JSON",
        text: JSON.stringify(data.rows, null, 2),
      });
    }

    function copyCsv() {
      vscode.postMessage({
        type: "copy",
        label: "CSV",
        text: data.csv,
      });
    }

    function toggleView() {
      showingJson = !showingJson;
      const tw = document.getElementById("tableWrap");
      const jv = document.getElementById("jsonView");
      const btn = document.getElementById("toggleViewBtn");
      if (!tw || !jv || !btn) return;
      if (showingJson) {
        tw.classList.add("hidden");
        jv.classList.remove("hidden");
        jv.textContent = JSON.stringify(data.rows, null, 2);
        btn.textContent = "Table View";
      } else {
        jv.classList.add("hidden");
        tw.classList.remove("hidden");
        btn.textContent = "JSON View";
      }
    }

    function sortBy(col) {
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = true; }
      renderTable();
    }

    function formatCell(val) {
      if (val === null || val === undefined) return '<span class="null-val">NULL</span>';
      if (typeof val === "number") return '<span class="num-val">' + String(val) + '</span>';
      if (typeof val === "boolean") return '<span class="bool-val">' + String(val) + '</span>';
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function renderTable() {
      const thead = document.getElementById("thead");
      const tbody = document.getElementById("tbody");
      if (!thead || !tbody) return;

      const filterEl = document.getElementById("filterInput");
      const q = filterEl ? filterEl.value.trim().toLowerCase() : "";

      let rows = data.rows.slice();
      if (q) {
        rows = rows.filter((r) =>
          data.columns.some((c) => {
            const v = r[c];
            if (v === null || v === undefined) return "null".includes(q);
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            return s.toLowerCase().includes(q);
          }),
        );
      }

      if (sortCol !== null) {
        rows.sort((a, b) => {
          const av = a[sortCol];
          const bv = b[sortCol];
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          if (typeof av === "number" && typeof bv === "number") {
            return sortAsc ? av - bv : bv - av;
          }
          return sortAsc
            ? String(av).localeCompare(String(bv))
            : String(bv).localeCompare(String(av));
        });
      }

      thead.innerHTML = "<tr>" + data.columns.map((c) => {
        const indicator = sortCol === c ? (sortAsc ? " ▲" : " ▼") : "";
        const safe = c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        return '<th data-col="' + safe + '">' + safe + indicator + '</th>';
      }).join("") + "</tr>";

      thead.querySelectorAll("th").forEach((th) => {
        th.addEventListener("click", () => sortBy(th.getAttribute("data-col")));
      });

      tbody.innerHTML = rows.map((r) => {
        return "<tr>" + data.columns.map((c) => {
          const v = r[c];
          const title = v === null || v === undefined
            ? "NULL"
            : (typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/"/g, "&quot;");
          return '<td title="' + title + '">' + formatCell(v) + "</td>";
        }).join("") + "</tr>";
      }).join("");
    }

    if (data.ok && data.rows.length > 0) {
      renderTable();
    }
  </script>
</body>
</html>`;
}

function findQueryAtCursor(
  index: BunestWorkspaceIndex,
  editor: vscode.TextEditor,
): RawQueryExecutionRequest | undefined {
  const filePath = editor.document.uri.fsPath;
  const ctx = index.getContextForFile(filePath);
  const snap = ctx?.snapshot;
  if (!ctx || !snap) return undefined;

  const line1 = editor.selection.active.line + 1;
  for (const repo of snap.repositories) {
    if (repo.sourceFile !== filePath) continue;
    for (const m of repo.methods) {
      if (m.customQuery) {
        const decLoc = m.customQuery.decoratorLocation;
        if (line1 >= decLoc.line && line1 <= m.location.endLine) {
          return {
            sql: m.customQuery.sql,
            title: `${repo.className}.${m.name}()`,
            cwd: ctx.cwd,
            repo,
            method: m,
          };
        }
      } else if (m.derived) {
        if (line1 >= m.location.line && line1 <= m.location.endLine) {
          return {
            sql: m.derived.sqlPreview,
            title: `${repo.className}.${m.name}()`,
            cwd: ctx.cwd,
            repo,
            method: m,
          };
        }
      }
    }
  }
  return undefined;
}

/**
 * Interactive command to execute a `@Query(...)` or arbitrary raw SQL query
 * directly from VS Code without running the application.
 */
export async function runExecuteRawQueryCommand(
  index: BunestWorkspaceIndex,
  request?: RawQueryExecutionRequest,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let resolvedReq: RawQueryExecutionRequest | undefined = request;

  if (!resolvedReq?.sql && editor) {
    const selectedText = editor.document.getText(editor.selection).trim();
    if (selectedText.length > 0) {
      const ctx = index.getContextForFile(editor.document.uri.fsPath);
      resolvedReq = {
        sql: selectedText,
        title: "Selected SQL",
        cwd:
          ctx?.cwd ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
          process.cwd(),
      };
    } else {
      resolvedReq = findQueryAtCursor(index, editor);
    }
  }

  let sql = resolvedReq?.sql?.trim();
  if (!sql) {
    const entered = await vscode.window.showInputBox({
      title: "Bunest: Execute Raw SQL Query",
      prompt: "Enter a SQL query to execute directly",
      placeHolder: "SELECT COUNT(*) AS count FROM users",
    });
    if (!entered?.trim()) return;
    sql = entered.trim();
  }

  const cwd =
    resolvedReq?.cwd ??
    (editor
      ? index.getContextForFile(editor.document.uri.fsPath)?.cwd
      : undefined) ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    process.cwd();

  const title = resolvedReq?.title ?? "Raw SQL Query";
  const connection = await resolveConnection(cwd);
  if (!connection) return;

  const cacheKey = `${cwd}:${title}`;
  const paramResult = await promptForParameters(
    sql,
    cacheKey,
    resolvedReq?.method,
  );
  if (paramResult.cancelled) return;

  if (!(await confirmWriteIfNeeded(sql))) return;

  await runAndDisplaySql({
    sql,
    title,
    cwd,
    connection,
    specs: paramResult.specs,
    params: paramResult.params,
    method: resolvedReq?.method,
    cacheKey,
  });
}

async function runAndDisplaySql(opts: {
  sql: string;
  title: string;
  cwd: string;
  connection: SqlConnectionConfig;
  specs: readonly ParamInputSpec[];
  params: Record<string, unknown> | readonly unknown[];
  method?: AnalyzedQueryMethod;
  cacheKey: string;
}): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("bunest");
  const maxRows = cfg.get<number>("sql.maxRows") ?? 500;
  const timeoutMs = cfg.get<number>("sql.timeoutMs") ?? 15_000;
  const bunExecutable = cfg.get<string>("sql.bunPath") ?? "bun";

  let currentSql = opts.sql;
  let currentConn = opts.connection;
  let currentSpecs = opts.specs;
  let currentParams = opts.params;

  const executeOnce = async (): Promise<ExecuteRawSqlResult> =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Bunest SQL: Running ${opts.title}...`,
        cancellable: false,
      },
      () =>
        executeRawSql({
          sql: currentSql,
          connection: currentConn,
          cwd: opts.cwd,
          params: currentParams,
          maxRows,
          timeoutMs,
          bunExecutable,
        }),
    );

  const initialResult = await executeOnce();

  if (!activeResultPanel) {
    activeResultPanel = vscode.window.createWebviewPanel(
      "bunestSqlResult",
      `SQL: ${opts.title}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    activeResultPanel.onDidDispose(() => {
      activeMessageListener?.dispose();
      activeMessageListener = undefined;
      activeResultPanel = undefined;
    });
  } else {
    activeResultPanel.title = `SQL: ${opts.title}`;
    activeResultPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  const panel = activeResultPanel;
  const render = (res: ExecuteRawSqlResult): void => {
    panel.webview.html = renderSqlResultHtml({
      title: opts.title,
      sql: currentSql,
      maskedUrl: formatConnectionDisplay(currentConn, opts.cwd),
      specs: currentSpecs,
      result: res,
    });
  };

  render(initialResult);

  // Replace previous message listener when reusing the panel
  activeMessageListener?.dispose();
  activeMessageListener = panel.webview.onDidReceiveMessage(
    async (msg: {
      type?: string;
      sql?: string;
      paramInputs?: Array<{ key: string; tsType?: string; rawValue: string }>;
      text?: string;
      label?: string;
    }) => {
      if (msg.type === "copy" && typeof msg.text === "string") {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage(
          `Copied ${msg.label ?? "result"} to clipboard.`,
        );
        return;
      }

      if (msg.type === "switchDb") {
        const nextConn = await pickDatabaseConnection(opts.cwd, currentConn);
        if (!nextConn) return;
        currentConn = nextConn;
        if (typeof msg.sql === "string" && msg.sql.trim()) {
          currentSql = msg.sql;
        }
        const nextRes = await executeOnce();
        render(nextRes);
        return;
      }

      if (msg.type === "explain" && typeof msg.sql === "string") {
        const rawSql = msg.sql.trim();
        if (!rawSql) return;
        const alreadyExplain = /^\s*EXPLAIN\b/i.test(rawSql);
        const dialect = detectSqlDialect(
          currentConn.url ?? "",
          currentConn.dialect,
        );
        const explainSql = alreadyExplain
          ? rawSql
          : dialect === "postgres" || dialect === "cockroachdb"
            ? `EXPLAIN (ANALYZE, BUFFERS) ${rawSql}`
            : dialect === "sqlite" || dialect === "libsql" || dialect === "d1"
              ? `EXPLAIN QUERY PLAN ${rawSql}`
              : `EXPLAIN ${rawSql}`;
        const prevSql = currentSql;
        currentSql = explainSql;
        const planRes = await executeOnce();
        currentSql = prevSql;
        render(planRes);
        return;
      }

      if (msg.type === "rerun" && typeof msg.sql === "string") {
        const nextSql = msg.sql.trim();
        if (!nextSql) return;
        if (!(await confirmWriteIfNeeded(nextSql))) return;
        currentSql = nextSql;

        const placeholders = extractSqlPlaceholders(currentSql);
        const inputMap = new Map(
          (msg.paramInputs ?? []).map((p) => [p.key, p]),
        );

        if (placeholders.style === "named") {
          const nextSpecs: ParamInputSpec[] = [];
          const nextParams: Record<string, unknown> = {};
          for (const name of placeholders.named) {
            const existing = inputMap.get(name);
            const rawVal = existing?.rawValue ?? "";
            lastParamValues.set(`${opts.cacheKey}:named:${name}`, rawVal);
            nextSpecs.push({
              key: name,
              label: `:${name}${existing?.tsType ? ` (${existing.tsType})` : ""}`,
              tsType: existing?.tsType,
              rawValue: rawVal,
            });
            nextParams[name] = coerceSqlParamValue(rawVal, existing?.tsType);
          }
          currentSpecs = nextSpecs;
          currentParams = nextParams;
        } else if (placeholders.style === "positional") {
          const nextSpecs: ParamInputSpec[] = [];
          const nextParams: unknown[] = [];
          for (let i = 0; i < placeholders.positionalCount; i++) {
            const k = String(i + 1);
            const existing = inputMap.get(k);
            const rawVal = existing?.rawValue ?? "";
            lastParamValues.set(`${opts.cacheKey}:pos:${k}`, rawVal);
            nextSpecs.push({
              key: k,
              label: `$${k}${existing?.tsType ? ` (${existing.tsType})` : ""}`,
              tsType: existing?.tsType,
              rawValue: rawVal,
            });
            nextParams.push(coerceSqlParamValue(rawVal, existing?.tsType));
          }
          currentSpecs = nextSpecs;
          currentParams = nextParams;
        } else {
          currentSpecs = [];
          currentParams = [];
        }

        const nextRes = await executeOnce();
        render(nextRes);
      }
    },
  );
}

/**
 * Command to explicitly configure or switch the SQL Runner database connection.
 */
export async function runConfigureDatabaseConnectionCommand(
  index: BunestWorkspaceIndex,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const cwd =
    (editor
      ? index.getContextForFile(editor.document.uri.fsPath)?.cwd
      : undefined) ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    process.cwd();

  const configuredUrl = vscode.workspace
    .getConfiguration("bunest")
    .get<string>("sql.databaseUrl")
    ?.trim();
  const current: SqlConnectionConfig | undefined =
    lastConnectionByCwd.get(cwd) ??
    (configuredUrl
      ? {
          url: normalizeDatabaseUrl(configuredUrl, cwd),
          dialect: detectSqlDialect(configuredUrl),
        }
      : undefined);

  const chosen = await pickDatabaseConnection(cwd, current);
  if (chosen) {
    vscode.window.showInformationMessage(
      `Bunest SQL Runner connected to: ${formatConnectionDisplay(chosen, cwd)}`,
    );
  }
}
