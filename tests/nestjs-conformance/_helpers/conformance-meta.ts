import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import type { ValidationErrorResponse } from "../../../packages/common/src";
import { ScopeLeakException } from "../../../packages/core/src";

export type AdrId =
  | "ADR-001"
  | "ADR-002"
  | "ADR-003"
  | "ADR-004"
  | "ADR-005"
  | "ADR-006"
  | "ADR-007"
  | "ADR-008"
  | "ADR-009"
  | "ADR-010"
  | "ADR-011"
  | "ADR-012";

export type ConformanceCategory = "DIRECT_PORT" | "ADAPTED_PORT";

export interface AdrEntry {
  readonly id: AdrId;
  readonly title: string;
  readonly docPath: string;
  readonly nestjsBehavior: string;
  readonly bunestBehavior: string;
}

export const BUNEST_ADRS: Readonly<Record<AdrId, AdrEntry>> = Object.freeze({
  "ADR-001": {
    id: "ADR-001",
    title: "Bun-Only Runtime (Native Web Request/Response, Zero Express/Fastify)",
    docPath: "docs/adr/ADR-001.md",
    nestjsBehavior:
      "Runs on Node.js via AbstractHttpAdapter (Express, Fastify, or platform-node IncomingMessage/ServerResponse).",
    bunestBehavior:
      "Runs natively on Bun (>= 1.4.3) using Bun.serve({ routes, fetch, websocket }) and Web Standard Request/Response.",
  },
  "ADR-002": {
    id: "ADR-002",
    title: "Legacy TypeScript Decorators + verbatimModuleSyntax: true",
    docPath: "docs/adr/ADR-002.md",
    nestjsBehavior:
      "Legacy decorators with tsc/SWC emit; verbatimModuleSyntax is typically disabled.",
    bunestBehavior:
      "Legacy decorators with verbatimModuleSyntax: true; DI/DTO classes MUST be value-imported while interfaces/types MUST use `import type`, and `reflect-metadata` must be imported first.",
  },
  "ADR-003": {
    id: "ADR-003",
    title: "Stateless Singleton Controllers by Default",
    docPath: "docs/adr/ADR-003.md",
    nestjsBehavior:
      "Controllers default to singleton scope and silently bubble to request scope when injecting request-scoped providers.",
    bunestBehavior:
      "Controllers default to stateless Scope.SINGLETON; request-scoped controllers must opt in explicitly via @Controller({ scope: Scope.REQUEST }).",
  },
  "ADR-004": {
    id: "ADR-004",
    title: "Legacy Parameter Decorators, Cached Single-Read Body & Explicit Coercion",
    docPath: "docs/adr/ADR-004.md",
    nestjsBehavior:
      "Extracts parameters from Express/Fastify request objects; middleware often pre-parses body.",
    bunestBehavior:
      "Index-keyed parameter metadata with lazy single-read Web Request body caching and no implicit primitive coercion (use explicit Parse*Pipe or @Type).",
  },
  "ADR-005": {
    id: "ADR-005",
    title: "class-validator + class-transformer as Default DTO Validation",
    docPath: "docs/adr/ADR-005.md",
    nestjsBehavior:
      "Opt-in ValidationPipe backed by class-validator and class-transformer (optional peer deps).",
    bunestBehavior:
      "Opt-in ValidationPipe in @bunest/validation (re-exported by @bunest/core) backed by class-validator and class-transformer plus Standard Schema v1 pipes.",
  },
  "ADR-006": {
    id: "ADR-006",
    title: "@Controller() & HTTP Method Decorators with Inheritance-Safe Scanning",
    docPath: "docs/adr/ADR-006.md",
    nestjsBehavior:
      "Scans controller routes and enhancers across prototypes.",
    bunestBehavior:
      "Copy-on-write inheritance-safe metadata scanning with fail-fast InvalidControllerException and canonical duplicate route detection.",
  },
  "ADR-007": {
    id: "ADR-007",
    title: "Module-Scoped Providers, Explicit Exports & Fail-Fast Ambiguity",
    docPath: "docs/adr/ADR-007.md",
    nestjsBehavior:
      "Module-scoped DI; last-imported provider may silently win on colliding tokens in some cases.",
    bunestBehavior:
      "Strict module encapsulation with deterministic precedence (local > direct import > global) and fail-fast AmbiguousProviderException / InvalidExportException / UnknownDependencyException.",
  },
  "ADR-008": {
    id: "ADR-008",
    title: "11-Stage Promise Onion Pipeline (Zero RxJS)",
    docPath: "docs/adr/ADR-008.md",
    nestjsBehavior:
      "RxJS Observable-based CallHandler.handle(): Observable<T> and Observable guards/interceptors/SSE.",
    bunestBehavior:
      "Native Promise-based CallHandler.handle(): Promise<T> onion model with zero RxJS dependency; SSE uses AsyncIterable / ReadableStream.",
  },
  "ADR-009": {
    id: "ADR-009",
    title: "Strict ValidationPipe Defaults & Normalized HTTP 400 Error Envelope",
    docPath: "docs/adr/ADR-009.md",
    nestjsBehavior:
      "ValidationPipe defaults to whitelist: false, forbidNonWhitelisted: false, transform: false, and emits flat `{ statusCode, message: string[], error }`.",
    bunestBehavior:
      "ValidationPipe defaults to whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true, enableImplicitConversion: false, validationError: { target: false, value: false }, and emits `{ statusCode, error, message: 'Validation failed', details }` (use errorFormat: 'list' or nestCompatibleValidationPipe() for NestJS defaults).",
  },
  "ADR-010": {
    id: "ADR-010",
    title: "Native Web Response Serialization & Mutable ResponseContext",
    docPath: "docs/adr/ADR-010.md",
    nestjsBehavior:
      "@Res() injects Express/Fastify response and disables standard serialization unless `{ passthrough: true }` is passed.",
    bunestBehavior:
      "@Res() injects mutable ResponseContext (always passthrough-friendly) and handlers may return plain values, StreamableFile, Blob/BunFile, ReadableStream, or native Web Response directly.",
  },
  "ADR-011": {
    id: "ADR-011",
    title: "Hybrid Bun.serve({ routes }) + FallbackRadixRouter",
    docPath: "docs/adr/ADR-011.md",
    nestjsBehavior:
      "Single Express/Fastify/find-my-way router per adapter; duplicate routes often silently shadow.",
    bunestBehavior:
      "Hybrid native Bun.serve({ routes }) + FallbackRadixRouter with O(1) 405 Method Not Allowed + Allow header and fail-fast DuplicateRouteException by default.",
  },
  "ADR-012": {
    id: "ADR-012",
    title: "Request-Scoped DI via AsyncLocalStorage & Fail-Fast ScopeLeakException",
    docPath: "docs/adr/ADR-012.md",
    nestjsBehavior:
      "Injecting a Scope.REQUEST provider into a singleton silently bubbles request scope up the dependency tree.",
    bunestBehavior:
      "Fail-fast ScopeLeakException at bootstrap if a Scope.SINGLETON depends (directly or transitively) on Scope.REQUEST; consumers must explicitly declare `{ scope: Scope.REQUEST }` or use ambient RequestContext/ClsService. Includes OnRequestDestroy cleanup.",
  },
});

export interface ConformanceSuiteMeta {
  /** Upstream path relative to nestjs/nest repo root, e.g. "integration/scopes/e2e/request-scope.spec.ts" */
  readonly upstreamPath: string;
  readonly category: ConformanceCategory;
  readonly adrs?: readonly AdrId[];
  readonly notes?: string;
}

export interface RegisteredConformanceSuite extends ConformanceSuiteMeta {
  readonly suiteName: string;
  readonly formattedTitle: string;
}

const registeredSuites: RegisteredConformanceSuite[] = [];

function normalizeAdrList(adr: AdrId | readonly AdrId[]): readonly AdrId[] {
  return typeof adr === "string" ? [adr] : adr;
}

/**
 * Returns the canonical ADR specification entry for a Bunest ADR ID.
 */
export function getAdrInfo(adr: AdrId): AdrEntry {
  return BUNEST_ADRS[adr];
}

/**
 * Formats a standardized ADR tag for test descriptions, e.g. `[ADR-008]` or
 * `[ADR-009: strict ValidationPipe defaults]`.
 */
export function adrTag(adr: AdrId | readonly AdrId[], detail?: string): string {
  const list = normalizeAdrList(adr);
  const ids = list.join(", ");
  return detail && detail.trim().length > 0
    ? `[${ids}: ${detail.trim()}]`
    : `[${ids}]`;
}

/**
 * Formats a test or suite title with optional ADR divergence metadata.
 */
export function conformanceTitle(
  title: string,
  adr?: AdrId | readonly AdrId[],
  note?: string,
): string {
  if (!adr || (Array.isArray(adr) && adr.length === 0)) {
    return note && note.trim().length > 0 ? `${title} (${note.trim()})` : title;
  }
  return `${title} ${adrTag(adr, note)}`;
}

/**
 * Shorthand for naming an intentionally adapted test case with its governing ADR(s).
 */
export function adaptedTitle(
  adr: AdrId | readonly AdrId[],
  title: string,
  note?: string,
): string {
  return conformanceTitle(title, adr, note);
}

/**
 * Wraps `bun:test`'s `describe()` to register conformance suite metadata and
 * format suite titles consistently with upstream path and ADR tags.
 */
export function describeConformance(
  suiteName: string,
  meta: ConformanceSuiteMeta,
  fn: () => void,
): void {
  const formattedTitle =
    meta.adrs && meta.adrs.length > 0
      ? `${suiteName} ${adrTag(meta.adrs)}`
      : suiteName;

  registeredSuites.push({
    suiteName,
    formattedTitle,
    upstreamPath: meta.upstreamPath,
    category: meta.category,
    adrs: meta.adrs ? [...meta.adrs] : undefined,
    notes: meta.notes,
  });

  describe(formattedTitle, fn);
}

/**
 * Wraps `bun:test`'s `it()` for a single test adapted to an intentional Bunest ADR divergence.
 */
export function itAdapted(
  adr: AdrId | readonly AdrId[],
  title: string,
  fn: () => void | Promise<void>,
  noteOrTimeout?: string | number,
  timeout?: number,
): void {
  const note = typeof noteOrTimeout === "string" ? noteOrTimeout : undefined;
  const effectiveTimeout =
    typeof noteOrTimeout === "number" ? noteOrTimeout : timeout;
  const formatted = conformanceTitle(title, adr, note);

  if (effectiveTimeout !== undefined) {
    it(formatted, fn, effectiveTimeout);
  } else {
    it(formatted, fn);
  }
}

/**
 * Returns a snapshot of all suites registered via `describeConformance()`.
 */
export function getRegisteredConformanceSuites(): readonly RegisteredConformanceSuite[] {
  return [...registeredSuites];
}

/**
 * Clears the in-memory suite registry (primarily for harness self-tests).
 */
export function clearRegisteredConformanceSuites(): void {
  registeredSuites.length = 0;
}

/**
 * ADR-012 assertion helper: verifies that an action fails fast with
 * `ScopeLeakException` instead of NestJS-style silent scope bubbling.
 */
export async function expectScopeLeak(
  action: () => unknown | Promise<unknown>,
  expectedPattern?: string | RegExp,
): Promise<ScopeLeakException> {
  let caught: unknown;
  try {
    await action();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(ScopeLeakException);
  const leakErr = caught as ScopeLeakException;

  if (expectedPattern !== undefined) {
    if (typeof expectedPattern === "string") {
      expect(leakErr.message).toContain(expectedPattern);
    } else {
      expect(leakErr.message).toMatch(expectedPattern);
    }
  }

  return leakErr;
}

export interface ValidationEnvelopeExpectation {
  readonly statusCode?: number;
  readonly message?: string;
  readonly fields?: readonly string[];
}

/**
 * ADR-009 assertion helper: validates Bunest's default normalized validation error
 * JSON envelope `{ statusCode, error, message: "Validation failed", details }`.
 */
export function expectValidationErrorEnvelope(
  body: unknown,
  options: ValidationEnvelopeExpectation = {},
): ValidationErrorResponse {
  expect(body).toBeObject();
  const payload = body as Partial<ValidationErrorResponse>;

  expect(payload.statusCode).toBe(options.statusCode ?? 400);
  expect(typeof payload.error).toBe("string");
  expect(payload.message).toBe(options.message ?? "Validation failed");
  expect(Array.isArray(payload.details)).toBe(true);
  expect((payload.details ?? []).length).toBeGreaterThan(0);

  for (const detail of payload.details ?? []) {
    expect(typeof detail.field).toBe("string");
    expect(detail.constraints).toBeObject();
    expect(Array.isArray(detail.messages)).toBe(true);
    expect(detail.messages.length).toBeGreaterThan(0);
  }

  if (options.fields && options.fields.length > 0) {
    const actualFields = (payload.details ?? []).map((d) => d.field);
    for (const expectedField of options.fields) {
      expect(actualFields).toContain(expectedField);
    }
  }

  return payload as ValidationErrorResponse;
}

export interface NestValidationEnvelopeExpectation {
  readonly statusCode?: number;
  readonly error?: string;
  readonly messageIncludes?: readonly (string | RegExp)[];
}

export interface NestValidationErrorResponse {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string[];
}

/**
 * Assertion helper for NestJS `"list"` validation error envelopes produced by
 * `nestCompatibleValidationPipe()` / `new ValidationPipe({ errorFormat: "list" })`.
 */
export function expectNestValidationErrorEnvelope(
  body: unknown,
  options: NestValidationEnvelopeExpectation = {},
): NestValidationErrorResponse {
  expect(body).toBeObject();
  const payload = body as Partial<NestValidationErrorResponse>;

  expect(payload.statusCode).toBe(options.statusCode ?? 400);
  expect(payload.error).toBe(options.error ?? "Bad Request");
  expect(Array.isArray(payload.message)).toBe(true);
  expect((payload.message ?? []).length).toBeGreaterThan(0);

  if (options.messageIncludes) {
    const messages = payload.message ?? [];
    for (const matcher of options.messageIncludes) {
      const matched = messages.some((m) =>
        typeof matcher === "string" ? m.includes(matcher) : matcher.test(m),
      );
      expect(matched).toBe(true);
    }
  }

  return payload as NestValidationErrorResponse;
}
