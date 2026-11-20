import type { ExecutionContext } from "@bunest/common";
import { DEFAULT_KEY_FIELD } from "../idempotency.constants";
import type { IdempotencyStoredResponse } from "../interfaces/idempotency-store.interface";
import { decodeResult } from "../utils/result.util";
import {
  captureHttpOrUnknownError,
  getHeaderFromRequest,
  pick,
  rebuildHttpException,
  successCapture,
  tryOptionalImport,
  unsupportedSource,
  type CallDescription,
  type Capture,
  type CaptureOptions,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from "./context.adapter";

interface GraphQLModuleLike {
  GraphQLError: new (
    message: string,
    options?: { extensions?: Record<string, unknown> },
  ) => Error & { extensions?: Record<string, unknown> };
}

class FallbackGraphQLError extends Error {
  readonly extensions: Record<string, unknown>;

  constructor(
    message: string,
    options?: { extensions?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "GraphQLError";
    this.extensions = options?.extensions ?? {};
  }
}

interface PathNode {
  key: string | number;
  prev?: PathNode;
}

/** `a.b.0.c` from graphql-js' linked-list `info.path` (response keys/aliases). */
function fieldPath(path: PathNode | undefined): string {
  const keys: Array<string | number> = [];
  for (let p = path; p; p = p.prev) {
    keys.unshift(p.key);
  }
  return keys.join(".");
}

function isGraphQLErrorLike(
  error: unknown,
  gqlMod: GraphQLModuleLike | undefined,
): error is Error & { extensions?: Record<string, unknown> } {
  if (gqlMod && error instanceof gqlMod.GraphQLError) {
    return true;
  }
  return (
    error instanceof Error &&
    error.name === "GraphQLError" &&
    "extensions" in error
  );
}

/**
 * GraphQL resolvers (`@Mutation()` + `@Idempotent()`). Idempotency is per
 * *field*: each idempotent mutation in an operation gets its own record at
 * `<scope>:<key>:<fieldPath>`, where the field path uses the response key
 * (alias), so `a: pay(...)` and `b: pay(...)` sharing one header key are
 * two separate, individually replayable records.
 *
 * `graphql` is loaded lazily so it stays optional with zero hard dependency.
 */
export class GraphqlContextAdapter implements IdempotencyContextAdapter {
  readonly type = "graphql" as const;
  private graphql?: GraphQLModuleLike;
  private prepared = false;

  async prepare(): Promise<void> {
    if (this.prepared) {
      return;
    }
    this.prepared = true;
    this.graphql = await tryOptionalImport<GraphQLModuleLike>("graphql");
  }

  private args(context: ExecutionContext): [any, any, any, any] {
    return context.getArgs<[any, any, any, any]>();
  }

  /** Root mutation fields only: not queries, not nested field resolvers. */
  coveredByClass(context: ExecutionContext): boolean {
    const info = this.args(context)[3];
    const mutation = info?.schema?.getMutationType?.();
    return Boolean(mutation && info?.parentType?.name === mutation.name);
  }

  userLocation(context: ExecutionContext): string | undefined {
    return this.args(context)[2]?.req?.user ? "context.req.user" : undefined;
  }

  readKey(
    context: ExecutionContext,
    source: DeclarativeKeySource,
    header: string,
  ): unknown {
    const [, args, gqlContext] = this.args(context);
    const req = gqlContext?.req;
    if (source === "default") {
      const arg = pick(args, DEFAULT_KEY_FIELD);
      return arg === undefined || arg === null || arg === ""
        ? getHeaderFromRequest(req, header)
        : arg;
    }
    if ("header" in source) {
      return getHeaderFromRequest(req, source.header);
    }
    if ("arg" in source) {
      return pick(args, source.arg);
    }
    throw unsupportedSource(this.type, source);
  }

  target(context: ExecutionContext): unknown {
    return this.args(context)[2]?.req;
  }

  keySuffix(context: ExecutionContext): string | undefined {
    return fieldPath(this.args(context)[3]?.path) || undefined;
  }

  describe(context: ExecutionContext): CallDescription {
    const [, args, , info] = this.args(context);
    return {
      identity: ["graphql", `${info?.parentType?.name}.${info?.fieldName}`],
      payload: args ?? {},
    };
  }

  captureSuccess(
    _context: ExecutionContext,
    value: unknown,
    opts: CaptureOptions,
  ): Capture {
    // Strict: GraphQL awaits promises and calls functions it finds in the
    // result, so a result holding any can't be replayed from a copy.
    return successCapture(value, opts, { strict: true });
  }

  captureError(
    error: unknown,
    opts: CaptureOptions,
  ): IdempotencyStoredResponse | null {
    if (isGraphQLErrorLike(error, this.graphql)) {
      const ext = (error.extensions ?? {}) as Record<string, any>;
      // A code other than INTERNAL_SERVER_ERROR marks a deliberate rejection.
      const deliberate =
        typeof ext.code === "string" && ext.code !== "INTERNAL_SERVER_ERROR";
      const status: number =
        typeof ext.http?.status === "number"
          ? ext.http.status
          : deliberate
            ? 400
            : 500;
      if (!opts.storeIf(status, error)) {
        return null;
      }
      return {
        status,
        headers: {},
        body: JSON.parse(
          JSON.stringify({ message: error.message, extensions: ext }),
        ),
        error: "graphql",
      };
    }
    return captureHttpOrUnknownError(error, opts);
  }

  replay(
    _context: ExecutionContext,
    stored: IdempotencyStoredResponse,
  ): unknown {
    if (stored.error === "graphql") {
      const body = stored.body as {
        message: string;
        extensions?: Record<string, unknown>;
      };
      const ErrorCtor = this.graphql?.GraphQLError ?? FallbackGraphQLError;
      throw new ErrorCtor(body.message, { extensions: body.extensions });
    }
    if (stored.error) {
      throw rebuildHttpException(stored);
    }
    return decodeResult(stored.body);
  }

  reject(_context: ExecutionContext, rejection: IdempotencyRejection): Error {
    const ErrorCtor = this.graphql?.GraphQLError ?? FallbackGraphQLError;
    return new ErrorCtor(rejection.message, {
      extensions: {
        code: rejection.code,
        httpStatus: rejection.status,
        ...(rejection.retryAfter !== undefined && {
          retryAfter: rejection.retryAfter,
        }),
      },
    });
  }
}
