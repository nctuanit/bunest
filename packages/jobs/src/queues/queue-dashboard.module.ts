import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  ModuleRef,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  UseGuards,
  type CanActivate,
  type DynamicModule,
  type Type,
} from "@bunest/core";
import type { Job, JobStatus, QueueCounts } from "./interfaces";
import type { Queue } from "./queue";
import { QueueRegistry } from "./queue.module";
import { QUEUE_REGISTRY, getQueueToken } from "./tokens";

export const QUEUE_DASHBOARD_OPTIONS = Symbol.for(
  "bunest:queues:dashboard-options",
);

export type CanActivateClass = Type<CanActivate>;

export interface QueueDashboardModuleOptions {
  /**
   * HTTP mount path for the Queue Admin Dashboard UI and JSON API.
   * @default "/admin/queues"
   */
  readonly path?: string;
  /**
   * Optional allowlist of queue names to expose. When omitted or empty,
   * all queues registered in `QueueRegistry` are exposed.
   */
  readonly queues?: readonly string[];
  /**
   * Title shown in the HTML dashboard UI and API metadata.
   * @default "Bunest Queue Dashboard"
   */
  readonly title?: string;
  /**
   * Optional guards protecting all dashboard UI and admin API routes.
   */
  readonly guards?: readonly (CanActivateClass | CanActivate)[];
  /**
   * Registers `QueueDashboardModule` globally.
   * @default false
   */
  readonly global?: boolean;
}

export interface QueueDashboardQueueSummary {
  readonly name: string;
  readonly isPaused: boolean;
  readonly isClosed: boolean;
  readonly activeCount: number;
  readonly counts: QueueCounts;
}

export interface QueueDashboardJobRecord {
  readonly id: string;
  readonly queueName: string;
  readonly name: string;
  readonly data: unknown;
  readonly priority: number;
  readonly idempotencyKey?: string;
  readonly maxAttempts: number;
  readonly attemptsMade: number;
  readonly status: JobStatus;
  readonly createdAt: number;
  readonly processAfter: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly returnValue?: unknown;
  readonly failedReason?: string;
  readonly stacktrace: readonly string[];
  readonly stalledCount?: number;
}

export interface QueueDashboardQueuesResponse {
  readonly title: string;
  readonly queues: readonly QueueDashboardQueueSummary[];
}

export interface QueueDashboardJobsResponse {
  readonly queue: string;
  readonly isPaused: boolean;
  readonly isClosed: boolean;
  readonly activeCount: number;
  readonly counts: QueueCounts;
  readonly jobs: readonly QueueDashboardJobRecord[];
}

const VALID_JOB_STATUSES = new Set<string>([
  "all",
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead-letter",
]);

function normalizeDashboardPath(path?: string): string {
  const raw = (path ?? "/admin/queues").trim();
  if (!raw || raw === "/") {
    return "/";
  }
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeJob(job: Job<any, any>): QueueDashboardJobRecord {
  return {
    id: job.id,
    queueName: job.queueName,
    name: job.name,
    data: job.data,
    priority: job.priority,
    ...(job.idempotencyKey !== undefined
      ? { idempotencyKey: job.idempotencyKey }
      : {}),
    maxAttempts: job.maxAttempts,
    attemptsMade: job.attemptsMade,
    status: job.status,
    createdAt: job.createdAt,
    processAfter: job.processAfter,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.returnValue !== undefined ? { returnValue: job.returnValue } : {}),
    ...(job.failedReason !== undefined
      ? { failedReason: job.failedReason }
      : {}),
    stacktrace: Array.isArray(job.stacktrace) ? [...job.stacktrace] : [],
    ...(job.stalledCount !== undefined
      ? { stalledCount: job.stalledCount }
      : {}),
  };
}

/**
 * Renders the self-contained, zero-dependency dark-theme HTML UI for the
 * Bunest Queue Admin Dashboard (no external CDNs, scripts, or stylesheets).
 */
export function renderQueueDashboardHtml(options: {
  readonly basePath: string;
  readonly title: string;
}): string {
  const safeTitle = escapeHtml(options.title);
  const apiBase =
    options.basePath === "/" ? "/api" : `${options.basePath}/api`;
  const serializedConfig = JSON.stringify({
    apiBase,
    title: options.title,
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f17;
      --panel: #111827;
      --panel-alt: #162033;
      --border: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.14);
      --ok: #34d399;
      --warn: #fbbf24;
      --danger: #f87171;
      --purple: #a78bfa;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1rem 1.5rem;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 12px var(--accent);
    }
    h1 {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--muted);
    }
    button {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    button:hover { background: #1e293b; border-color: #334155; }
    button.primary { border-color: var(--accent); color: var(--accent); }
    button.warn { border-color: var(--warn); color: var(--warn); }
    button.ok { border-color: var(--ok); color: var(--ok); }
    button.danger { border-color: var(--danger); color: var(--danger); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    main {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 1.25rem;
      padding: 1.25rem 1.5rem;
      flex: 1;
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
    }
    .section-title {
      margin: 0 0 0.75rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .queue-list {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }
    .queue-item {
      padding: 0.8rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--panel-alt);
      cursor: pointer;
    }
    .queue-item.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent-soft);
    }
    .queue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .queue-name {
      font-weight: 600;
      font-family: var(--mono);
      font-size: 0.9rem;
      word-break: break-all;
    }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 999px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-running, .badge-completed { background: rgba(52, 211, 153, 0.15); color: var(--ok); }
    .badge-paused, .badge-delayed { background: rgba(251, 191, 36, 0.15); color: var(--warn); }
    .badge-active, .badge-waiting { background: rgba(56, 189, 248, 0.15); color: var(--accent); }
    .badge-failed, .badge-dead-letter, .badge-closed { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
    .counts-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.35rem;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .count-cell {
      background: rgba(0, 0, 0, 0.22);
      border-radius: 5px;
      padding: 0.3rem 0.45rem;
      display: flex;
      justify-content: space-between;
    }
    .count-cell strong { color: var(--text); font-family: var(--mono); }
    .queue-actions {
      display: flex;
      gap: 0.4rem;
      margin-top: 0.6rem;
    }
    .jobs-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.85rem;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }
    .filters button.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    th, td {
      text-align: left;
      padding: 0.6rem 0.65rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mono { font-family: var(--mono); font-size: 0.78rem; }
    .payload {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.75rem;
    }
    .error-msg {
      color: var(--danger);
      font-family: var(--mono);
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }
    .empty {
      padding: 2rem;
      text-align: center;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .toast {
      position: fixed;
      bottom: 1rem;
      right: 1rem;
      background: var(--panel-alt);
      border: 1px solid var(--accent);
      color: var(--text);
      padding: 0.6rem 0.9rem;
      border-radius: 8px;
      font-size: 0.82rem;
      display: none;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-dot" aria-hidden="true"></span>
      <h1>${safeTitle}</h1>
    </div>
    <div class="toolbar">
      <span id="last-updated">Loading...</span>
      <button id="refresh-btn" class="primary" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <section class="card">
      <h2 class="section-title">Queues</h2>
      <div id="queue-list" class="queue-list">
        <div class="empty">Loading queues...</div>
      </div>
    </section>
    <section class="card">
      <div class="jobs-header">
        <div>
          <h2 class="section-title" style="margin-bottom:0.2rem">Jobs</h2>
          <div id="selected-queue-label" class="mono" style="color:var(--muted)">Select a queue</div>
        </div>
        <div class="filters" id="status-filters"></div>
      </div>
      <div id="jobs-container">
        <div class="empty">Select a queue to inspect jobs.</div>
      </div>
    </section>
  </main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script>
    (function () {
      const cfg = ${serializedConfig};
      const statuses = ["all", "waiting", "active", "delayed", "completed", "failed", "dead-letter"];
      let selectedQueue = null;
      let selectedStatus = "all";

      const queueListEl = document.getElementById("queue-list");
      const jobsContainerEl = document.getElementById("jobs-container");
      const selectedQueueLabelEl = document.getElementById("selected-queue-label");
      const statusFiltersEl = document.getElementById("status-filters");
      const lastUpdatedEl = document.getElementById("last-updated");
      const toastEl = document.getElementById("toast");

      function showToast(msg) {
        toastEl.textContent = msg;
        toastEl.style.display = "block";
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => { toastEl.style.display = "none"; }, 2500);
      }

      async function api(path, init) {
        const res = await fetch(cfg.apiBase + path, init);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.message || ("HTTP " + res.status));
        }
        return body;
      }

      function renderFilters() {
        statusFiltersEl.innerHTML = "";
        for (const st of statuses) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = st;
          if (st === selectedStatus) btn.className = "active";
          btn.onclick = () => {
            selectedStatus = st;
            renderFilters();
            if (selectedQueue) loadJobs(selectedQueue);
          };
          statusFiltersEl.appendChild(btn);
        }
      }

      async function loadQueues() {
        try {
          const data = await api("/queues");
          const queues = data.queues || [];
          lastUpdatedEl.textContent = "Updated " + new Date().toLocaleTimeString();
          if (queues.length === 0) {
            queueListEl.innerHTML = '<div class="empty">No queues registered.</div>';
            jobsContainerEl.innerHTML = '<div class="empty">No queues available.</div>';
            return;
          }
          if (!selectedQueue || !queues.some((q) => q.name === selectedQueue)) {
            selectedQueue = queues[0].name;
          }
          queueListEl.innerHTML = "";
          for (const q of queues) {
            const item = document.createElement("div");
            item.className = "queue-item" + (q.name === selectedQueue ? " selected" : "");
            item.onclick = () => {
              selectedQueue = q.name;
              loadQueues();
            };

            const head = document.createElement("div");
            head.className = "queue-head";
            const nameEl = document.createElement("span");
            nameEl.className = "queue-name";
            nameEl.textContent = q.name;
            const badge = document.createElement("span");
            const state = q.isClosed ? "closed" : q.isPaused ? "paused" : "running";
            badge.className = "badge badge-" + state;
            badge.textContent = state;
            head.append(nameEl, badge);

            const grid = document.createElement("div");
            grid.className = "counts-grid";
            const pairs = [
              ["wait", q.counts.waiting],
              ["act", q.counts.active],
              ["dly", q.counts.delayed],
              ["ok", q.counts.completed],
              ["fail", q.counts.failed],
              ["dlq", q.counts.deadLetter],
            ];
            for (const [label, val] of pairs) {
              const cell = document.createElement("div");
              cell.className = "count-cell";
              const k = document.createElement("span");
              k.textContent = label;
              const v = document.createElement("strong");
              v.textContent = String(val);
              cell.append(k, v);
              grid.appendChild(cell);
            }

            const actions = document.createElement("div");
            actions.className = "queue-actions";
            const toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.className = q.isPaused ? "ok" : "warn";
            toggleBtn.textContent = q.isPaused ? "Resume" : "Pause";
            toggleBtn.onclick = async (ev) => {
              ev.stopPropagation();
              try {
                const action = q.isPaused ? "resume" : "pause";
                await api("/queues/" + encodeURIComponent(q.name) + "/" + action, { method: "POST" });
                showToast((q.isPaused ? "Resumed " : "Paused ") + q.name);
                await loadQueues();
              } catch (err) {
                showToast("Error: " + err.message);
              }
            };
            actions.appendChild(toggleBtn);

            item.append(head, grid, actions);
            queueListEl.appendChild(item);
          }

          if (selectedQueue) {
            await loadJobs(selectedQueue);
          }
        } catch (err) {
          queueListEl.innerHTML = "";
          const el = document.createElement("div");
          el.className = "empty";
          el.textContent = "Failed to load queues: " + err.message;
          queueListEl.appendChild(el);
        }
      }

      async function loadJobs(queueName) {
        selectedQueueLabelEl.textContent = queueName + " (" + selectedStatus + ")";
        try {
          const qs = selectedStatus && selectedStatus !== "all"
            ? "?status=" + encodeURIComponent(selectedStatus)
            : "";
          const data = await api("/queues/" + encodeURIComponent(queueName) + "/jobs" + qs);
          const jobs = data.jobs || [];
          if (jobs.length === 0) {
            jobsContainerEl.innerHTML = '<div class="empty">No jobs found for this filter.</div>';
            return;
          }

          const table = document.createElement("table");
          const thead = document.createElement("thead");
          thead.innerHTML = "<tr><th>ID</th><th>Name</th><th>Status</th><th>Attempts</th><th>Data / Error</th><th>Actions</th></tr>";
          const tbody = document.createElement("tbody");

          for (const job of jobs) {
            const tr = document.createElement("tr");

            const tdId = document.createElement("td");
            tdId.className = "mono";
            tdId.textContent = job.id;

            const tdName = document.createElement("td");
            tdName.className = "mono";
            tdName.textContent = job.name;

            const tdStatus = document.createElement("td");
            const badge = document.createElement("span");
            badge.className = "badge badge-" + job.status;
            badge.textContent = job.status;
            tdStatus.appendChild(badge);

            const tdAttempts = document.createElement("td");
            tdAttempts.className = "mono";
            tdAttempts.textContent = String(job.attemptsMade) + " / " + String(job.maxAttempts);

            const tdPayload = document.createElement("td");
            const payloadDiv = document.createElement("div");
            payloadDiv.className = "payload";
            try { payloadDiv.textContent = JSON.stringify(job.data); }
            catch { payloadDiv.textContent = String(job.data); }
            tdPayload.appendChild(payloadDiv);
            if (job.failedReason) {
              const errDiv = document.createElement("div");
              errDiv.className = "error-msg";
              errDiv.textContent = job.failedReason;
              tdPayload.appendChild(errDiv);
            }

            const tdAct = document.createElement("td");
            if (job.status === "dead-letter" || job.status === "failed") {
              const retryBtn = document.createElement("button");
              retryBtn.type = "button";
              retryBtn.className = "primary";
              retryBtn.textContent = "Retry";
              retryBtn.onclick = async () => {
                try {
                  await api(
                    "/queues/" + encodeURIComponent(queueName) + "/jobs/" + encodeURIComponent(job.id) + "/retry",
                    { method: "POST" },
                  );
                  showToast("Retried job " + job.id);
                  await loadQueues();
                } catch (err) {
                  showToast("Retry failed: " + err.message);
                }
              };
              tdAct.appendChild(retryBtn);
            }

            tr.append(tdId, tdName, tdStatus, tdAttempts, tdPayload, tdAct);
            tbody.appendChild(tr);
          }

          table.append(thead, tbody);
          jobsContainerEl.innerHTML = "";
          jobsContainerEl.appendChild(table);
        } catch (err) {
          jobsContainerEl.innerHTML = "";
          const el = document.createElement("div");
          el.className = "empty";
          el.textContent = "Failed to load jobs: " + err.message;
          jobsContainerEl.appendChild(el);
        }
      }

      document.getElementById("refresh-btn").onclick = loadQueues;
      renderFilters();
      loadQueues();
      setInterval(loadQueues, 5000);
    })();
  </script>
</body>
</html>`;
}

function createQueueDashboardController(
  basePath: string,
  title: string,
  allowedQueues: readonly string[] | undefined,
  guards: readonly (CanActivateClass | CanActivate)[],
): Type<unknown> {
  const allowSet =
    allowedQueues && allowedQueues.length > 0
      ? new Set(allowedQueues)
      : undefined;

  @Controller(basePath)
  class QueueDashboardController {
    constructor(
      @Optional()
      @Inject(QUEUE_REGISTRY)
      private readonly registry?: QueueRegistry,
      @Optional()
      private readonly moduleRef?: ModuleRef,
    ) {}

    private resolveVisibleQueues(): Queue<any, any>[] {
      const byName = new Map<string, Queue<any, any>>();
      for (const q of this.registry?.getAll() ?? []) {
        byName.set(q.name, q);
      }

      if (allowSet && allowedQueues) {
        const result: Queue<any, any>[] = [];
        for (const name of allowedQueues) {
          let queue = byName.get(name);
          if (!queue && this.moduleRef) {
            try {
              queue = this.moduleRef.get<Queue<any, any>>(getQueueToken(name), {
                strict: false,
              });
            } catch {
              queue = undefined;
            }
          }
          if (queue) {
            result.push(queue);
          }
        }
        return result;
      }

      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    private resolveQueue(rawName: string): Queue<any, any> {
      const name = safeDecodeURIComponent(rawName);
      if (allowSet && !allowSet.has(name)) {
        throw new NotFoundException(`Queue "${name}" not found.`);
      }
      let queue = this.registry?.get(name);
      if (!queue && this.moduleRef) {
        try {
          queue = this.moduleRef.get<Queue<any, any>>(getQueueToken(name), {
            strict: false,
          });
        } catch {
          queue = undefined;
        }
      }
      if (!queue) {
        throw new NotFoundException(`Queue "${name}" not found.`);
      }
      return queue;
    }

    @Get()
    getDashboardHtml(): Response {
      const html = renderQueueDashboardHtml({ basePath, title });
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    @Get("api/queues")
    async listQueues(): Promise<QueueDashboardQueuesResponse> {
      const queues = this.resolveVisibleQueues();
      const summaries = await Promise.all(
        queues.map(async (queue): Promise<QueueDashboardQueueSummary> => ({
          name: queue.name,
          isPaused: queue.isPaused,
          isClosed: queue.isClosed,
          activeCount: queue.activeCount,
          counts: await queue.getCounts(),
        })),
      );
      return {
        title,
        queues: summaries,
      };
    }

    @Get("api/queues/:name/jobs")
    async listQueueJobs(
      @Param("name") rawName: string,
      @Query("status") rawStatus?: string,
      @Query("limit") rawLimit?: string,
      @Query("offset") rawOffset?: string,
    ): Promise<QueueDashboardJobsResponse> {
      const queue = this.resolveQueue(rawName);
      const status = rawStatus?.trim() || "all";
      if (!VALID_JOB_STATUSES.has(status)) {
        throw new BadRequestException(
          `Invalid status filter "${status}". Expected one of: ${[...VALID_JOB_STATUSES].join(", ")}.`,
        );
      }

      const parsedLimit =
        rawLimit !== undefined && rawLimit !== "" ? Number(rawLimit) : 50;
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(500, Math.max(0, Math.floor(parsedLimit)))
        : 50;

      const parsedOffset =
        rawOffset !== undefined && rawOffset !== "" ? Number(rawOffset) : 0;
      const offset = Number.isFinite(parsedOffset)
        ? Math.max(0, Math.floor(parsedOffset))
        : 0;

      const [counts, jobs] = await Promise.all([
        queue.getCounts(),
        queue.getJobs(status as JobStatus | "all", limit, offset),
      ]);

      return {
        queue: queue.name,
        isPaused: queue.isPaused,
        isClosed: queue.isClosed,
        activeCount: queue.activeCount,
        counts,
        jobs: jobs.map(serializeJob),
      };
    }

    @Post("api/queues/:name/jobs/:id/retry")
    @HttpCode(200)
    async retryQueueJob(
      @Param("name") rawName: string,
      @Param("id") rawId: string,
    ): Promise<{
      readonly ok: true;
      readonly queue: string;
      readonly job: QueueDashboardJobRecord;
    }> {
      const queue = this.resolveQueue(rawName);
      const jobId = safeDecodeURIComponent(rawId);
      const retried = await queue.retryJob(jobId);
      if (!retried) {
        const existing = await queue.getJob(jobId);
        if (!existing) {
          throw new NotFoundException(
            `Job "${jobId}" not found in queue "${queue.name}".`,
          );
        }
        throw new BadRequestException(
          `Job "${jobId}" in queue "${queue.name}" has status "${existing.status}" and cannot be retried.`,
        );
      }
      return {
        ok: true,
        queue: queue.name,
        job: serializeJob(retried),
      };
    }

    @Post("api/queues/:name/pause")
    @HttpCode(200)
    pauseQueue(@Param("name") rawName: string): {
      readonly ok: true;
      readonly queue: string;
      readonly isPaused: boolean;
    } {
      const queue = this.resolveQueue(rawName);
      queue.pause();
      return {
        ok: true,
        queue: queue.name,
        isPaused: queue.isPaused,
      };
    }

    @Post("api/queues/:name/resume")
    @HttpCode(200)
    resumeQueue(@Param("name") rawName: string): {
      readonly ok: true;
      readonly queue: string;
      readonly isPaused: boolean;
    } {
      const queue = this.resolveQueue(rawName);
      queue.resume();
      return {
        ok: true,
        queue: queue.name,
        isPaused: queue.isPaused,
      };
    }
  }

  if (guards.length > 0) {
    UseGuards(...guards)(QueueDashboardController);
  }

  return QueueDashboardController;
}

/**
 * Zero-dependency Queue Admin Dashboard module serving a self-contained HTML UI
 * and JSON admin API backed by `QueueRegistry` / registered `Queue` instances.
 */
@Module({})
export class QueueDashboardModule {
  static forRoot(options: QueueDashboardModuleOptions = {}): DynamicModule {
    const basePath = normalizeDashboardPath(options.path);
    const title = options.title ?? "Bunest Queue Dashboard";
    const guards = options.guards ? [...options.guards] : [];
    const controller = createQueueDashboardController(
      basePath,
      title,
      options.queues,
      guards,
    );

    return {
      module: QueueDashboardModule,
      global: options.global ?? false,
      controllers: [controller],
      providers: [
        {
          provide: QUEUE_DASHBOARD_OPTIONS,
          useValue: {
            ...options,
            path: basePath,
            title,
          },
        },
      ],
      exports: [QUEUE_DASHBOARD_OPTIONS],
    };
  }
}
