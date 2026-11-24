function escapeHtml(text: string): string {
  return Bun.escapeHTML(text);
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Renders a self-contained, zero-CDN, XSS-safe interactive GraphQL Playground HTML page.
 */
export function renderGraphiqlHtml(
  endpointPath: string,
  title = "Bunest GraphQL Playground",
  options?: Record<string, unknown>,
): string {
  const safeTitle = escapeHtml(title);
  const safeEndpointJson = escapeJsonForScript(endpointPath);
  const safeEndpointDisplay = escapeHtml(endpointPath);
  const optionEntries: string[] = [];
  if (options && typeof options === "object") {
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined) {
        optionEntries.push(`${k}: ${escapeJsonForScript(v)}`);
      }
    }
  }
  const graphiqlOptionsBlock =
    optionEntries.length > 0
      ? `const graphiqlOptions = { ${optionEntries.join(", ")} };`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f1f5f9; height: 100vh; display: flex; flex-direction: column; }
    header { padding: 12px 20px; background: #1e293b; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; }
    header h1 { margin: 0; font-size: 1rem; font-weight: 600; }
    header code { color: #38bdf8; font-size: 0.85rem; }
    .toolbar button { background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 600; cursor: pointer; }
    .workspace { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #334155; min-height: 0; }
    .pane { background: #0f172a; display: flex; flex-direction: column; min-height: 0; }
    .pane label { padding: 8px 12px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; border-bottom: 1px solid #1e293b; }
    textarea, pre { flex: 1; margin: 0; padding: 12px; background: #0f172a; color: #e2e8f0; border: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; resize: none; overflow: auto; }
    textarea:focus { outline: none; }
    .vars-pane { height: 30%; border-top: 1px solid #334155; display: flex; flex-direction: column; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${safeTitle}</h1>
      <code>POST ${safeEndpointDisplay}</code>
    </div>
    <div class="toolbar">
      <button id="run-btn" type="button">Run Query (Ctrl+Enter)</button>
    </div>
  </header>
  <div class="workspace">
    <div class="pane">
      <label for="gql-query">Query / Mutation</label>
      <textarea id="gql-query" spellcheck="false">query {
  __typename
}</textarea>
      <div class="vars-pane">
        <label for="gql-vars">Variables (JSON)</label>
        <textarea id="gql-vars" spellcheck="false">{}</textarea>
      </div>
    </div>
    <div class="pane">
      <label>Response</label>
      <pre id="gql-output">{}</pre>
    </div>
  </div>
  <script>
    (function () {
      const endpoint = ${safeEndpointJson};
      ${graphiqlOptionsBlock}
      const queryEl = document.getElementById("gql-query");
      const varsEl = document.getElementById("gql-vars");
      const outEl = document.getElementById("gql-output");
      const runBtn = document.getElementById("run-btn");

      async function execute() {
        outEl.textContent = "Executing...";
        let variables;
        try {
          const rawVars = varsEl.value.trim();
          variables = rawVars ? JSON.parse(rawVars) : undefined;
        } catch (err) {
          outEl.textContent = "Invalid variables JSON: " + String(err);
          return;
        }
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: queryEl.value, variables }),
          });
          const data = await res.json();
          outEl.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          outEl.textContent = String(err);
        }
      }

      runBtn.addEventListener("click", execute);
      queryEl.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          execute();
        }
      });
    })();
  </script>
</body>
</html>`;
}
