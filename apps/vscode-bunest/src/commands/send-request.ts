import { cond } from "@bunest/core/common";
import * as vscode from "vscode";
import type { ExtractedRouteEntry } from "@bunest/cli";

const lastParamValues = new Map<string, string>();
const lastBodyValues = new Map<string, string>();

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderResponseHtml(data: {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly elapsedMs: number;
  readonly headers: readonly [string, string][];
  readonly body: string;
  readonly curl: string;
}): string {
  const statusColor = cond(
    [
      [data.status >= 200 && data.status < 300, "#22c55e"],
      [data.status >= 400, "#ef4444"],
    ],
    "#eab308",
  );

  const headersRows = data.headers
    .map(
      ([k, v]) =>
        `<tr><td><code>${escapeHtml(k)}</code></td><td><code>${escapeHtml(v)}</code></td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  .bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .badge { padding: 3px 8px; border-radius: 4px; font-weight: 700; color: #fff; background: ${statusColor}; }
  .method { padding: 3px 8px; border-radius: 4px; font-weight: 700; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  pre { background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 6px; overflow: auto; font-family: var(--vscode-editor-font-family); }
  table { border-collapse: collapse; width: 100%; margin-bottom: 14px; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
  <div class="bar">
    <span class="method">${escapeHtml(data.method)}</span>
    <code>${escapeHtml(data.url)}</code>
    <span class="badge">${data.status} ${escapeHtml(data.statusText)}</span>
    <span>${data.elapsedMs.toFixed(1)} ms</span>
    <button onclick="copyCurl()">Copy cURL</button>
  </div>
  <h3>Response Body</h3>
  <pre>${escapeHtml(data.body)}</pre>
  <h3>Headers</h3>
  <table>${headersRows}</table>
  <script>
    const vscode = acquireVsCodeApi();
    function copyCurl() { vscode.postMessage({ type: 'copyCurl', curl: ${JSON.stringify(data.curl)} }); }
  </script>
</body>
</html>`;
}

export async function runSendRequestCommand(
  route: ExtractedRouteEntry | undefined,
): Promise<void> {
  if (!route) {
    vscode.window.showWarningMessage("No Bunest route selected.");
    return;
  }

  const defaultBase =
    vscode.workspace
      .getConfiguration("bunest")
      .get<string>("http.baseUrl") ?? "http://localhost:3000";

  let resolvedPath = route.path;
  const paramMatches = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)];
  for (const m of paramMatches) {
    const paramName = m[1]!;
    const key = `${route.key}:${paramName}`;
    const value = await vscode.window.showInputBox({
      prompt: `Path parameter :${paramName} for ${route.method} ${route.path}`,
      value: lastParamValues.get(key) ?? "1",
    });
    if (value === undefined) return;
    lastParamValues.set(key, value);
    resolvedPath = resolvedPath.replace(`:${paramName}`, encodeURIComponent(value));
  }

  const baseUrl = defaultBase.replace(/\/+$/, "");
  const fullUrl = `${baseUrl}${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`;

  let requestBody: string | undefined;
  if (
    route.method === "POST" ||
    route.method === "PUT" ||
    route.method === "PATCH"
  ) {
    const entered = await vscode.window.showInputBox({
      prompt: `JSON request body for ${route.method} ${resolvedPath} (type: ${route.bodyTypeText})`,
      value: lastBodyValues.get(route.key) ?? "{}",
    });
    if (entered === undefined) return;
    lastBodyValues.set(route.key, entered);
    requestBody = entered;
  }

  const curlParts = [`curl -X ${route.method}`];
  if (requestBody) {
    curlParts.push(`-H "Content-Type: application/json"`);
    curlParts.push(`-d ${JSON.stringify(requestBody)}`);
  }
  curlParts.push(JSON.stringify(fullUrl));
  const curl = curlParts.join(" ");

  const start = performance.now();
  try {
    const response = await fetch(fullUrl, {
      method: route.method === "ALL" ? "GET" : route.method,
      headers: requestBody
        ? { "Content-Type": "application/json" }
        : undefined,
      body: requestBody,
    });
    const elapsedMs = performance.now() - start;
    const rawBody = await response.text();
    let prettyBody = rawBody;
    try {
      prettyBody = JSON.stringify(JSON.parse(rawBody), null, 2);
    } catch {
      // non-JSON response
    }

    const headers: [string, string][] = [];
    response.headers.forEach((v, k) => headers.push([k, v]));

    const panel = vscode.window.createWebviewPanel(
      "bunestHttpResponse",
      `${route.method} ${resolvedPath} (${response.status})`,
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );
    panel.webview.html = renderResponseHtml({
      method: route.method,
      url: fullUrl,
      status: response.status,
      statusText: response.statusText,
      elapsedMs,
      headers,
      body: prettyBody,
      curl,
    });
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; curl?: string }) => {
      if (msg.type === "copyCurl" && msg.curl) {
        await vscode.env.clipboard.writeText(msg.curl);
        vscode.window.showInformationMessage("Copied cURL command to clipboard.");
      }
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Bunest HTTP request failed (${fullUrl}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
