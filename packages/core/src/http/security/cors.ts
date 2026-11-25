import type { CorsOptions, CorsOrigin } from "../../common/index";

export type CorsOptionsDelegate = (
  req: Request,
  callback: (err: Error | null, options?: CorsOptions) => void,
) => void;

export interface NormalizedCorsOptions {
  readonly origin: CorsOrigin;
  readonly methods?: string;
  readonly allowedHeaders?: string;
  readonly exposedHeaders?: string;
  readonly credentials: boolean;
  readonly maxAge?: number;
  readonly preflightContinue: boolean;
  readonly optionsSuccessStatus: number;
  readonly delegate?: CorsOptionsDelegate;
}

export interface CorsEvaluationResult {
  readonly headers: Headers;
  readonly isPreflight: boolean;
  readonly originAllowed: boolean;
  readonly resolvedOptions?: NormalizedCorsOptions;
}

const DEFAULT_CORS_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

function joinHeaderList(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return value;
}

export function normalizeCorsOptions(
  cors: boolean | CorsOptions | CorsOptionsDelegate | undefined,
): NormalizedCorsOptions | undefined {
  if (!cors) {
    return undefined;
  }

  if (typeof cors === "function") {
    return {
      origin: "*",
      credentials: false,
      preflightContinue: false,
      optionsSuccessStatus: 204,
      delegate: cors,
    };
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

async function resolveCorsDelegate(
  delegate: CorsOptionsDelegate,
  req: Request,
): Promise<NormalizedCorsOptions | undefined> {
  const delegated = await new Promise<CorsOptions | boolean | undefined>(
    (resolve, reject) => {
      let settled = false;
      const done = (err: Error | null, opts?: CorsOptions | boolean) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve(opts);
        }
      };
      try {
        const ret = delegate(req, done) as unknown;
        if (
          ret &&
          typeof ret === "object" &&
          typeof (ret as PromiseLike<unknown>).then === "function"
        ) {
          (ret as PromiseLike<CorsOptions | boolean | undefined>).then(
            (val) => {
              if (!settled && val !== undefined) {
                done(null, val);
              }
            },
            (err) => done(err instanceof Error ? err : new Error(String(err))),
          );
        }
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    },
  );
  return normalizeCorsOptions(delegated);
}

/**
 * Evaluates CORS headers for both actual and preflight requests.
 */
export async function evaluateCors(
  req: Request,
  options: NormalizedCorsOptions,
  allowedMethodsFallback?: string,
): Promise<CorsEvaluationResult> {
  const isPreflight = isCorsPreflightRequest(req);
  let effectiveOptions = options;
  if (options.delegate) {
    const resolved = await resolveCorsDelegate(options.delegate, req);
    if (!resolved) {
      return {
        headers: new Headers(),
        isPreflight,
        originAllowed: false,
      };
    }
    effectiveOptions = resolved;
  }

  const headers = new Headers();
  const requestOrigin = req.headers.get("origin");

  const { value: allowedOrigin, varyOrigin } = await resolveAllowedOrigin(
    effectiveOptions.origin,
    requestOrigin,
    req,
    effectiveOptions.credentials,
  );

  if (varyOrigin) {
    appendVary(headers, "Origin");
  }

  const originAllowed = allowedOrigin !== null;
  if (allowedOrigin !== null) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    if (effectiveOptions.credentials && allowedOrigin !== "*") {
      headers.set("Access-Control-Allow-Credentials", "true");
    }
  }

  if (isPreflight) {
    if (originAllowed) {
      const methods =
        effectiveOptions.methods ??
        allowedMethodsFallback ??
        DEFAULT_CORS_METHODS;
      headers.set("Access-Control-Allow-Methods", methods);

      if (effectiveOptions.allowedHeaders !== undefined) {
        headers.set(
          "Access-Control-Allow-Headers",
          effectiveOptions.allowedHeaders,
        );
      } else {
        const requestedHeaders = req.headers.get(
          "access-control-request-headers",
        );
        if (requestedHeaders) {
          headers.set("Access-Control-Allow-Headers", requestedHeaders);
          appendVary(headers, "Access-Control-Request-Headers");
        }
      }

      if (effectiveOptions.maxAge !== undefined) {
        headers.set("Access-Control-Max-Age", String(effectiveOptions.maxAge));
      }
    }
  } else if (originAllowed && effectiveOptions.exposedHeaders) {
    headers.set(
      "Access-Control-Expose-Headers",
      effectiveOptions.exposedHeaders,
    );
  }

  return {
    headers,
    isPreflight,
    originAllowed,
    resolvedOptions: effectiveOptions,
  };
}

export function createPreflightResponse(
  result: CorsEvaluationResult,
  options: NormalizedCorsOptions,
): Response {
  const headers = new Headers(result.headers);
  headers.set("Content-Length", "0");
  return new Response(null, {
    status:
      result.resolvedOptions?.optionsSuccessStatus ??
      options.optionsSuccessStatus,
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
