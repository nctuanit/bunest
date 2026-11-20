import type { CorsOptions, CorsOrigin } from "@bunest/common";

export interface NormalizedCorsOptions {
  readonly origin: CorsOrigin;
  readonly methods?: string;
  readonly allowedHeaders?: string;
  readonly exposedHeaders?: string;
  readonly credentials: boolean;
  readonly maxAge?: number;
  readonly preflightContinue: boolean;
  readonly optionsSuccessStatus: number;
}

export interface CorsEvaluationResult {
  readonly headers: Headers;
  readonly isPreflight: boolean;
  readonly originAllowed: boolean;
}

const DEFAULT_CORS_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

function joinHeaderList(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return value;
}

export function normalizeCorsOptions(
  cors: boolean | CorsOptions | undefined,
): NormalizedCorsOptions | undefined {
  if (!cors) {
    return undefined;
  }

  if (cors === true) {
    return {
      origin: "*",
      credentials: false,
      preflightContinue: false,
      optionsSuccessStatus: 204,
    };
  }

  return {
    origin: cors.origin ?? "*",
    methods: joinHeaderList(cors.methods),
    allowedHeaders: joinHeaderList(cors.allowedHeaders),
    exposedHeaders: joinHeaderList(cors.exposedHeaders),
    credentials: cors.credentials ?? false,
    maxAge: cors.maxAge,
    preflightContinue: cors.preflightContinue ?? false,
    optionsSuccessStatus: cors.optionsSuccessStatus ?? 204,
  };
}

/**
 * Detects a CORS preflight request per Fetch spec / ADR-008:
 * `OPTIONS` + `Origin` + `Access-Control-Request-Method`.
 */
export function isCorsPreflightRequest(req: Request): boolean {
  return (
    req.method === "OPTIONS" &&
    req.headers.has("origin") &&
    req.headers.has("access-control-request-method")
  );
}

function appendVary(headers: Headers, token: string): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("Vary", token);
    return;
  }
  const existingTokens = existing
    .split(",")
    .map((item) => item.trim().toLowerCase());
  if (!existingTokens.includes(token.toLowerCase())) {
    headers.set("Vary", `${existing}, ${token}`);
  }
}

async function resolveAllowedOrigin(
  originOption: CorsOrigin,
  requestOrigin: string | null,
  req: Request,
  credentials: boolean,
): Promise<{ value: string | null; varyOrigin: boolean }> {
  if (originOption === false) {
    return { value: null, varyOrigin: false };
  }

  if (originOption === "*") {
    if (credentials) {
      // Fetch spec forbids pairing wildcard `*` with `Access-Control-Allow-Credentials: true`.
      return requestOrigin
        ? { value: requestOrigin, varyOrigin: true }
        : { value: null, varyOrigin: true };
    }
    return { value: "*", varyOrigin: false };
  }

  if (originOption === true) {
    if (requestOrigin) {
      return { value: requestOrigin, varyOrigin: true };
    }
    return credentials
      ? { value: null, varyOrigin: true }
      : { value: "*", varyOrigin: false };
  }

  if (typeof originOption === "string") {
    if (!requestOrigin) {
      return { value: originOption, varyOrigin: true };
    }
    return requestOrigin === originOption
      ? { value: originOption, varyOrigin: true }
      : { value: null, varyOrigin: true };
  }

  if (originOption instanceof RegExp) {
    if (requestOrigin && originOption.test(requestOrigin)) {
      return { value: requestOrigin, varyOrigin: true };
    }
    return { value: null, varyOrigin: true };
  }

  if (Array.isArray(originOption)) {
    if (!requestOrigin) {
      return { value: null, varyOrigin: true };
    }
    for (const rule of originOption) {
      if (typeof rule === "string") {
        if (rule === "*" && !credentials) {
          return { value: "*", varyOrigin: false };
        }
        if (rule === "*" || rule === requestOrigin) {
          return { value: requestOrigin, varyOrigin: true };
        }
      } else if (rule instanceof RegExp && rule.test(requestOrigin)) {
        return { value: requestOrigin, varyOrigin: true };
      }
    }
    return { value: null, varyOrigin: true };
  }

  if (typeof originOption === "function") {
    const decision = await originOption(requestOrigin, req);
    if (typeof decision === "string") {
      return { value: decision, varyOrigin: true };
    }
    if (decision === true && requestOrigin) {
      return { value: requestOrigin, varyOrigin: true };
    }
    return { value: null, varyOrigin: true };
  }

  return { value: null, varyOrigin: false };
}

/**
 * Evaluates CORS headers for both actual and preflight requests.
 */
export async function evaluateCors(
  req: Request,
  options: NormalizedCorsOptions,
  allowedMethodsFallback?: string,
): Promise<CorsEvaluationResult> {
  const headers = new Headers();
  const requestOrigin = req.headers.get("origin");
  const isPreflight = isCorsPreflightRequest(req);

  const { value: allowedOrigin, varyOrigin } = await resolveAllowedOrigin(
    options.origin,
    requestOrigin,
    req,
    options.credentials,
  );

  if (varyOrigin) {
    appendVary(headers, "Origin");
  }

  const originAllowed = allowedOrigin !== null;
  if (allowedOrigin !== null) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    if (options.credentials && allowedOrigin !== "*") {
      headers.set("Access-Control-Allow-Credentials", "true");
    }
  }

  if (isPreflight) {
    if (originAllowed) {
      const methods =
        options.methods ?? allowedMethodsFallback ?? DEFAULT_CORS_METHODS;
      headers.set("Access-Control-Allow-Methods", methods);

      if (options.allowedHeaders !== undefined) {
        headers.set("Access-Control-Allow-Headers", options.allowedHeaders);
      } else {
        const requestedHeaders = req.headers.get(
          "access-control-request-headers",
        );
        if (requestedHeaders) {
          headers.set("Access-Control-Allow-Headers", requestedHeaders);
          appendVary(headers, "Access-Control-Request-Headers");
        }
      }

      if (options.maxAge !== undefined) {
        headers.set("Access-Control-Max-Age", String(options.maxAge));
      }
    }
  } else if (originAllowed && options.exposedHeaders) {
    headers.set("Access-Control-Expose-Headers", options.exposedHeaders);
  }

  return { headers, isPreflight, originAllowed };
}

export function createPreflightResponse(
  result: CorsEvaluationResult,
  options: NormalizedCorsOptions,
): Response {
  const headers = new Headers(result.headers);
  headers.set("Content-Length", "0");
  return new Response(null, {
    status: options.optionsSuccessStatus,
    headers,
  });
}

/**
 * Merges CORS headers onto `target` without clobbering explicit headers
 * already set on `target`, while safely merging `Vary` tokens.
 */
export function mergeCorsHeaders(target: Headers, corsHeaders: Headers): void {
  corsHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "vary") {
      for (const token of value.split(",")) {
        const trimmed = token.trim();
        if (trimmed) {
          appendVary(target, trimmed);
        }
      }
      return;
    }
    if (!target.has(key)) {
      target.set(key, value);
    }
  });
}
