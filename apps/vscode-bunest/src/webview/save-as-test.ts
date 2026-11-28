import { isObject, isString, truncate } from "@bunest/core/common";
import {
  dirname,
  existsSyncPath,
  readTextSync,
  relative,
  resolve,
} from "@bunest/core";
import * as vscode from "vscode";
import {
  planTestFromRequest,
  type ExtractedRouteEntry,
  type PlanTestFromRequestOptions,
  type RequestScenarioRouteMeta,
  type RequestScenarioV1,
  type TestFromRequestPlan,
} from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

const BINARY_OR_STREAM_PATTERNS: readonly RegExp[] = [
  /^application\/octet-stream\b/i,
  /^image\//i,
  /^audio\//i,
  /^video\//i,
  /^application\/pdf\b/i,
  /^text\/event-stream\b/i,
  /^multipart\//i,
];

const VOLATILE_FIELD_NAMES = new Set([
  "id",
  "uuid",
  "ulid",
  "createdat",
  "updatedat",
  "deletedat",
  "timestamp",
  "expiresat",
  "requestid",
  "traceid",
  "correlationid",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const JWT_RE =
  /^(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;

export const BUNEST_PREVIEW_SCHEME = "bunest-preview";

/**
 * Detects binary or streaming HTTP `Content-Type` values so HTTP Studio does not
 * blindly decode or inline raw bytes as text.
 */
export function isBinaryOrStreamContentType(contentType?: string): boolean {
  if (!contentType) return false;
  const trimmed = contentType.trim();
  return BINARY_OR_STREAM_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export interface CandidateResponseField {
  readonly path: string;
  readonly valuePreview: string;
  readonly isVolatile: boolean;
}

function isVolatileKeyOrValue(key: string, value: unknown): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (VOLATILE_FIELD_NAMES.has(normalized)) return true;
  if (typeof value === "string") {
    if (
      UUID_RE.test(value) ||
      ULID_RE.test(value) ||
      ISO_8601_RE.test(value) ||
      JWT_RE.test(value)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts selectable JSON response field paths for the "Save as Test" field picker,
 * flagging volatile fields (IDs, timestamps, tokens) so stable fields can be pre-selected.
 */
export function extractCandidateResponseFields(
  body: unknown,
  maxDepth = 3,
): CandidateResponseField[] {
  const results: CandidateResponseField[] = [];

  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (depth > maxDepth || !isObject(value)) {
      return;
    }
    for (const [key, val] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const isNestedObj = isObject(val);
      if (isNestedObj && depth < maxDepth) {
        visit(val, path, depth + 1);
      } else {
        const preview = isString(val)
          ? JSON.stringify(truncate(val, 40, "..."))
          : JSON.stringify(val);
        results.push({
          path,
          valuePreview: preview ?? String(val),
          isVolatile: isVolatileKeyOrValue(key, val),
        });
      }
    }
  };

  visit(body, "", 0);
  return results;
}

export interface HttpStudioExchange {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly status: number;
  readonly responseContentType?: string;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseJsonBody?: unknown;
  readonly responseRawBody?: string | Uint8Array;
  readonly isBinaryOrStream: boolean;
  readonly sizeBytes: number;
  readonly route?: ExtractedRouteEntry;
}

/**
 * Detects whether the controller or any related DTO/TypeScript source buffer is
 * currently dirty (unsaved) in VS Code.
 */
export function detectUnsavedRouteBuffers(
  routeFilePath?: string,
  extraFilePaths: readonly string[] = [],
  documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments ??
    [],
): boolean {
  const watched = new Set<string>();
  if (routeFilePath) watched.add(resolve(routeFilePath));
  for (const fp of extraFilePaths) {
    if (fp) watched.add(resolve(fp));
  }

  for (const doc of documents) {
    if (!doc.isDirty || doc.uri?.scheme !== "file" || !doc.uri.fsPath) {
      continue;
    }
    const abs = resolve(doc.uri.fsPath);
    if (watched.has(abs)) return true;
    // Also flag if a DTO file in the same controller directory is unsaved
    if (
      routeFilePath &&
      dirname(abs) === dirname(resolve(routeFilePath)) &&
      (abs.endsWith(".ts") || abs.endsWith(".tsx"))
    ) {
      return true;
    }
  }
  return false;
}

function parseUrlPathAndQuery(rawUrl: string): {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
} {
  try {
    const parsed = new URL(rawUrl);
    const queryEntries: Record<string, string | string[]> = {};
    let hasQuery = false;
    for (const [k, v] of parsed.searchParams.entries()) {
      hasQuery = true;
      const existing = queryEntries[k];
      if (existing === undefined) {
        queryEntries[k] = v;
      } else if (Array.isArray(existing)) {
        existing.push(v);
      } else {
        queryEntries[k] = [existing, v];
      }
    }
    return {
      path: parsed.pathname || "/",
      query: hasQuery ? queryEntries : undefined,
    };
  } catch {
    const [pathPart, qsPart] = rawUrl.split("?");
    const path = pathPart && pathPart.startsWith("/") ? pathPart : `/${pathPart ?? ""}`;
    if (!qsPart) return { path };
    const params = new URLSearchParams(qsPart);
    const queryEntries: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      queryEntries[k] = v;
    }
    return {
      path,
      query: Object.keys(queryEntries).length > 0 ? queryEntries : undefined,
    };
  }
}

/**
 * Resolves module metadata for a route from the workspace index (if available).
 */
export function resolveRouteModuleMeta(
  index: BunestWorkspaceIndex | undefined,
  route: ExtractedRouteEntry | undefined,
  cwd: string | undefined,
  unsavedBuffer: boolean,
): RequestScenarioRouteMeta | undefined {
  if (!route && !unsavedBuffer) return undefined;
  let moduleName: string | undefined;
  let moduleImportPath: string | undefined;

  if (index && route) {
    const ctx = route.location?.filePath
      ? index.getContextForFile(route.location.filePath)
      : index.getAllContexts()[0];
    const graph = ctx?.snapshot?.moduleGraph;
    if (graph) {
      const ownerMod = graph.modules.find((m) =>
        m.controllers.includes(route.controllerName),
      );
      if (ownerMod) {
        moduleName = ownerMod.name;
        if (cwd && ownerMod.sourceFile) {
          const relFromTest = relative(
            resolve(cwd, "test"),
            ownerMod.sourceFile,
          )
            .replace(/\\/g, "/")
            .replace(/\.tsx?$/, "");
          moduleImportPath = relFromTest.startsWith(".")
            ? relFromTest
            : `./${relFromTest}`;
        }
      }
    }
  }

  return {
    module: moduleName,
    moduleImportPath,
    controller: route?.controllerName,
    handler: route?.handlerName,
    sourceFile: route?.location?.filePath,
    unsavedBuffer,
  };
}

/**
 * Builds a `RequestScenarioV1` (`schemaVersion: 1`) from an HTTP Studio exchange.
 */
export function buildScenarioFromHttpExchange(
  exchange: HttpStudioExchange,
  options?: {
    readonly index?: BunestWorkspaceIndex;
    readonly cwd?: string;
    readonly allowFields?: readonly string[];
    readonly documents?: readonly vscode.TextDocument[];
    readonly extraWatchedFiles?: readonly string[];
  },
): RequestScenarioV1 {
  const { path, query } = parseUrlPathAndQuery(exchange.url);

  let parsedReqBody: unknown = undefined;
  if (exchange.requestBody !== undefined && exchange.requestBody.trim().length > 0) {
    try {
      parsedReqBody = JSON.parse(exchange.requestBody);
    } catch {
      parsedReqBody = exchange.requestBody;
    }
  }

  const reqContentType =
    exchange.requestHeaders["Content-Type"] ??
    exchange.requestHeaders["content-type"];

  const unsavedBuffer = detectUnsavedRouteBuffers(
    exchange.route?.location?.filePath,
    options?.extraWatchedFiles,
    options?.documents,
  );

  const routeMeta = resolveRouteModuleMeta(
    options?.index,
    exchange.route,
    options?.cwd,
    unsavedBuffer,
  );

  return {
    schemaVersion: 1,
    name: exchange.route
      ? `${exchange.method} ${path} (${exchange.route.controllerName}.${exchange.route.handlerName})`
      : `${exchange.method} ${path}`,
    method: exchange.method,
    path,
    query,
    headers:
      Object.keys(exchange.requestHeaders).length > 0
        ? exchange.requestHeaders
        : undefined,
    body: parsedReqBody,
    contentType: reqContentType,
    routeMeta,
    observedResponse: {
      status: exchange.status,
      contentType: exchange.responseContentType,
      headers:
        Object.keys(exchange.responseHeaders).length > 0
          ? exchange.responseHeaders
          : undefined,
      body: exchange.isBinaryOrStream ? undefined : exchange.responseJsonBody,
      rawBody: exchange.responseRawBody,
      isBinaryOrStream: exchange.isBinaryOrStream,
      sizeBytes: exchange.sizeBytes,
    },
    assertions: {
      status: exchange.status,
      allowFields: options?.allowFields,
    },
  };
}

/**
 * Plans a regression test from an HTTP Studio exchange using `@bunest/cli`'s single
 * `planTestFromRequest()` engine (zero duplicated test templates in VS Code).
 */
export function planHttpExchangeAsTest(
  exchange: HttpStudioExchange,
  options?: {
    readonly index?: BunestWorkspaceIndex;
    readonly cwd?: string;
    readonly assertFields?: readonly string[];
    readonly saveBinaryFixture?: boolean;
    readonly out?: string;
    readonly documents?: readonly vscode.TextDocument[];
    readonly extraWatchedFiles?: readonly string[];
    readonly existingContents?: Readonly<Record<string, string>>;
  },
): {
  readonly scenario: RequestScenarioV1;
  readonly plan: TestFromRequestPlan;
} {
  const scenario = buildScenarioFromHttpExchange(exchange, {
    index: options?.index,
    cwd: options?.cwd,
    allowFields: options?.assertFields,
    documents: options?.documents,
    extraWatchedFiles: options?.extraWatchedFiles,
  });

  const planOpts: PlanTestFromRequestOptions = {
    out: options?.out,
    assertFields: options?.assertFields,
    saveBinaryFixture: options?.saveBinaryFixture,
    moduleName: scenario.routeMeta?.module,
    moduleImportPath: scenario.routeMeta?.moduleImportPath,
    existingContents: options?.existingContents,
  };

  const plan = planTestFromRequest(scenario, planOpts);
  return { scenario, plan };
}

/**
 * Converts planned files from `planTestFromRequest()` into a single atomic
 * `vscode.WorkspaceEdit` so applying it supports native VS Code Undo.
 */
export function buildPlannedFilesWorkspaceEdit(
  cwd: string,
  plan: TestFromRequestPlan,
): vscode.WorkspaceEdit {
  const wsEdit = new vscode.WorkspaceEdit();
  for (const file of plan.files) {
    const absPath = resolve(cwd, file.relativePath);
    const uri = vscode.Uri.file(absPath);
    const exists = existsSyncPath(absPath);
    if (!exists && typeof wsEdit.createFile === "function") {
      wsEdit.createFile(uri, { overwrite: true, ignoreIfExists: false });
      wsEdit.insert(uri, new vscode.Position(0, 0), file.content);
    } else if (exists) {
      wsEdit.replace(
        uri,
        new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0),
        file.content,
      );
    } else {
      wsEdit.insert(uri, new vscode.Position(0, 0), file.content);
    }
  }
  return wsEdit;
}

/**
 * Reads existing file contents on disk for any planned file paths so `vscode.diff`
 * and `planTestFromRequest` diffs accurately compare against existing files.
 */
export function readExistingFileMap(
  cwd: string,
  relativePaths: readonly string[],
): Record<string, string> {
  const existing: Record<string, string> = {};
  for (const rel of relativePaths) {
    const abs = resolve(cwd, rel);
    if (existsSyncPath(abs)) {
      try {
        existing[rel] = readTextSync(abs);
      } catch {
        // ignore unreadable files
      }
    }
  }
  return existing;
}

/**
 * In-memory virtual document provider for `bunest-preview:` URIs used by `vscode.diff`
 * to preview generated regression tests before applying via `WorkspaceEdit`.
 */
export class BunestPreviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly contents = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.contents.clear();
    this.onDidChangeEmitter.dispose();
  }
}

export const bunestPreviewProvider = new BunestPreviewContentProvider();
