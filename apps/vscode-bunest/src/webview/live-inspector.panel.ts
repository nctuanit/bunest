import * as vscode from "vscode";

export interface LiveMetricsSnapshot {
  readonly reachable: boolean;
  readonly liveOk: boolean;
  readonly readyOk: boolean;
  readonly totalRequests: number;
  readonly total5xx: number;
  readonly inFlight: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly rssMb: number;
  readonly eventLoopLagMs: number;
  readonly dbPoolMax: number;
  readonly timestamp: string;
  readonly error?: string;
}

export function parsePrometheusMetrics(text: string): {
  totalRequests: number;
  total5xx: number;
  inFlight: number;
  p95Ms: number;
  p99Ms: number;
  rssMb: number;
  eventLoopLagMs: number;
  dbPoolMax: number;
} {
  const num = (metric: string): number => {
    const m = new RegExp(`^${metric}\\s+([0-9.eE+-]+)`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    totalRequests: num("bunest_http_requests_total"),
    total5xx: num("bunest_http_requests_5xx_total"),
    inFlight: num("bunest_http_requests_in_flight"),
    p95Ms: num("bunest_http_request_duration_ms_p95"),
    p99Ms: num("bunest_http_request_duration_ms_p99"),
    rssMb: Math.round((num("bunest_process_resident_memory_bytes") / (1024 * 1024)) * 10) / 10,
    eventLoopLagMs: num("bunest_event_loop_lag_ms"),
    dbPoolMax: num("bunest_db_pool_max"),
  };
}

export async function probeLocalBunestApp(
  baseUrl: string,
  metricsToken?: string,
): Promise<LiveMetricsSnapshot> {
  const clean = baseUrl.replace(/\/+$/, "");
  const timestamp = new Date().toLocaleTimeString();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const [liveRes, readyRes] = await Promise.all([
        fetch(`${clean}/live`, { signal: controller.signal }),
        fetch(`${clean}/ready`, { signal: controller.signal }),
      ]);
      const headers: Record<string, string> = {};
      if (metricsToken) headers.Authorization = `Bearer ${metricsToken}`;
      let parsed = {
        totalRequests: 0,
        total5xx: 0,
        inFlight: 0,
        p95Ms: 0,
        p99Ms: 0,
        rssMb: 0,
        eventLoopLagMs: 0,
        dbPoolMax: 0,
      };
      try {
        const mRes = await fetch(`${clean}/metrics`, {
          headers,
          signal: controller.signal,
        });
        if (mRes.ok) {
          parsed = parsePrometheusMetrics(await mRes.text());
        }
      } catch {
        // /metrics optional or protected
      }
      return {
        reachable: true,
        liveOk: liveRes.ok,
        readyOk: readyRes.ok,
        ...parsed,
        timestamp,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      reachable: false,
      liveOk: false,
      readyOk: false,
      totalRequests: 0,
      total5xx: 0,
      inFlight: 0,
      p95Ms: 0,
      p99Ms: 0,
      rssMb: 0,
      eventLoopLagMs: 0,
      dbPoolMax: 0,
      timestamp,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildInspectorHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 5px 8px; font-size: 12px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; }
  .card .label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .val { font-size: 22px; font-weight: 700; font-family: var(--vscode-editor-font-family); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; background: #64748b; }
  .pill.up { background: #16a34a; }
  .pill.down { background: #dc2626; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
</style>
</head>
<body>
  <div class="bar">
    <strong>Bunest Live App Inspector</strong>
    <input id="baseUrl" value="${baseUrl.replace(/"/g, "&quot;")}" style="width:240px" />
    <input id="token" type="password" placeholder="Optional METRICS_TOKEN" style="width:180px" />
    <button onclick="pollNow()">Refresh</button>
    <button class="secondary" id="toggleBtn" onclick="toggleAuto()">Pause (2s)</button>
    <span id="ts" class="muted"></span>
  </div>

  <div class="bar">
    <span>/live: <span id="livePill" class="pill">--</span></span>
    <span>/ready: <span id="readyPill" class="pill">--</span></span>
    <span id="errText" class="muted"></span>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Total Requests</div><div class="val" id="mTotal">--</div></div>
    <div class="card"><div class="label">5xx Errors</div><div class="val" id="m5xx">--</div></div>
    <div class="card"><div class="label">In-Flight</div><div class="val" id="mInFlight">--</div></div>
    <div class="card"><div class="label">Latency p95</div><div class="val" id="mP95">--</div></div>
    <div class="card"><div class="label">Latency p99</div><div class="val" id="mP99">--</div></div>
    <div class="card"><div class="label">Process RSS</div><div class="val" id="mRss">--</div></div>
    <div class="card"><div class="label">Event-Loop Lag</div><div class="val" id="mLag">--</div></div>
    <div class="card"><div class="label">DB Pool Max</div><div class="val" id="mPool">--</div></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let auto = true;
    let timer = setInterval(() => { if (auto) pollNow(); }, 2000);

    function pollNow() {
      vscode.postMessage({
        type: "poll",
        baseUrl: document.getElementById("baseUrl").value.trim(),
        metricsToken: document.getElementById("token").value.trim(),
      });
    }

    function toggleAuto() {
      auto = !auto;
      document.getElementById("toggleBtn").textContent = auto ? "Pause (2s)" : "Resume (2s)";
    }

    window.addEventListener("message", (event) => {
      const m = event.data;
      if (m.type !== "snapshot") return;
      const s = m.snapshot;
      document.getElementById("ts").textContent = "Updated " + s.timestamp;
      const livePill = document.getElementById("livePill");
      livePill.textContent = s.liveOk ? "200 UP" : "DOWN";
      livePill.className = "pill " + (s.liveOk ? "up" : "down");

      const readyPill = document.getElementById("readyPill");
      readyPill.textContent = s.readyOk ? "200 READY" : "503 NOT READY";
      readyPill.className = "pill " + (s.readyOk ? "up" : "down");

      document.getElementById("errText").textContent = s.error ? ("(" + s.error + ")") : "";
      document.getElementById("mTotal").textContent = String(s.totalRequests);
      document.getElementById("m5xx").textContent = String(s.total5xx);
      document.getElementById("mInFlight").textContent = String(s.inFlight);
      document.getElementById("mP95").textContent = s.p95Ms.toFixed(1) + " ms";
      document.getElementById("mP99").textContent = s.p99Ms.toFixed(1) + " ms";
      document.getElementById("mRss").textContent = s.rssMb.toFixed(1) + " MB";
      document.getElementById("mLag").textContent = s.eventLoopLagMs.toFixed(2) + " ms";
      document.getElementById("mPool").textContent = String(s.dbPoolMax);
    });

    pollNow();
  </script>
</body>
</html>`;
}

export class BunestLiveInspectorPanel {
  private static current: vscode.WebviewPanel | undefined;

  static show(): void {
    const baseUrl =
      vscode.workspace
        .getConfiguration("bunest")
        .get<string>("http.baseUrl") ?? "http://localhost:3000";

    if (this.current) {
      this.current.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "bunestLiveInspector",
      "Bunest Live App Inspector",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.current = panel;
    panel.webview.html = buildInspectorHtml(baseUrl);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "poll") {
        const snapshot = await probeLocalBunestApp(
          String(msg.baseUrl || baseUrl),
          msg.metricsToken ? String(msg.metricsToken) : undefined,
        );
        panel.webview.postMessage({ type: "snapshot", snapshot });
      }
    });

    panel.onDidDispose(() => {
      this.current = undefined;
    });
  }
}
