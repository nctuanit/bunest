import { dirname, ensureDir, relative, resolve } from "../common/index";
import { toBunestErrorReport } from "./error-catalog";

export type PipelineTraceStage =
  | "routing"
  | "security"
  | "middleware"
  | "guard"
  | "interceptor"
  | "param"
  | "pipe"
  | "handler"
  | "serialization"
  | "filter"
  | "unknown";

export interface AgentStackFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly fn?: string;
}

export interface AgentErrorTrace {
  readonly id: string;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly stage: PipelineTraceStage;
  readonly controller?: string;
  readonly handler?: string;
  readonly code?: string;
  readonly name: string;
  readonly message: string;
  readonly details?: unknown;
  readonly fixes?: readonly string[];
  readonly docs?: string;
  readonly appFrames: readonly AgentStackFrame[];
}

export interface BuildAgentErrorTraceInput {
  readonly id?: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly stage?: PipelineTraceStage;
  readonly controller?: string;
  readonly handler?: string;
  readonly error: unknown;
  readonly cwd?: string;
}

export interface AgentTraceStoreOptions {
  /** Maximum number of traces kept in memory (default: 50). */
  readonly maxEntries?: number;
  /** Optional JSONL file path (e.g. `.bunest/errors.jsonl`) for cross-process agent reads. */
  readonly filePath?: string;
  /** Base working directory used to shorten stack frame paths (default: `process.cwd()`). */
  readonly cwd?: string;
}

const INTERNAL_FRAME_PATTERNS = [
  /^bun:/,
  /^node:/,
  /^native:/,
  /(?:^|\/)node_modules\//,
  /packages\/core\/src\/http\/pipeline\//,
  /packages\/core\/src\/http\/adapter\//,
  /packages\/core\/src\/di\//,
  /packages\/core\/src\/errors\/agent-trace\.ts$/,
];

const STACK_FRAME_WITH_FN_RE = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;
const STACK_FRAME_BARE_RE = /^\s*at\s+(.+?):(\d+):(\d+)\s*$/;

function normalizeFrameFile(rawFile: string, cwd: string): string {
  const cleaned = rawFile.startsWith("file://")
    ? rawFile.slice("file://".length)
    : rawFile;
  if (
    cleaned.startsWith("bun:") ||
    cleaned.startsWith("node:") ||
    cleaned.startsWith("native:")
  ) {
    return cleaned;
  }
  const abs = resolve(cwd, cleaned);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? cleaned.replace(/\\/g, "/") : rel;
}

function isInternalFrame(normalizedFile: string): boolean {
  for (let i = 0; i < INTERNAL_FRAME_PATTERNS.length; i++) {
    if (INTERNAL_FRAME_PATTERNS[i]!.test(normalizedFile)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts user-application stack frames (`file:line:col`) from an error stack,
 * filtering out Bun runtime, `node_modules`, and internal HTTP pipeline frames.
 */
export function extractAppStackFrames(
  stack: string | undefined,
  cwd = process.cwd(),
  maxFrames = 8,
): AgentStackFrame[] {
  if (!stack) return [];
  const lines = stack.split(/\r?\n/);
  const frames: AgentStackFrame[] = [];

  for (let i = 0; i < lines.length && frames.length < maxFrames; i++) {
    const line = lines[i];
    if (!line) continue;

    let fn: string | undefined;
    let rawFile: string | undefined;
    let lineNum = 0;
    let colNum = 0;

    const withFn = STACK_FRAME_WITH_FN_RE.exec(line);
    if (withFn) {
      fn = withFn[1]?.trim();
      rawFile = withFn[2]?.trim();
      lineNum = Number(withFn[3]);
      colNum = Number(withFn[4]);
    } else {
      const bare = STACK_FRAME_BARE_RE.exec(line);
      if (bare) {
        rawFile = bare[1]?.trim();
        lineNum = Number(bare[2]);
        colNum = Number(bare[3]);
      }
    }

    if (!rawFile || !Number.isFinite(lineNum) || lineNum <= 0) continue;
    const file = normalizeFrameFile(rawFile, cwd);
    if (isInternalFrame(file)) continue;

    frames.push({
      file,
      line: lineNum,
      column: Number.isFinite(colNum) ? colNum : 0,
      ...(fn ? { fn } : {}),
    });
  }

  return frames;
}

export function generateTraceRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function extractExceptionDetails(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const maybeGetResponse = (error as { getResponse?: unknown }).getResponse;
  if (typeof maybeGetResponse === "function") {
    const resp = (error as { getResponse: () => unknown }).getResponse();
    if (resp && typeof resp === "object") {
      const obj = resp as Record<string, unknown>;
      if ("details" in obj && obj.details !== undefined) {
        return obj.details;
      }
      if ("errors" in obj && obj.errors !== undefined) {
        return obj.errors;
      }
    }
  }
  if ("details" in error && (error as { details?: unknown }).details !== undefined) {
    return (error as { details?: unknown }).details;
  }
  return undefined;
}

export function buildAgentErrorTrace(
  input: BuildAgentErrorTraceInput,
): AgentErrorTrace {
  const err = input.error;
  const catalogReport = toBunestErrorReport(err);
  const name =
    catalogReport?.name ??
    (err instanceof Error ? err.name : typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "Error");
  const message =
    catalogReport?.message ??
    (err instanceof Error ? err.message : String(err));
  const stack = err instanceof Error ? err.stack : undefined;
  const details =
    catalogReport && Object.keys(catalogReport.details).length > 0
      ? catalogReport.details
      : extractExceptionDetails(err);

  return {
    id: input.id ?? generateTraceRequestId(),
    timestamp: new Date().toISOString(),
    method: input.method.toUpperCase(),
    path: input.path,
    statusCode: input.statusCode,
    stage: input.stage ?? "unknown",
    ...(input.controller ? { controller: input.controller } : {}),
    ...(input.handler ? { handler: input.handler } : {}),
    ...(catalogReport?.code ? { code: catalogReport.code } : {}),
    name,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(catalogReport?.fixes ? { fixes: catalogReport.fixes } : {}),
    ...(catalogReport?.docs ? { docs: catalogReport.docs } : {}),
    appFrames: extractAppStackFrames(stack, input.cwd),
  };
}

/**
 * Formats a single `AgentErrorTrace` into a compact, token-efficient block for AI agents.
 */
export function formatAgentErrorTrace(trace: AgentErrorTrace): string {
  const target =
    trace.controller && trace.handler
      ? `, ${trace.controller}.${trace.handler}`
      : trace.controller
        ? `, ${trace.controller}`
        : "";
  const codePrefix = trace.code ? `[${trace.code}] ` : "";
  const lines = [
    `[${trace.id}] ${trace.statusCode} ${trace.method} ${trace.path} (stage=${trace.stage}${target})`,
    `  ${codePrefix}${trace.name}: ${trace.message}`,
  ];
  for (const frame of trace.appFrames.slice(0, 4)) {
    const fnPart = frame.fn ? ` (${frame.fn})` : "";
    lines.push(`  at ${frame.file}:${frame.line}:${frame.column}${fnPart}`);
  }
  if (trace.details !== undefined) {
    lines.push(`  details: ${JSON.stringify(trace.details)}`);
  }
  if (trace.fixes && trace.fixes.length > 0) {
    trace.fixes.forEach((fix, idx) => {
      lines.push(`  fix ${idx + 1}: ${fix}`);
    });
  }
  if (trace.docs) {
    lines.push(`  docs: ${trace.docs}`);
  }
  return lines.join("\n");
}

/**
 * Ring-buffer store for runtime error traces, with optional JSONL persistence
 * (e.g. `.bunest/errors.jsonl`) so external AI agents and `bunest mcp` can
 * inspect recent runtime failures without scraping terminal logs.
 */
export class AgentErrorTraceStore {
  private readonly maxEntries: number;
  private readonly filePath?: string;
  public readonly cwd: string;
  private readonly entries: AgentErrorTrace[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AgentTraceStoreOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 50);
    this.filePath = options.filePath;
    this.cwd = options.cwd ?? process.cwd();
  }

  record(trace: AgentErrorTrace): void {
    this.entries.push(trace);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    if (this.filePath) {
      const targetPath = this.filePath;
      const snapshot = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      this.writeChain = this.writeChain
        .then(async () => {
          await ensureDir(dirname(targetPath), { recursive: true });
          await Bun.write(targetPath, snapshot);
        })
        .catch(() => {
          // Never fail a request if trace persistence encounters an IO error
        });
    }
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  list(limit = 20): readonly AgentErrorTrace[] {
    const n = Math.max(1, limit);
    return this.entries.slice(-n).reverse();
  }

  getById(id: string): AgentErrorTrace | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]?.id === id) return this.entries[i];
    }
    return undefined;
  }

  clear(): void {
    this.entries.length = 0;
  }

  formatForAgent(limit = 10): string {
    const items = this.list(limit);
    if (items.length === 0) return "No runtime error traces recorded.";
    return items.map(formatAgentErrorTrace).join("\n\n");
  }
}

/**
 * Reads the most recent `AgentErrorTrace` entries from a JSONL file (e.g. `.bunest/errors.jsonl`).
 */
export async function readAgentErrorTracesFromFile(
  filePath: string,
  limit = 20,
): Promise<AgentErrorTrace[]> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return [];
  }
  const text = await file.text();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed: AgentErrorTrace[] = [];
  for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
    try {
      parsed.push(JSON.parse(lines[i]!) as AgentErrorTrace);
    } catch {
      // Skip malformed JSONL lines
    }
  }
  return parsed.reverse();
}
