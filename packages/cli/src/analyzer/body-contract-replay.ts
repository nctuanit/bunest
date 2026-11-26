export type ReplayVerdict =
  | "confirmed-breaking"
  | "stripped-accepted"
  | "no-http-change"
  | "environment-error";

export interface ReplayPipeProfile {
  readonly applied?: boolean;
  readonly whitelist?: boolean;
  readonly forbidNonWhitelisted?: boolean;
  readonly transform?: boolean;
  readonly errorFormat?: "bunest" | "list" | "grouped";
  readonly label?: string;
}

export type ReplayFetchHandler = (
  request: Request,
) => Promise<Response> | Response;

export interface ReplayTargetInstance {
  readonly fetch: ReplayFetchHandler;
  readonly close?: () => Promise<void> | void;
  readonly baseUrl?: string;
}

export type ReplayTargetFactory = () =>
  | Promise<ReplayTargetInstance>
  | ReplayTargetInstance;

export type ReplayTargetApp =
  | string
  | ReplayFetchHandler
  | ReplayTargetInstance
  | ReplayTargetFactory
  | {
      readonly baseUrl: string;
      readonly fetch?: ReplayFetchHandler;
      readonly close?: () => Promise<void> | void;
    }
  | {
      readonly factory: ReplayTargetFactory;
    };

export interface ReplayCandidate {
  readonly method: string;
  readonly path: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetField: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly label?: string;
}

export interface ReplayEvidenceRecord {
  readonly method: string;
  readonly path: string;
  readonly targetField: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly baseStatus: number | null;
  readonly headStatus: number | null;
  readonly baseErrorFields: readonly string[];
  readonly headErrorFields: readonly string[];
  readonly strippedFields: readonly string[];
  readonly baseBody?: unknown;
  readonly headBody?: unknown;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly pipeProfile: ReplayPipeProfile;
  readonly verdict: ReplayVerdict;
  readonly reason: string;
  readonly environmentError?: string;
  readonly label?: string;
}

export interface ReplayBodyContractOptions {
  readonly base: ReplayTargetApp;
  readonly head: ReplayTargetApp;
  readonly candidates: readonly ReplayCandidate[];
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly pipeProfile?: ReplayPipeProfile;
  /**
   * When `base` or `head` is provided as a factory, create a fresh isolated
   * target instance per candidate by default so database/seed state never leaks
   * across candidates.
   * @default true
   */
  readonly isolatePerCandidate?: boolean;
  /**
   * Include raw parsed `baseBody` and `headBody` in each evidence record.
   * Disabled by default so evidence records contain only deterministic summary
   * data without volatile fields such as server timestamps.
   * @default false
   */
  readonly includeBodies?: boolean;
  readonly timeoutMs?: number;
}

interface ResolvedTarget {
  readonly fetch: ReplayFetchHandler;
  readonly baseUrl: string;
  readonly close?: () => Promise<void> | void;
  readonly ownsLifecycle: boolean;
}

interface SingleReplayResponse {
  readonly status: number;
  readonly body: unknown;
  readonly errorFields: readonly string[];
}

const DEFAULT_IN_PROCESS_BASE_URL = "http://bunest.replay.local";
const NON_WHITELISTED_MESSAGE_REGEX = /^property\s+([^\s]+)\s+should not exist/i;
const FIELD_PREFIX_MESSAGE_REGEX = /^([A-Za-z_$][A-Za-z0-9_$.[\]]*)\s+/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function is2xx(status: number | null): status is number {
  return typeof status === "number" && status >= 200 && status < 300;
}

function isValidationFailureStatus(status: number | null): boolean {
  return status === 400 || status === 422;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function buildRequestUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function isTargetFactory(target: ReplayTargetApp): target is ReplayTargetFactory {
  return typeof target === "function" && target.length === 0;
}

async function resolveTarget(target: ReplayTargetApp): Promise<ResolvedTarget> {
  if (typeof target === "string") {
    return {
      fetch: (req: Request) => fetch(req),
      baseUrl: normalizeBaseUrl(target),
      ownsLifecycle: false,
    };
  }

  if (typeof target === "function") {
    if (isTargetFactory(target)) {
      const instance = await target();
      if (!instance || typeof instance.fetch !== "function") {
        throw new Error(
          "Replay target factory must return an object with a `fetch(request)` function.",
        );
      }
      return {
        fetch: instance.fetch,
        baseUrl: normalizeBaseUrl(
          instance.baseUrl ?? DEFAULT_IN_PROCESS_BASE_URL,
        ),
        close: instance.close,
        ownsLifecycle: true,
      };
    }

    return {
      fetch: target,
      baseUrl: DEFAULT_IN_PROCESS_BASE_URL,
      ownsLifecycle: false,
    };
  }

  if ("factory" in target && typeof target.factory === "function") {
    const instance = await target.factory();
    if (!instance || typeof instance.fetch !== "function") {
      throw new Error(
        "Replay target factory must return an object with a `fetch(request)` function.",
      );
    }
    return {
      fetch: instance.fetch,
      baseUrl: normalizeBaseUrl(
        instance.baseUrl ?? DEFAULT_IN_PROCESS_BASE_URL,
      ),
      close: instance.close,
      ownsLifecycle: true,
    };
  }

  if ("fetch" in target && typeof target.fetch === "function") {
    return {
      fetch: target.fetch,
      baseUrl: normalizeBaseUrl(
        target.baseUrl ?? DEFAULT_IN_PROCESS_BASE_URL,
      ),
      close: target.close,
      ownsLifecycle: false,
    };
  }

  if ("baseUrl" in target && typeof target.baseUrl === "string") {
    return {
      fetch: (req: Request) => fetch(req),
      baseUrl: normalizeBaseUrl(target.baseUrl),
      close: target.close,
      ownsLifecycle: false,
    };
  }

  throw new Error(
    "Invalid ReplayTargetApp: expected a base URL string, fetch handler, { fetch, close } instance, or factory.",
  );
}

async function safeCloseTarget(target: ResolvedTarget | undefined): Promise<void> {
  if (!target || !target.ownsLifecycle || !target.close) {
    return;
  }
  await target.close();
}

/**
 * Extracts failing field names from Bunest's `ValidationPipe` error responses
 * across all built-in formats:
 * - `"bunest"` (default): `{ details: [{ field, constraints, messages }] }`
 * - `"grouped"` (NestJS v12): `{ message: { [field]: string[] } }`
 * - `"list"` (NestJS default): `{ message: string[] }`
 */
export function extractValidationErrorFields(body: unknown): string[] {
  if (!isPlainRecord(body)) {
    return [];
  }

  const fields = new Set<string>();

  // 1. Bunest default format: details: [{ field, constraints, messages }]
  const details = body.details;
  if (Array.isArray(details)) {
    for (const item of details) {
      if (
        isPlainRecord(item) &&
        typeof item.field === "string" &&
        item.field.trim().length > 0
      ) {
        fields.add(item.field.trim());
      }
    }
  }

  // 2. NestJS v12 grouped format: message: { [field]: string[] }
  const message = body.message;
  if (isPlainRecord(message)) {
    for (const [key, value] of Object.entries(message)) {
      if (key === "..." || key.trim().length === 0) {
        continue;
      }
      if (Array.isArray(value) || typeof value === "string") {
        fields.add(key.trim());
      }
    }
  }

  // 3. NestJS flat list format: message: string[]
  if (Array.isArray(message)) {
    for (const entry of message) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      const nonWhitelisted = NON_WHITELISTED_MESSAGE_REGEX.exec(trimmed);
      if (nonWhitelisted?.[1]) {
        fields.add(nonWhitelisted[1]);
        continue;
      }
      const prefix = FIELD_PREFIX_MESSAGE_REGEX.exec(trimmed);
      if (prefix?.[1]) {
        fields.add(prefix[1]);
      }
    }
  }

  return Array.from(fields);
}

function fieldMatchesTarget(errorField: string, targetField: string): boolean {
  return (
    errorField === targetField ||
    errorField.startsWith(`${targetField}.`) ||
    errorField.startsWith(`${targetField}[`)
  );
}

function findFieldValueInResponse(
  body: unknown,
  field: string,
  maxDepth = 3,
): { readonly found: boolean; readonly value: unknown } {
  if (maxDepth < 0 || typeof body !== "object" || body === null) {
    return { found: false, value: undefined };
  }

  if (Array.isArray(body)) {
    return { found: false, value: undefined };
  }

  const record = body as Record<string, unknown>;
  if (Object.hasOwn(record, field)) {
    return { found: true, value: record[field] };
  }

  if (maxDepth === 0) {
    return { found: false, value: undefined };
  }

  for (const key of Object.keys(record)) {
    const child = record[key];
    if (isPlainRecord(child)) {
      const nested = findFieldValueInResponse(child, field, maxDepth - 1);
      if (nested.found) {
        return nested;
      }
    }
  }

  return { found: false, value: undefined };
}

function wasTargetFieldStripped(
  payload: Readonly<Record<string, unknown>>,
  targetField: string,
  baseBody: unknown,
  headBody: unknown,
): boolean {
  if (!Object.hasOwn(payload, targetField)) {
    return false;
  }

  const sentValue = payload[targetField];
  const baseMatch = findFieldValueInResponse(baseBody, targetField);
  const headMatch = findFieldValueInResponse(headBody, targetField);

  if (!baseMatch.found || baseMatch.value === undefined) {
    return false;
  }

  if (!headMatch.found || headMatch.value === undefined) {
    return true;
  }

  if (
    sentValue !== null &&
    sentValue !== undefined &&
    baseMatch.value !== null &&
    headMatch.value === null
  ) {
    return true;
  }

  return false;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function executeSingleRequest(
  target: ResolvedTarget,
  candidate: ReplayCandidate,
  timeoutMs?: number,
): Promise<SingleReplayResponse> {
  const method = candidate.method.toUpperCase();
  const url = buildRequestUrl(target.baseUrl, candidate.path);
  const headers = new Headers(candidate.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const init: RequestInit = {
    method,
    headers,
    body: JSON.stringify(candidate.payload),
  };
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }

  const request = new Request(url, init);
  const response = await target.fetch(request);
  const body = await parseResponseBody(response);
  const errorFields = isValidationFailureStatus(response.status)
    ? extractValidationErrorFields(body)
    : [];

  return {
    status: response.status,
    body,
    errorFields,
  };
}

function classifyResponses(
  candidate: ReplayCandidate,
  baseRes: SingleReplayResponse,
  headRes: SingleReplayResponse,
): {
  readonly verdict: ReplayVerdict;
  readonly reason: string;
  readonly environmentError?: string;
} {
  // 1. 5xx server/DB/runtime errors are NEVER classified as validation failures.
  if (baseRes.status >= 500 || headRes.status >= 500) {
    const detail = `Server error during replay (base ${baseRes.status}, head ${headRes.status})`;
    return {
      verdict: "environment-error",
      reason: detail,
      environmentError: detail,
    };
  }

  // 2. Base 2xx -> Head 400/422: check if validation failed on targetField.
  if (is2xx(baseRes.status) && isValidationFailureStatus(headRes.status)) {
    const matchedTarget = headRes.errorFields.some((f) =>
      fieldMatchesTarget(f, candidate.targetField),
    );
    if (matchedTarget) {
      return {
        verdict: "confirmed-breaking",
        reason: `Base accepted (${baseRes.status}) while head rejected (${headRes.status}) on "${candidate.targetField}".`,
      };
    }

    if (headRes.errorFields.length > 0) {
      const detail = `Head rejected (${headRes.status}) on unrelated field(s) [${headRes.errorFields.join(", ")}] instead of "${candidate.targetField}".`;
      return {
        verdict: "environment-error",
        reason: detail,
        environmentError: detail,
      };
    }

    return {
      verdict: "confirmed-breaking",
      reason: `Base accepted (${baseRes.status}) while head rejected (${headRes.status}) with validation error messages disabled.`,
    };
  }

  // 3. Both 2xx: distinguish silent stripping from genuine no-http-change.
  if (is2xx(baseRes.status) && is2xx(headRes.status)) {
    if (
      wasTargetFieldStripped(
        candidate.payload,
        candidate.targetField,
        baseRes.body,
        headRes.body,
      )
    ) {
      return {
        verdict: "stripped-accepted",
        reason: `Both base (${baseRes.status}) and head (${headRes.status}) succeeded, but "${candidate.targetField}" was silently stripped in head.`,
      };
    }

    return {
      verdict: "no-http-change",
      reason: `Both base (${baseRes.status}) and head (${headRes.status}) accepted the payload without stripping "${candidate.targetField}".`,
    };
  }

  // 4. Relaxed constraint: base rejected on targetField (400/422) -> head accepted (2xx).
  if (isValidationFailureStatus(baseRes.status) && is2xx(headRes.status)) {
    return {
      verdict: "no-http-change",
      reason: `Constraint relaxed: base rejected (${baseRes.status}) while head accepted (${headRes.status}) for "${candidate.targetField}".`,
    };
  }

  // 5. Same 4xx status on both base and head: no breaking change introduced by head.
  if (
    isValidationFailureStatus(baseRes.status) &&
    isValidationFailureStatus(headRes.status)
  ) {
    return {
      verdict: "no-http-change",
      reason: `Both base (${baseRes.status}) and head (${headRes.status}) rejected the payload.`,
    };
  }

  // 6. Unexpected non-validation status (e.g. 404 route missing, 401/403 setup mismatch).
  const detail = `Unexpected HTTP status pair (base ${baseRes.status}, head ${headRes.status}) for ${candidate.method.toUpperCase()} ${candidate.path}.`;
  return {
    verdict: "environment-error",
    reason: detail,
    environmentError: detail,
  };
}

function isFactoryApp(target: ReplayTargetApp): boolean {
  if (typeof target === "function") {
    return target.length === 0;
  }
  return (
    typeof target === "object" &&
    target !== null &&
    "factory" in target &&
    typeof target.factory === "function"
  );
}

/**
 * Replays candidate JSON body payloads against both `base` and `head` targets,
 * returning structured, deterministic evidence records that separate:
 * - `confirmed-breaking`: base 2xx -> head 400 on `targetField`
 * - `stripped-accepted`: both 2xx, but `targetField` was silently stripped in head
 * - `no-http-change`: both accept (or constraint relaxed / pipe not applied)
 * - `environment-error`: bootstrap crash, DB failure, 5xx, or network error
 */
export async function replayBodyContractCandidates(
  options: ReplayBodyContractOptions,
): Promise<ReplayEvidenceRecord[]> {
  const {
    base,
    head,
    candidates,
    baseCommit = null,
    headCommit = null,
    pipeProfile = {},
    isolatePerCandidate = true,
    includeBodies = false,
    timeoutMs,
  } = options;

  const shouldIsolateBase = isolatePerCandidate && isFactoryApp(base);
  const shouldIsolateHead = isolatePerCandidate && isFactoryApp(head);

  let sharedBase: ResolvedTarget | undefined;
  let sharedHead: ResolvedTarget | undefined;
  let sharedBaseError: string | undefined;
  let sharedHeadError: string | undefined;

  if (!shouldIsolateBase) {
    try {
      sharedBase = await resolveTarget(base);
    } catch (err) {
      sharedBaseError = `Base target bootstrap failed: ${formatErrorMessage(err)}`;
    }
  }

  if (!shouldIsolateHead) {
    try {
      sharedHead = await resolveTarget(head);
    } catch (err) {
      sharedHeadError = `Head target bootstrap failed: ${formatErrorMessage(err)}`;
    }
  }

  const results: ReplayEvidenceRecord[] = [];

  try {
    for (const candidate of candidates) {
      const normalizedMethod = candidate.method.toUpperCase();
      let candidateBase: ResolvedTarget | undefined = sharedBase;
      let candidateHead: ResolvedTarget | undefined = sharedHead;
      let baseRes: SingleReplayResponse | undefined;
      let headRes: SingleReplayResponse | undefined;
      let envError: string | undefined;

      try {
        if (shouldIsolateBase) {
          try {
            candidateBase = await resolveTarget(base);
          } catch (err) {
            envError = `Base target bootstrap failed: ${formatErrorMessage(err)}`;
          }
        } else if (sharedBaseError) {
          envError = sharedBaseError;
        }

        if (!envError) {
          if (shouldIsolateHead) {
            try {
              candidateHead = await resolveTarget(head);
            } catch (err) {
              envError = `Head target bootstrap failed: ${formatErrorMessage(err)}`;
            }
          } else if (sharedHeadError) {
            envError = sharedHeadError;
          }
        }

        if (!envError && candidateBase && candidateHead) {
          try {
            baseRes = await executeSingleRequest(
              candidateBase,
              candidate,
              timeoutMs,
            );
          } catch (err) {
            envError = `Base request failed: ${formatErrorMessage(err)}`;
          }
        }

        if (!envError && candidateHead) {
          try {
            headRes = await executeSingleRequest(
              candidateHead,
              candidate,
              timeoutMs,
            );
          } catch (err) {
            envError = `Head request failed: ${formatErrorMessage(err)}`;
          }
        }
      } finally {
        if (shouldIsolateBase && candidateBase) {
          try {
            await safeCloseTarget(candidateBase);
          } catch (err) {
            envError ??= `Base target close failed: ${formatErrorMessage(err)}`;
          }
        }
        if (shouldIsolateHead && candidateHead) {
          try {
            await safeCloseTarget(candidateHead);
          } catch (err) {
            envError ??= `Head target close failed: ${formatErrorMessage(err)}`;
          }
        }
      }

      if (envError || !baseRes || !headRes) {
        const message = envError ?? "Unknown replay environment failure.";
        results.push({
          method: normalizedMethod,
          path: candidate.path,
          targetField: candidate.targetField,
          payload: candidate.payload,
          baseStatus: baseRes?.status ?? null,
          headStatus: headRes?.status ?? null,
          baseErrorFields: baseRes?.errorFields ?? [],
          headErrorFields: headRes?.errorFields ?? [],
          strippedFields: [],
          ...(includeBodies && baseRes?.body !== undefined
            ? { baseBody: baseRes.body }
            : {}),
          ...(includeBodies && headRes?.body !== undefined
            ? { headBody: headRes.body }
            : {}),
          baseCommit,
          headCommit,
          pipeProfile,
          verdict: "environment-error",
          reason: message,
          environmentError: message,
          ...(candidate.label !== undefined ? { label: candidate.label } : {}),
        });
        continue;
      }

      const classified = classifyResponses(candidate, baseRes, headRes);
      results.push({
        method: normalizedMethod,
        path: candidate.path,
        targetField: candidate.targetField,
        payload: candidate.payload,
        baseStatus: baseRes.status,
        headStatus: headRes.status,
        baseErrorFields: baseRes.errorFields,
        headErrorFields: headRes.errorFields,
        strippedFields:
          classified.verdict === "stripped-accepted"
            ? [candidate.targetField]
            : [],
        ...(includeBodies && baseRes.body !== undefined
          ? { baseBody: baseRes.body }
          : {}),
        ...(includeBodies && headRes.body !== undefined
          ? { headBody: headRes.body }
          : {}),
        baseCommit,
        headCommit,
        pipeProfile,
        verdict: classified.verdict,
        reason: classified.reason,
        ...(classified.environmentError !== undefined
          ? { environmentError: classified.environmentError }
          : {}),
        ...(candidate.label !== undefined ? { label: candidate.label } : {}),
      });
    }
  } finally {
    if (!shouldIsolateBase && sharedBase) {
      await safeCloseTarget(sharedBase).catch(() => undefined);
    }
    if (!shouldIsolateHead && sharedHead) {
      await safeCloseTarget(sharedHead).catch(() => undefined);
    }
  }

  return results;
}
