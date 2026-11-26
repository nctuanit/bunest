import { basename, resolve, statPath } from "@bunest/core";
import type { CliIO, GeneratedFile } from "../types";
import { writePlannedFiles, type PlannedFile } from "../utils/fs-writer";
import { toKebabCase } from "../utils/naming";

/**
 * Versioned request scenario schema (`schemaVersion: 1`) shared between
 * CLI `bunest test-from-request`, `.http` sample files, and VS Code HTTP Studio.
 */
export interface RequestScenarioRouteMeta {
  readonly module?: string;
  readonly moduleImportPath?: string;
  readonly controller?: string;
  readonly handler?: string;
  readonly sourceFile?: string;
  readonly unsavedBuffer?: boolean;
}

export interface RequestScenarioObservedResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly rawBody?: string | Uint8Array;
  readonly isBinaryOrStream?: boolean;
  readonly sizeBytes?: number;
}

export interface RequestScenarioAssertions {
  readonly status: number;
  readonly allowFields?: readonly string[];
  readonly headers?: readonly string[];
}

export interface RequestScenarioCase {
  readonly name?: string;
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly observedResponse?: RequestScenarioObservedResponse;
  readonly assertions?: RequestScenarioAssertions;
}

export interface RequestScenarioV1 {
  readonly schemaVersion: 1;
  readonly name?: string;
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly routeMeta?: RequestScenarioRouteMeta;
  readonly observedResponse?: RequestScenarioObservedResponse;
  readonly assertions?: RequestScenarioAssertions;
  readonly overrides?: readonly string[];
  readonly cases?: readonly RequestScenarioCase[];
}

export interface SanitizedEntry {
  readonly location:
    | "request.header"
    | "request.body"
    | "response.header"
    | "response.body";
  readonly path: string;
  readonly reason: string;
  readonly replacement: string;
}

export interface BinaryFixtureSuggestion {
  readonly suggestedPath: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface FileDiffPreview {
  readonly relativePath: string;
  readonly action: "create" | "overwrite";
  readonly unifiedDiff: string;
}

export interface FixtureConstantDef {
  readonly name: string;
  readonly defaultValue: string;
}

export interface ResponseFieldAssertionPlan {
  readonly path: string;
  readonly kind: "exact" | "shape" | "defined";
  readonly expectedValue?: unknown;
  readonly expectedType?: "string" | "number" | "boolean" | "object";
  readonly reason?: string;
}

export interface SanitizedCasePlan {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly expectedStatus: number;
  readonly headerAssertions: readonly {
    readonly name: string;
    readonly value?: string;
  }[];
  readonly fieldAssertions: readonly ResponseFieldAssertionPlan[];
  readonly isBinaryOrStream: boolean;
  readonly binaryContentType?: string;
  readonly binaryFixtureSuggestion?: BinaryFixtureSuggestion;
  readonly rawBinaryContent?: string;
}

export interface SanitizedScenarioResult {
  readonly scenario: RequestScenarioV1;
  readonly cases: readonly SanitizedCasePlan[];
  readonly sanitized: readonly SanitizedEntry[];
  readonly fixtures: readonly FixtureConstantDef[];
  readonly binaryFixtureSuggestion?: BinaryFixtureSuggestion;
  readonly warnings: readonly string[];
}

export interface PlanTestFromRequestOptions {
  readonly out?: string;
  readonly assertFields?: readonly string[];
  readonly saveBinaryFixture?: boolean;
  readonly moduleName?: string;
  readonly moduleImportPath?: string;
  readonly overrides?: readonly string[];
  readonly useValidationPipe?: boolean;
  readonly existingContents?: Readonly<Record<string, string>>;
}

export interface TestFromRequestPlan {
  readonly schemaVersion: "1.0";
  readonly files: readonly PlannedFile[];
  readonly diffs: readonly FileDiffPreview[];
  readonly sanitized: readonly SanitizedEntry[];
  readonly binaryFixtureSuggestion?: BinaryFixtureSuggestion;
  readonly warnings: readonly string[];
}

export type TestFromRequestOutputFormat = "pretty" | "diff" | "json";

export interface TestFromRequestCommandOptions
  extends PlanTestFromRequestOptions {
  readonly scenario?: RequestScenarioV1 | readonly RequestScenarioV1[];
  readonly inputPath?: string;
  readonly rawInput?: string;
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly format?: TestFromRequestOutputFormat;
}

export interface TestFromRequestCommandResult {
  readonly exitCode: number;
  readonly dryRun: boolean;
  readonly plan: TestFromRequestPlan;
  readonly files: readonly GeneratedFile[];
  readonly formattedOutput: string;
}

// ---------------------------------------------------------------------------
// Sanitization & Detection Constants
// ---------------------------------------------------------------------------

const FIXTURE_REF_PREFIX = "__BUNEST_FIXTURE_REF__:";
const FIXTURE_REF_SUFFIX = "__";

const FIXTURE_DEFAULTS: Readonly<Record<string, string>> = {
  FIXTURE_AUTH_TOKEN: "test-auth-token-fixture",
  FIXTURE_PROXY_AUTH_TOKEN: "test-proxy-auth-token-fixture",
  FIXTURE_API_KEY: "test-api-key-fixture",
  FIXTURE_COOKIE: "session=test-cookie-fixture",
  FIXTURE_SET_COOKIE: "session=test-set-cookie-fixture",
  FIXTURE_PASSWORD: "test-password-fixture",
  FIXTURE_SECRET: "test-secret-fixture",
  FIXTURE_ACCESS_TOKEN: "test-access-token-fixture",
  FIXTURE_REFRESH_TOKEN: "test-refresh-token-fixture",
  FIXTURE_PRIVATE_KEY: "test-private-key-fixture",
  FIXTURE_JWT_TOKEN: "test-jwt-token-fixture",
  FIXTURE_TOKEN: "test-token-fixture",
  FIXTURE_REDACTED_HEADER: "test-redacted-header-fixture",
};

const SENSITIVE_HEADER_FIXTURES: Readonly<Record<string, string>> = {
  authorization: "FIXTURE_AUTH_TOKEN",
  "proxy-authorization": "FIXTURE_PROXY_AUTH_TOKEN",
  cookie: "FIXTURE_COOKIE",
  "set-cookie": "FIXTURE_SET_COOKIE",
  "x-api-key": "FIXTURE_API_KEY",
  "x-auth-token": "FIXTURE_AUTH_TOKEN",
};

const SENSITIVE_HEADER_NAME_PATTERN =
  /token|secret|password|auth|api[-_]?key|cookie|session/i;

const SENSITIVE_BODY_KEY_FIXTURES: Readonly<Record<string, string>> = {
  password: "FIXTURE_PASSWORD",
  passwd: "FIXTURE_PASSWORD",
  passphrase: "FIXTURE_PASSWORD",
  secret: "FIXTURE_SECRET",
  clientsecret: "FIXTURE_SECRET",
  webhooksecret: "FIXTURE_SECRET",
  signingsecret: "FIXTURE_SECRET",
  token: "FIXTURE_TOKEN",
  accesstoken: "FIXTURE_ACCESS_TOKEN",
  refreshtoken: "FIXTURE_REFRESH_TOKEN",
  idtoken: "FIXTURE_TOKEN",
  authtoken: "FIXTURE_AUTH_TOKEN",
  apikey: "FIXTURE_API_KEY",
  privatekey: "FIXTURE_PRIVATE_KEY",
  secretkey: "FIXTURE_SECRET",
  authorization: "FIXTURE_AUTH_TOKEN",
  cookie: "FIXTURE_COOKIE",
  sessionid: "FIXTURE_TOKEN",
};

const JWT_STRING_REGEX =
  /^(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const VOLATILE_FIELD_NAMES = new Set([
  "id",
  "uuid",
  "ulid",
  "createdat",
  "updatedat",
  "deletedat",
  "timestamp",
  "expiresat",
  "issuedat",
  "iat",
  "exp",
  "nonce",
  "requestid",
  "traceid",
  "correlationid",
]);

const BINARY_CONTENT_TYPE_PATTERNS: readonly RegExp[] = [
  /^application\/octet-stream\b/i,
  /^image\//i,
  /^audio\//i,
  /^video\//i,
  /^application\/pdf\b/i,
  /^text\/event-stream\b/i,
  /^multipart\//i,
];

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/octet-stream": "bin",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/event-stream": "sse.txt",
  "multipart/form-data": "multipart.txt",
};

const HTTP_REQUEST_LINE_REGEX =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeFixtureRef(name: string, prefix = ""): string {
  return `${prefix}${FIXTURE_REF_PREFIX}${name}${FIXTURE_REF_SUFFIX}`;
}

function getFileExtension(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  return dot > slash ? filePath.slice(dot).toLowerCase() : "";
}

function stripExtension(fileName: string): string {
  const dot = fileName.indexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function isBinaryOrStreamContentType(contentType?: string): boolean {
  if (!contentType) return false;
  const trimmed = contentType.trim();
  return BINARY_CONTENT_TYPE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function extensionForContentType(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return CONTENT_TYPE_EXTENSIONS[mime] ?? "bin";
}

function detectSensitiveBodyFixture(key: string): string | undefined {
  const normalized = normalizeKey(key);
  if (SENSITIVE_BODY_KEY_FIXTURES[normalized]) {
    return SENSITIVE_BODY_KEY_FIXTURES[normalized];
  }
  if (normalized.endsWith("password") || normalized.endsWith("passwd")) {
    return "FIXTURE_PASSWORD";
  }
  if (normalized.endsWith("secret")) {
    return "FIXTURE_SECRET";
  }
  if (normalized.endsWith("apikey")) {
    return "FIXTURE_API_KEY";
  }
  if (normalized.endsWith("privatekey")) {
    return "FIXTURE_PRIVATE_KEY";
  }
  if (normalized.endsWith("token")) {
    return "FIXTURE_TOKEN";
  }
  return undefined;
}

function detectVolatileReason(key: string, value: unknown): string | undefined {
  const normalizedKey = normalizeKey(key);
  if (typeof value === "string") {
    if (UUID_REGEX.test(value)) return "volatile UUID";
    if (ULID_REGEX.test(value)) return "volatile ULID";
    if (ISO_8601_REGEX.test(value)) return "volatile ISO-8601 timestamp";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1_000_000_000_000 && value <= 9_999_999_999_999) {
      return "volatile epoch-ms timestamp";
    }
  }
  if (VOLATILE_FIELD_NAMES.has(normalizedKey)) {
    return `volatile field "${key}"`;
  }
  return undefined;
}

function getValueAtPath(
  root: unknown,
  dotPath: string,
): { found: boolean; value: unknown } {
  const parts = dotPath.split(".").filter((p) => p.length > 0);
  let current: unknown = root;
  for (const part of parts) {
    if (!isPlainObject(current) || !(part in current)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function formatPropertyAccess(rootVar: string, dotPath: string): string {
  const parts = dotPath.split(".").filter((p) => p.length > 0);
  let expr = rootVar;
  for (const part of parts) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
      expr += `.${part}`;
    } else {
      expr += `[${JSON.stringify(part)}]`;
    }
  }
  return expr;
}

function deriveSlug(scenario: RequestScenarioV1): string {
  if (scenario.name && scenario.name.trim().length > 0) {
    const slug = toKebabCase(scenario.name);
    if (slug.length > 0) return slug;
  }
  if (scenario.routeMeta?.sourceFile) {
    const base = stripExtension(basename(scenario.routeMeta.sourceFile));
    const slug = toKebabCase(base);
    if (slug.length > 0) return slug;
  }
  const pathPart = scenario.path
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-");
  const combined = toKebabCase(`${scenario.method}-${pathPart || "root"}`);
  return combined || "request";
}

// ---------------------------------------------------------------------------
// .http File Parser
// ---------------------------------------------------------------------------

function substituteHttpVariables(
  text: string,
  variables: ReadonlyMap<string, string>,
): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) => {
    const val = variables.get(name);
    return val !== undefined ? val : match;
  });
}

function inferStatusFromTitleAndComments(
  method: string,
  title: string,
  comments: readonly string[],
): number {
  const combinedComments = comments.join("\n");

  const explicitExpect =
    /@expect\s+status\s+(\d{3})\b/i.exec(combinedComments) ??
    /expect(?:ed)?\s*(?:status)?\s*[:=]\s*(\d{3})\b/i.exec(combinedComments);
  if (explicitExpect) {
    const code = Number(explicitExpect[1]);
    if (code >= 100 && code <= 599) return code;
  }

  const parenthesized = /\((\d{3})\)/.exec(title);
  if (parenthesized) {
    const code = Number(parenthesized[1]);
    if (code >= 100 && code <= 599) return code;
  }

  const standaloneStatus = /\b([1-5]\d{2})\b/.exec(title);
  if (standaloneStatus) {
    const code = Number(standaloneStatus[1]);
    if (code >= 100 && code <= 599) return code;
  }

  const lowerTitle = title.toLowerCase();
  if (
    lowerTitle.includes("invalid") ||
    lowerTitle.includes("validation") ||
    lowerTitle.includes("bad request") ||
    lowerTitle.includes("fail") ||
    lowerTitle.includes("error")
  ) {
    return 400;
  }

  return method.toUpperCase() === "POST" ? 201 : 200;
}

function parseUrlPathAndQuery(rawUrl: string): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  let pathWithQuery = rawUrl.trim();
  try {
    const parsed = /^https?:\/\//i.test(pathWithQuery)
      ? new URL(pathWithQuery)
      : new URL(
          pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`,
          "http://bunest.local",
        );
    const query: Record<string, string | string[]> = {};
    let hasQuery = false;
    for (const [key, value] of parsed.searchParams.entries()) {
      hasQuery = true;
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    }
    return {
      path: parsed.pathname || "/",
      query: hasQuery ? query : undefined,
    };
  } catch {
    const qIdx = pathWithQuery.indexOf("?");
    if (qIdx === -1) {
      return {
        path: pathWithQuery.startsWith("/")
          ? pathWithQuery
          : `/${pathWithQuery}`,
      };
    }
    return {
      path: pathWithQuery.slice(0, qIdx) || "/",
    };
  }
}

/**
 * Parses a `.http` / `.rest` sample request file (with `###` separators,
 * `@var = value` variables, headers, JSON/text bodies, and status hints)
 * into one or more versioned `RequestScenarioV1` records.
 */
export function parseHttpFileToScenarios(
  httpText: string,
  sourcePath?: string,
): RequestScenarioV1[] {
  const lines = httpText.replace(/\r\n/g, "\n").split("\n");
  const variables = new Map<string, string>();

  // First pass: collect top-level @var = value declarations
  for (const line of lines) {
    const varMatch = /^@([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line.trim());
    if (varMatch) {
      variables.set(varMatch[1]!, varMatch[2]!.trim());
    }
  }

  interface RawSection {
    title: string;
    lines: string[];
  }

  const sections: RawSection[] = [];
  let current: RawSection = { title: "", lines: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("###")) {
      if (current.lines.some((l) => l.trim().length > 0)) {
        sections.push(current);
      }
      current = {
        title: trimmed.replace(/^###+\s*/, "").trim(),
        lines: [],
      };
      continue;
    }
    if (/^@[A-Za-z0-9_.-]+\s*=/.test(trimmed)) {
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim().length > 0)) {
    sections.push(current);
  }

  const scenarios: RequestScenarioV1[] = [];

  for (const section of sections) {
    const comments: string[] = [];
    let requestLineIdx = -1;
    let method = "";
    let rawUrl = "";

    for (let i = 0; i < section.lines.length; i++) {
      const trimmed = section.lines[i]!.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
        comments.push(trimmed);
        continue;
      }
      const expanded = substituteHttpVariables(trimmed, variables);
      const reqMatch = HTTP_REQUEST_LINE_REGEX.exec(expanded);
      if (reqMatch) {
        requestLineIdx = i;
        method = reqMatch[1]!.toUpperCase();
        rawUrl = reqMatch[2]!;
        break;
      }
    }

    if (requestLineIdx === -1) continue;

    const headers: Record<string, string> = {};
    let bodyStartIdx = section.lines.length;

    for (let i = requestLineIdx + 1; i < section.lines.length; i++) {
      const line = section.lines[i]!;
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        bodyStartIdx = i + 1;
        break;
      }
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
        comments.push(trimmed);
        continue;
      }
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const headerName = line.slice(0, colonIdx).trim();
        const headerValue = substituteHttpVariables(
          line.slice(colonIdx + 1).trim(),
          variables,
        );
        headers[headerName] = headerValue;
      }
    }

    const rawBodyLines = section.lines.slice(bodyStartIdx);
    const rawBodyText = substituteHttpVariables(
      rawBodyLines.join("\n").trim(),
      variables,
    );

    const contentTypeHeader = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];

    let parsedBody: unknown;
    if (rawBodyText.length > 0) {
      const looksJson =
        (contentTypeHeader?.toLowerCase().includes("json") ?? false) ||
        rawBodyText.startsWith("{") ||
        rawBodyText.startsWith("[");
      if (looksJson) {
        try {
          parsedBody = JSON.parse(rawBodyText);
        } catch {
          parsedBody = rawBodyText;
        }
      } else {
        parsedBody = rawBodyText;
      }
    }

    const { path, query } = parseUrlPathAndQuery(rawUrl);
    const expectedStatus = inferStatusFromTitleAndComments(
      method,
      section.title,
      comments,
    );

    // Optional metadata annotations in comments
    const commentBlock = comments.join("\n");
    const moduleName = /@module\s+([A-Za-z_$][A-Za-z0-9_$]*)/i.exec(
      commentBlock,
    )?.[1];
    const moduleImportPath = /@moduleImport\s+(\S+)/i.exec(commentBlock)?.[1];
    const allowFieldsRaw = /@allowFields\s+([^\n]+)/i.exec(commentBlock)?.[1];
    const allowFields = allowFieldsRaw
      ? allowFieldsRaw
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
      : undefined;
    const overrides: string[] = [];
    for (const match of commentBlock.matchAll(/@override\s+(\S+)/gi)) {
      if (match[1]) overrides.push(match[1]);
    }

    const routeMeta: RequestScenarioRouteMeta | undefined =
      sourcePath || moduleName || moduleImportPath
        ? {
            sourceFile: sourcePath,
            module: moduleName,
            moduleImportPath,
          }
        : undefined;

    scenarios.push({
      schemaVersion: 1,
      name: section.title || `${method} ${path} (${expectedStatus})`,
      method,
      path,
      query,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: parsedBody,
      contentType: contentTypeHeader,
      routeMeta,
      assertions: {
        status: expectedStatus,
        allowFields,
      },
      overrides: overrides.length > 0 ? overrides : undefined,
    });
  }

  return scenarios;
}

// ---------------------------------------------------------------------------
// Sanitization Engine (Pure, Allowlist-First)
// ---------------------------------------------------------------------------

function registerFixture(
  fixturesMap: Map<string, FixtureConstantDef>,
  name: string,
): void {
  if (!fixturesMap.has(name)) {
    fixturesMap.set(name, {
      name,
      defaultValue: FIXTURE_DEFAULTS[name] ?? `test-${toKebabCase(name)}`,
    });
  }
}

function sanitizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  location: "request.header" | "response.header",
  sanitized: SanitizedEntry[],
  fixturesMap: Map<string, FixtureConstantDef>,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const explicitFixture = SENSITIVE_HEADER_FIXTURES[lower];

    if (explicitFixture) {
      registerFixture(fixturesMap, explicitFixture);
      let replacementValue: string;
      let replacementLabel: string;
      if (lower === "authorization" && /^Bearer\s+/i.test(value)) {
        replacementValue = makeFixtureRef(explicitFixture, "Bearer ");
        replacementLabel = `Bearer \${${explicitFixture}}`;
      } else if (lower === "authorization" && /^Basic\s+/i.test(value)) {
        replacementValue = makeFixtureRef(explicitFixture, "Basic ");
        replacementLabel = `Basic \${${explicitFixture}}`;
      } else {
        replacementValue = makeFixtureRef(explicitFixture);
        replacementLabel = explicitFixture;
      }
      result[key] = replacementValue;
      sanitized.push({
        location,
        path: key,
        reason: `sensitive header "${lower}"`,
        replacement: replacementLabel,
      });
      continue;
    }

    if (SENSITIVE_HEADER_NAME_PATTERN.test(lower)) {
      const fixtureName = "FIXTURE_REDACTED_HEADER";
      registerFixture(fixturesMap, fixtureName);
      result[key] = makeFixtureRef(fixtureName);
      sanitized.push({
        location,
        path: key,
        reason: `sensitive header "${lower}"`,
        replacement: fixtureName,
      });
      continue;
    }

    if (JWT_STRING_REGEX.test(value.trim())) {
      const fixtureName = "FIXTURE_JWT_TOKEN";
      registerFixture(fixturesMap, fixtureName);
      const hasBearer = /^Bearer\s+/i.test(value.trim());
      result[key] = makeFixtureRef(fixtureName, hasBearer ? "Bearer " : "");
      sanitized.push({
        location,
        path: key,
        reason: "JWT-shaped token value",
        replacement: hasBearer ? `Bearer \${${fixtureName}}` : fixtureName,
      });
      continue;
    }

    result[key] = value;
  }

  return result;
}

function sanitizeValueRecursive(
  value: unknown,
  location: "request.body" | "response.body",
  currentPath: string,
  sanitized: SanitizedEntry[],
  fixturesMap: Map<string, FixtureConstantDef>,
  redactedPaths: Set<string>,
): unknown {
  if (typeof value === "string") {
    if (JWT_STRING_REGEX.test(value.trim())) {
      const fixtureName = "FIXTURE_JWT_TOKEN";
      registerFixture(fixturesMap, fixtureName);
      const hasBearer = /^Bearer\s+/i.test(value.trim());
      redactedPaths.add(currentPath);
      sanitized.push({
        location,
        path: currentPath || "$",
        reason: "JWT-shaped string value",
        replacement: hasBearer ? `Bearer \${${fixtureName}}` : fixtureName,
      });
      return makeFixtureRef(fixtureName, hasBearer ? "Bearer " : "");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      sanitizeValueRecursive(
        item,
        location,
        `${currentPath}[${idx}]`,
        sanitized,
        fixturesMap,
        redactedPaths,
      ),
    );
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      const fixtureName = detectSensitiveBodyFixture(key);
      if (fixtureName) {
        registerFixture(fixturesMap, fixtureName);
        redactedPaths.add(nextPath);
        sanitized.push({
          location,
          path: nextPath,
          reason: `sensitive key "${key}"`,
          replacement: fixtureName,
        });
        out[key] = makeFixtureRef(fixtureName);
        continue;
      }
      out[key] = sanitizeValueRecursive(
        fieldValue,
        location,
        nextPath,
        sanitized,
        fixturesMap,
        redactedPaths,
      );
    }
    return out;
  }

  return value;
}

function stripFixtureMarkersForScenario(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      new RegExp(
        `${FIXTURE_REF_PREFIX}([A-Z0-9_]+)${FIXTURE_REF_SUFFIX}`,
        "g",
      ),
      (_, name: string) => `\${${name}}`,
    );
  }
  if (Array.isArray(value)) {
    return value.map(stripFixtureMarkersForScenario);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripFixtureMarkersForScenario(v);
    }
    return out;
  }
  return value;
}

function buildResponseFieldAssertions(
  sanitizedBody: unknown,
  redactedResponsePaths: ReadonlySet<string>,
  explicitAllowFields: readonly string[] | undefined,
): ResponseFieldAssertionPlan[] {
  if (!isPlainObject(sanitizedBody)) {
    return [];
  }

  const assertions: ResponseFieldAssertionPlan[] = [];
  const fieldsToInspect =
    explicitAllowFields && explicitAllowFields.length > 0
      ? explicitAllowFields
      : Object.keys(sanitizedBody);

  for (const fieldPath of fieldsToInspect) {
    const { found, value } = getValueAtPath(sanitizedBody, fieldPath);
    if (!found) continue;

    // Never assert a raw secret value; if user explicitly allowlisted a redacted key,
    // emit a presence-only assertion.
    if (
      redactedResponsePaths.has(fieldPath) ||
      (typeof value === "string" && value.includes(FIXTURE_REF_PREFIX))
    ) {
      if (explicitAllowFields && explicitAllowFields.length > 0) {
        assertions.push({
          path: fieldPath,
          kind: "defined",
          reason: "redacted sensitive field",
        });
      }
      continue;
    }

    const leafKey = fieldPath.split(".").pop() ?? fieldPath;
    const volatileReason = detectVolatileReason(leafKey, value);
    if (volatileReason) {
      const valueType = typeof value;
      if (
        valueType === "string" ||
        valueType === "number" ||
        valueType === "boolean" ||
        valueType === "object"
      ) {
        assertions.push({
          path: fieldPath,
          kind: "shape",
          expectedType: valueType,
          reason: volatileReason,
        });
      } else {
        assertions.push({
          path: fieldPath,
          kind: "defined",
          reason: volatileReason,
        });
      }
      continue;
    }

    assertions.push({
      path: fieldPath,
      kind: "exact",
      expectedValue: value,
    });
  }

  return assertions;
}

function computeSizeBytes(
  observed: RequestScenarioObservedResponse,
): number {
  if (typeof observed.sizeBytes === "number" && observed.sizeBytes >= 0) {
    return observed.sizeBytes;
  }
  if (observed.rawBody instanceof Uint8Array) {
    return observed.rawBody.byteLength;
  }
  if (typeof observed.rawBody === "string") {
    return new TextEncoder().encode(observed.rawBody).byteLength;
  }
  if (typeof observed.body === "string") {
    return new TextEncoder().encode(observed.body).byteLength;
  }
  return 0;
}

function sanitizeSingleCase(
  scenarioCase: RequestScenarioCase,
  slugBase: string,
  caseIndex: number,
  sanitized: SanitizedEntry[],
  fixturesMap: Map<string, FixtureConstantDef>,
  overrideAllowFields?: readonly string[],
): SanitizedCasePlan {
  const method = scenarioCase.method.toUpperCase();
  const path = scenarioCase.path.startsWith("/")
    ? scenarioCase.path
    : `/${scenarioCase.path}`;

  const sanitizedReqHeaders = sanitizeHeaders(
    scenarioCase.headers,
    "request.header",
    sanitized,
    fixturesMap,
  );
  const redactedReqBodyPaths = new Set<string>();
  const sanitizedReqBody =
    scenarioCase.body !== undefined
      ? sanitizeValueRecursive(
          scenarioCase.body,
          "request.body",
          "",
          sanitized,
          fixturesMap,
          redactedReqBodyPaths,
        )
      : undefined;

  const observed = scenarioCase.observedResponse;
  const expectedStatus =
    scenarioCase.assertions?.status ??
    observed?.status ??
    (method === "POST" ? 201 : 200);

  const responseContentType =
    observed?.contentType ??
    Object.entries(observed?.headers ?? {}).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];

  const isBinary =
    observed?.isBinaryOrStream === true ||
    isBinaryOrStreamContentType(responseContentType);

  let binaryFixtureSuggestion: BinaryFixtureSuggestion | undefined;
  let rawBinaryContent: string | undefined;

  if (isBinary && observed) {
    const contentType = responseContentType ?? "application/octet-stream";
    const ext = extensionForContentType(contentType);
    const suffix = caseIndex > 0 ? `-${caseIndex + 1}` : "";
    binaryFixtureSuggestion = {
      suggestedPath: `test/fixtures/${slugBase}${suffix}.${ext}`,
      contentType,
      sizeBytes: computeSizeBytes(observed),
    };
    if (typeof observed.rawBody === "string") {
      rawBinaryContent = observed.rawBody;
    } else if (observed.rawBody instanceof Uint8Array) {
      // Base64-safe text representation for explicit opt-in fixture writing
      rawBinaryContent = Buffer.from(observed.rawBody).toString("base64");
    } else if (typeof observed.body === "string") {
      rawBinaryContent = observed.body;
    } else {
      rawBinaryContent = "";
    }
  }

  const sanitizedResHeaders = sanitizeHeaders(
    observed?.headers,
    "response.header",
    sanitized,
    fixturesMap,
  );

  const headerAssertions: Array<{ name: string; value?: string }> = [];
  for (const headerName of scenarioCase.assertions?.headers ?? []) {
    const matchedEntry = Object.entries(sanitizedResHeaders).find(
      ([k]) => k.toLowerCase() === headerName.toLowerCase(),
    );
    const value = matchedEntry?.[1];
    if (value && value.includes(FIXTURE_REF_PREFIX)) {
      headerAssertions.push({ name: headerName });
    } else {
      headerAssertions.push({ name: headerName, value });
    }
  }

  let fieldAssertions: ResponseFieldAssertionPlan[] = [];
  if (!isBinary && observed?.body !== undefined) {
    const redactedResPaths = new Set<string>();
    const sanitizedResBody = sanitizeValueRecursive(
      observed.body,
      "response.body",
      "",
      sanitized,
      fixturesMap,
      redactedResPaths,
    );
    const allowFields =
      overrideAllowFields ?? scenarioCase.assertions?.allowFields;
    fieldAssertions = buildResponseFieldAssertions(
      sanitizedResBody,
      redactedResPaths,
      allowFields,
    );
  }

  return {
    name: scenarioCase.name ?? `${method} ${path} returns ${expectedStatus}`,
    method,
    path,
    query: scenarioCase.query,
    headers: sanitizedReqHeaders,
    body: sanitizedReqBody,
    contentType: scenarioCase.contentType,
    expectedStatus,
    headerAssertions,
    fieldAssertions,
    isBinaryOrStream: isBinary,
    binaryContentType: responseContentType,
    binaryFixtureSuggestion,
    rawBinaryContent,
  };
}

/**
 * Pure allowlist-first sanitizer for a `RequestScenarioV1`.
 * Replaces sensitive headers, body keys, and JWT tokens with named fixture
 * constants, converts volatile response fields to shape assertions, detects
 * binary/stream responses without inlining bytes, and propagates `unsavedBuffer`.
 */
export function sanitizeScenarioForTest(
  scenario: RequestScenarioV1,
  assertFields?: readonly string[],
): SanitizedScenarioResult {
  const sanitized: SanitizedEntry[] = [];
  const fixturesMap = new Map<string, FixtureConstantDef>();
  const warnings: string[] = [];

  if (scenario.routeMeta?.unsavedBuffer === true) {
    const sourceLabel = scenario.routeMeta.sourceFile
      ? ` (${scenario.routeMeta.sourceFile})`
      : "";
    warnings.push(
      `Unsaved editor buffer detected${sourceLabel}: generated test metadata may differ from files saved on disk. Save the buffer before running the regression test.`,
    );
  }

  const slugBase = deriveSlug(scenario);
  const rawCases: RequestScenarioCase[] = [
    {
      name: scenario.name,
      method: scenario.method,
      path: scenario.path,
      query: scenario.query,
      headers: scenario.headers,
      body: scenario.body,
      contentType: scenario.contentType,
      observedResponse: scenario.observedResponse,
      assertions: scenario.assertions,
    },
    ...(scenario.cases ?? []),
  ];

  const cases = rawCases.map((c, idx) =>
    sanitizeSingleCase(c, slugBase, idx, sanitized, fixturesMap, assertFields),
  );

  const primaryBinarySuggestion = cases.find(
    (c) => c.binaryFixtureSuggestion !== undefined,
  )?.binaryFixtureSuggestion;

  const primaryCase = cases[0]!;
  const cleanScenario: RequestScenarioV1 = {
    ...scenario,
    headers:
      Object.keys(primaryCase.headers).length > 0
        ? (stripFixtureMarkersForScenario(primaryCase.headers) as Record<
            string,
            string
          >)
        : undefined,
    body:
      primaryCase.body !== undefined
        ? stripFixtureMarkersForScenario(primaryCase.body)
        : undefined,
    observedResponse: scenario.observedResponse
      ? {
          status: scenario.observedResponse.status,
          contentType: scenario.observedResponse.contentType,
          isBinaryOrStream: primaryCase.isBinaryOrStream,
          sizeBytes: primaryCase.binaryFixtureSuggestion?.sizeBytes,
        }
      : undefined,
  };

  return {
    scenario: cleanScenario,
    cases,
    sanitized,
    fixtures: Array.from(fixturesMap.values()),
    binaryFixtureSuggestion: primaryBinarySuggestion,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// TypeScript Test Code Generator
// ---------------------------------------------------------------------------

function serializeTsValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  const innerPad = " ".repeat(indent + 2);

  if (typeof value === "string") {
    const exactMatch = new RegExp(
      `^${FIXTURE_REF_PREFIX}([A-Z0-9_]+)${FIXTURE_REF_SUFFIX}$`,
    ).exec(value);
    if (exactMatch) {
      return exactMatch[1]!;
    }
    if (value.includes(FIXTURE_REF_PREFIX)) {
      const interpolated = value
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$\{/g, "\\${")
        .replace(
          new RegExp(
            `${FIXTURE_REF_PREFIX}([A-Z0-9_]+)${FIXTURE_REF_SUFFIX}`,
            "g",
          ),
          (_, name: string) => `\${${name}}`,
        );
      return `\`${interpolated}\``;
    }
    return JSON.stringify(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map(
      (item) => `${innerPad}${serializeTsValue(item, indent + 2)}`,
    );
    return `[\n${items.join(",\n")},\n${pad}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      const keyExpr = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)
        ? k
        : JSON.stringify(k);
      return `${innerPad}${keyExpr}: ${serializeTsValue(v, indent + 2)}`;
    });
    return `{\n${lines.join(",\n")},\n${pad}}`;
  }

  return "undefined";
}

function renderCaseTestBlock(casePlan: SanitizedCasePlan): string {
  const lines: string[] = [];
  lines.push(`  it(${JSON.stringify(casePlan.name)}, async () => {`);

  const methodLower = casePlan.method.toLowerCase();
  const hasHelperMethod =
    methodLower === "get" ||
    methodLower === "post" ||
    methodLower === "put" ||
    methodLower === "patch" ||
    methodLower === "delete";

  const reqOptionEntries: string[] = [];

  if (casePlan.query && Object.keys(casePlan.query).length > 0) {
    reqOptionEntries.push(
      `      query: ${serializeTsValue(casePlan.query, 6)},`,
    );
  }

  // Filter out Content-Type: application/json when using `json:` option
  const filteredHeaders = Object.entries(casePlan.headers).filter(([k, v]) => {
    if (
      k.toLowerCase() === "content-type" &&
      v.toLowerCase().includes("application/json") &&
      casePlan.body !== undefined &&
      typeof casePlan.body !== "string"
    ) {
      return false;
    }
    return true;
  });

  if (filteredHeaders.length > 0) {
    const headerObj: Record<string, string> = {};
    for (const [k, v] of filteredHeaders) {
      headerObj[k] = v;
    }
    reqOptionEntries.push(
      `      headers: ${serializeTsValue(headerObj, 6)},`,
    );
  }

  if (casePlan.body !== undefined && methodLower !== "get") {
    if (typeof casePlan.body === "string") {
      reqOptionEntries.push(
        `      body: ${serializeTsValue(casePlan.body, 6)},`,
      );
    } else {
      reqOptionEntries.push(
        `      json: ${serializeTsValue(casePlan.body, 6)},`,
      );
    }
  }

  if (hasHelperMethod) {
    if (reqOptionEntries.length === 0) {
      lines.push(
        `    const res = await client.${methodLower}(${JSON.stringify(casePlan.path)});`,
      );
    } else {
      lines.push(
        `    const res = await client.${methodLower}(${JSON.stringify(casePlan.path)}, {`,
      );
      lines.push(...reqOptionEntries);
      lines.push("    });");
    }
  } else {
    if (reqOptionEntries.length === 0) {
      lines.push(
        `    const res = await client.request(${JSON.stringify(casePlan.method)}, ${JSON.stringify(casePlan.path)});`,
      );
    } else {
      lines.push(
        `    const res = await client.request(${JSON.stringify(casePlan.method)}, ${JSON.stringify(casePlan.path)}, {`,
      );
      lines.push(...reqOptionEntries);
      lines.push("    });");
    }
  }

  lines.push("");
  lines.push(`    expect(res.status).toBe(${casePlan.expectedStatus});`);

  for (const h of casePlan.headerAssertions) {
    if (h.value !== undefined) {
      lines.push(
        `    expect(res.header(${JSON.stringify(h.name)})).toContain(${JSON.stringify(h.value)});`,
      );
    } else {
      lines.push(
        `    expect(res.header(${JSON.stringify(h.name)})).toBeDefined();`,
      );
    }
  }

  if (casePlan.isBinaryOrStream) {
    const mime =
      casePlan.binaryContentType?.split(";")[0]?.trim() ??
      "application/octet-stream";
    lines.push(
      `    // Binary/stream response detected (${mime}) — bytes are intentionally not inlined.`,
    );
    if (casePlan.binaryFixtureSuggestion) {
      lines.push(
        `    // Suggested fixture path: ${casePlan.binaryFixtureSuggestion.suggestedPath}`,
      );
    }
    lines.push(
      `    expect(res.header("content-type") ?? "").toContain(${JSON.stringify(mime)});`,
    );
    lines.push("    const bytes = await res.bytes();");
    lines.push("    expect(bytes.byteLength).toBeGreaterThan(0);");
  } else if (casePlan.fieldAssertions.length > 0) {
    lines.push("    const body = await res.json<Record<string, unknown>>();");
    for (const assertion of casePlan.fieldAssertions) {
      const accessor = formatPropertyAccess("body", assertion.path);
      if (assertion.kind === "exact") {
        const val = assertion.expectedValue;
        const isPrimitive =
          val === null ||
          typeof val === "string" ||
          typeof val === "number" ||
          typeof val === "boolean";
        if (isPrimitive) {
          lines.push(
            `    expect(${accessor}).toBe(${JSON.stringify(val)});`,
          );
        } else {
          lines.push(
            `    expect(${accessor}).toEqual(${serializeTsValue(val, 4)});`,
          );
        }
      } else if (assertion.kind === "shape" && assertion.expectedType) {
        lines.push(`    expect(${accessor}).toBeDefined();`);
        lines.push(
          `    expect(typeof ${accessor}).toBe(${JSON.stringify(assertion.expectedType)});`,
        );
      } else {
        lines.push(`    expect(${accessor}).toBeDefined();`);
      }
    }
  } else if (casePlan.expectedStatus === 400) {
    lines.push("    const body = await res.json<Record<string, unknown>>();");
    lines.push("    expect(body.statusCode).toBe(400);");
    lines.push("    expect(body.message).toBeDefined();");
  }

  lines.push("  });");
  return lines.join("\n");
}

function renderRegressionTestFile(
  sanitizedResult: SanitizedScenarioResult,
  options: PlanTestFromRequestOptions,
): string {
  const scenario = sanitizedResult.scenario;
  const moduleName =
    options.moduleName ?? scenario.routeMeta?.module ?? "AppModule";
  const moduleImportPath =
    options.moduleImportPath ??
    scenario.routeMeta?.moduleImportPath ??
    "../src/app.module";
  const overrides = Array.from(
    new Set([...(scenario.overrides ?? []), ...(options.overrides ?? [])]),
  );

  const lines: string[] = [];

  if (sanitizedResult.warnings.length > 0) {
    for (const warning of sanitizedResult.warnings) {
      lines.push(`// WARNING: ${warning}`);
    }
  }

  lines.push(
    'import { afterEach, beforeEach, describe, expect, it } from "bun:test";',
  );
  if (options.useValidationPipe) {
    lines.push('import { ValidationPipe } from "@bunest/core";');
  }
  lines.push(
    'import { Test, type TestClient, type TestingModule } from "@bunest/testing";',
  );
  lines.push(`import { ${moduleName} } from ${JSON.stringify(moduleImportPath)};`);
  lines.push("");

  if (sanitizedResult.fixtures.length > 0) {
    lines.push(
      "// Sanitized test fixtures (never commit real tokens, cookies, or secrets).",
    );
    for (const fixture of sanitizedResult.fixtures) {
      lines.push(
        `const ${fixture.name} = ${JSON.stringify(fixture.defaultValue)};`,
      );
    }
    lines.push("");
  }

  const suiteName =
    scenario.name ?? `${scenario.method.toUpperCase()} ${scenario.path} regression`;
  lines.push(`describe(${JSON.stringify(suiteName)}, () => {`);
  lines.push("  let moduleRef: TestingModule;");
  lines.push("  let client: TestClient;");
  lines.push("");
  lines.push("  beforeEach(async () => {");

  if (overrides.length === 0) {
    lines.push("    moduleRef = await Test.createTestingModule({");
    lines.push(`      imports: [${moduleName}],`);
    lines.push("    }).compile();");
  } else {
    lines.push("    moduleRef = await Test.createTestingModule({");
    lines.push(`      imports: [${moduleName}],`);
    lines.push("    })");
    for (const token of overrides) {
      lines.push(
        `      .overrideProvider(${JSON.stringify(token)})`,
      );
      lines.push("      .useValue({})");
    }
    lines.push("      .compile();");
  }

  lines.push("");
  lines.push("    const app = moduleRef.createBunestApplication();");
  if (options.useValidationPipe) {
    lines.push(
      "    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));",
    );
  }
  lines.push("    await app.init();");
  lines.push("    client = moduleRef.createTestClient(app);");
  lines.push("  });");
  lines.push("");
  lines.push("  afterEach(async () => {");
  lines.push("    await moduleRef.close();");
  lines.push("  });");

  for (const casePlan of sanitizedResult.cases) {
    lines.push("");
    lines.push(renderCaseTestBlock(casePlan));
  }

  lines.push("});");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Unified Diff Preview Builder (Pure, Zero Dependencies)
// ---------------------------------------------------------------------------

function buildUnifiedDiff(
  relativePath: string,
  previousContent: string | undefined,
  nextContent: string,
): string {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const nextLines = nextContent.replace(/\r\n/g, "\n").split("\n");
  if (nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }

  if (previousContent === undefined) {
    const header = [
      "--- /dev/null",
      `+++ b/${normalizedPath}`,
      `@@ -0,0 +1,${nextLines.length} @@`,
    ];
    return [...header, ...nextLines.map((line) => `+${line}`)].join("\n");
  }

  const prevLines = previousContent.replace(/\r\n/g, "\n").split("\n");
  if (prevLines[prevLines.length - 1] === "") {
    prevLines.pop();
  }

  const header = [
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -1,${prevLines.length} +1,${nextLines.length} @@`,
  ];
  return [
    ...header,
    ...prevLines.map((line) => `-${line}`),
    ...nextLines.map((line) => `+${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pure Planner (`planTestFromRequest`)
// ---------------------------------------------------------------------------

function normalizeScenarioInput(
  input: RequestScenarioV1 | readonly RequestScenarioV1[],
): RequestScenarioV1 {
  if (!Array.isArray(input)) {
    return input as RequestScenarioV1;
  }
  if (input.length === 0) {
    throw new Error(
      "Cannot plan regression test: no request scenarios were provided.",
    );
  }
  const [first, ...rest] = input;
  if (rest.length === 0) {
    return first!;
  }
  const mergedOverrides = new Set<string>(first!.overrides ?? []);
  const extraCases: RequestScenarioCase[] = [...(first!.cases ?? [])];
  for (const extra of rest) {
    for (const ov of extra.overrides ?? []) {
      mergedOverrides.add(ov);
    }
    extraCases.push({
      name: extra.name,
      method: extra.method,
      path: extra.path,
      query: extra.query,
      headers: extra.headers,
      body: extra.body,
      contentType: extra.contentType,
      observedResponse: extra.observedResponse,
      assertions: extra.assertions,
    });
    if (extra.cases) {
      extraCases.push(...extra.cases);
    }
  }
  return {
    ...first!,
    overrides:
      mergedOverrides.size > 0 ? Array.from(mergedOverrides) : undefined,
    cases: extraCases,
  };
}

/**
 * Pure, side-effect-free planner for `bunest test-from-request`.
 * Produces planned files, unified diffs, sanitization audit entries,
 * optional binary fixture suggestion, and warnings with ZERO disk writes.
 */
export function planTestFromRequest(
  scenarioInput: RequestScenarioV1 | readonly RequestScenarioV1[],
  options: PlanTestFromRequestOptions = {},
): TestFromRequestPlan {
  const mergedScenario = normalizeScenarioInput(scenarioInput);
  const sanitizedResult = sanitizeScenarioForTest(
    mergedScenario,
    options.assertFields,
  );

  const slug = deriveSlug(sanitizedResult.scenario);
  const testRelativePath =
    options.out && options.out.trim().length > 0
      ? options.out.trim().replace(/\\/g, "/")
      : `test/${slug}.regression.spec.ts`;

  const testContent = renderRegressionTestFile(sanitizedResult, options);

  const files: PlannedFile[] = [
    {
      relativePath: testRelativePath,
      content: testContent,
    },
  ];

  // Only plan writing the binary fixture file when explicitly opted in.
  if (options.saveBinaryFixture === true) {
    for (const casePlan of sanitizedResult.cases) {
      if (casePlan.binaryFixtureSuggestion) {
        files.push({
          relativePath: casePlan.binaryFixtureSuggestion.suggestedPath,
          content: casePlan.rawBinaryContent ?? "",
        });
      }
    }
  }

  const diffs: FileDiffPreview[] = files.map((file) => {
    const existing = options.existingContents?.[file.relativePath];
    return {
      relativePath: file.relativePath,
      action: existing !== undefined ? "overwrite" : "create",
      unifiedDiff: buildUnifiedDiff(file.relativePath, existing, file.content),
    };
  });

  return {
    schemaVersion: "1.0",
    files,
    diffs,
    sanitized: sanitizedResult.sanitized,
    binaryFixtureSuggestion: sanitizedResult.binaryFixtureSuggestion,
    warnings: sanitizedResult.warnings,
  };
}

// ---------------------------------------------------------------------------
// CLI Command Runner (`runTestFromRequestCommand`)
// ---------------------------------------------------------------------------

function parseRawScenarioInput(
  rawText: string,
  sourcePath?: string,
): RequestScenarioV1 | RequestScenarioV1[] {
  const ext = sourcePath ? getFileExtension(sourcePath) : "";
  const trimmed = rawText.trim();

  if (ext === ".http" || ext === ".rest") {
    const scenarios = parseHttpFileToScenarios(rawText, sourcePath);
    if (scenarios.length === 0) {
      throw new Error(
        `No valid HTTP requests found in "${sourcePath ?? "<input>"}".`,
      );
    }
    return scenarios;
  }

  if (ext === ".json" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        validateScenarioV1(item);
      }
      return parsed as RequestScenarioV1[];
    }
    validateScenarioV1(parsed);
    return parsed as RequestScenarioV1;
  }

  const scenarios = parseHttpFileToScenarios(rawText, sourcePath);
  if (scenarios.length === 0) {
    throw new Error(
      `Unable to parse "${sourcePath ?? "<input>"}" as RequestScenarioV1 JSON or .http request file.`,
    );
  }
  return scenarios;
}

function validateScenarioV1(value: unknown): asserts value is RequestScenarioV1 {
  if (!isPlainObject(value)) {
    throw new Error("Invalid scenario: expected a JSON object.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error(
      `Unsupported scenario schemaVersion "${String(value.schemaVersion)}": expected 1.`,
    );
  }
  if (typeof value.method !== "string" || value.method.trim().length === 0) {
    throw new Error("Invalid scenario: missing required string field \"method\".");
  }
  if (typeof value.path !== "string" || value.path.trim().length === 0) {
    throw new Error("Invalid scenario: missing required string field \"path\".");
  }
}

function formatCommandOutput(
  plan: TestFromRequestPlan,
  writtenFiles: readonly GeneratedFile[],
  dryRun: boolean,
  format: TestFromRequestOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        schemaVersion: plan.schemaVersion,
        dryRun,
        files: writtenFiles.map((f) => ({
          relativePath: f.relativePath,
          action: f.action,
        })),
        diffs: plan.diffs,
        sanitized: plan.sanitized,
        binaryFixtureSuggestion: plan.binaryFixtureSuggestion,
        warnings: plan.warnings,
      },
      null,
      2,
    );
  }

  if (format === "diff") {
    const parts: string[] = [];
    for (const warning of plan.warnings) {
      parts.push(`WARNING: ${warning}`);
    }
    for (const diff of plan.diffs) {
      parts.push(diff.unifiedDiff);
    }
    return parts.join("\n\n");
  }

  const lines: string[] = [];
  lines.push(
    dryRun
      ? `Dry-run: planned ${writtenFiles.length} file(s) (no files written):`
      : `Generated ${writtenFiles.length} file(s):`,
  );
  for (const file of writtenFiles) {
    lines.push(`  [${file.action}] ${file.relativePath}`);
  }
  if (plan.sanitized.length > 0) {
    lines.push(
      `Sanitized ${plan.sanitized.length} sensitive value(s) into named fixtures.`,
    );
  }
  if (plan.binaryFixtureSuggestion) {
    lines.push(
      `Binary/stream response detected (${plan.binaryFixtureSuggestion.contentType}, ${plan.binaryFixtureSuggestion.sizeBytes} bytes). Suggested fixture: ${plan.binaryFixtureSuggestion.suggestedPath} (pass --save-binary-fixture to write).`,
    );
  }
  for (const warning of plan.warnings) {
    lines.push(`WARNING: ${warning}`);
  }
  return lines.join("\n");
}

/**
 * Executes `bunest test-from-request`: loads a `RequestScenarioV1` JSON or
 * `.http` sample file, plans sanitized regression test files, and writes them
 * atomically via `writePlannedFiles()` with `--dry-run`, `--format`, and
 * collision protection (`FileCollisionError`).
 */
export async function runTestFromRequestCommand(
  options: TestFromRequestCommandOptions,
  io?: CliIO,
): Promise<TestFromRequestCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const format: TestFromRequestOutputFormat = options.format ?? "pretty";

  let scenarioInput: RequestScenarioV1 | readonly RequestScenarioV1[];

  if (options.scenario !== undefined) {
    scenarioInput = options.scenario;
  } else if (options.rawInput !== undefined) {
    scenarioInput = parseRawScenarioInput(options.rawInput, options.inputPath);
  } else if (options.inputPath !== undefined) {
    const resolvedInput = resolve(cwd, options.inputPath);
    try {
      await statPath(resolvedInput);
    } catch {
      throw new Error(`Scenario file not found: ${resolvedInput}`);
    }
    const rawText = await Bun.file(resolvedInput).text();
    scenarioInput = parseRawScenarioInput(rawText, options.inputPath);
  } else {
    throw new Error(
      "Missing scenario input: provide `scenario`, `inputPath`, or `rawInput`.",
    );
  }

  const plan = planTestFromRequest(scenarioInput, {
    out: options.out,
    assertFields: options.assertFields,
    saveBinaryFixture: options.saveBinaryFixture,
    moduleName: options.moduleName,
    moduleImportPath: options.moduleImportPath,
    overrides: options.overrides,
    useValidationPipe: options.useValidationPipe,
    existingContents: options.existingContents,
  });

  const writtenFiles = await writePlannedFiles({
    baseDir: cwd,
    files: plan.files,
    dryRun,
    force,
  });

  const formattedOutput = formatCommandOutput(
    plan,
    writtenFiles,
    dryRun,
    format,
  );
  if (io) {
    io.stdout(formattedOutput);
  }

  return {
    exitCode: 0,
    dryRun,
    plan,
    files: writtenFiles,
    formattedOutput,
  };
}
