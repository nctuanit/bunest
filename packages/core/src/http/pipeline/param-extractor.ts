import {
  BadRequestException,
  HttpStatus,
  StandardSchemaValidationPipe,
  type ArgumentMetadata,
  type ExecutionContext,
  type ParameterMetadata,
  type ParameterSource,
  type Paramtype,
  type PipeLike,
  type PipeTransform,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type ValidationErrorDetail,
} from "../../common/index";
import type { RequestContext } from "../context/request-context";
import { HttpResponseContext } from "../context/response-context";
import { isDangerousKey } from "../security/prototype-sanitizer";

export type ParameterExtractorFn = (
  ctx: RequestContext,
  executionContext: ExecutionContext,
) => unknown | Promise<unknown>;

export interface CompiledParameter {
  readonly index: number;
  readonly source: ParameterSource;
  readonly metadata: ArgumentMetadata;
  readonly extract: ParameterExtractorFn;
  readonly paramPipes: readonly PipeLike[];
  readonly skipHigherScopePipes: boolean;
  readonly isAsync: boolean;
  readonly schema?: StandardSchemaV1;
}

function formatStandardSchemaPath(
  path: StandardSchemaV1Issue["path"],
  fallbackField: string,
): string {
  if (!path || path.length === 0) {
    return fallbackField;
  }
  let formatted = "";
  for (const segment of path) {
    const key =
      typeof segment === "object" && segment !== null && "key" in segment
        ? segment.key
        : segment;
    if (typeof key === "number") {
      formatted += `[${key}]`;
    } else {
      const str = String(key);
      formatted = formatted.length === 0 ? str : `${formatted}.${str}`;
    }
  }
  return formatted || fallbackField;
}

export async function runInlineStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
  metadata: ArgumentMetadata,
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (!result.issues) {
    return result.value;
  }

  const fallbackField = metadata.data ?? metadata.type ?? "value";
  const byField = new Map<string, Record<string, string>>();
  for (const issue of result.issues) {
    const field = formatStandardSchemaPath(issue.path, fallbackField);
    let constraints = byField.get(field);
    if (!constraints) {
      constraints = {};
      byField.set(field, constraints);
    }
    let key = "standardSchema";
    let suffix = 2;
    while (Object.hasOwn(constraints, key)) {
      key = `standardSchema_${suffix}`;
      suffix++;
    }
    constraints[key] = issue.message || "Invalid value";
  }

  const details: ValidationErrorDetail[] = [];
  for (const [field, constraints] of byField.entries()) {
    details.push({
      field,
      constraints,
      messages: Object.values(constraints),
    });
  }

  throw new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: "Bad Request",
    message: "Validation failed",
    details,
  });
}

function mapSourceToParamtype(source: ParameterSource): Paramtype {
  switch (source) {
    case "body":
    case "rawBody":
      return "body";
    case "query":
      return "query";
    case "param":
      return "param";
    case "header":
      return "header";
    case "cookies":
      return "cookies";
    case "signedCookies":
      return "signedCookies";
    case "session":
      return "session";
    case "hostParam":
      return "hostParam";
    case "uploadedFile":
      return "uploadedFile";
    case "uploadedFiles":
      return "uploadedFiles";
    case "request":
    case "response":
    case "next":
    case "ip":
    case "sseSignal":
    case "custom":
      return "custom";
  }
}

function extractHeadersObject(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!isDangerousKey(lower)) {
      out[lower] = value;
    }
  });
  return out;
}

function buildExtractorFn(param: ParameterMetadata): ParameterExtractorFn {
  const key = param.key;

  switch (param.source) {
    case "body":
      if (key !== undefined) {
        return async (ctx) => {
          const body = await ctx.getBody();
          if (body !== null && typeof body === "object") {
            return (body as Record<string, unknown>)[key];
          }
          return undefined;
        };
      }
      return (ctx) => ctx.getBody();

    case "rawBody":
      return (ctx) => ctx.getRawBody();

    case "query":
      if (key !== undefined) {
        return (ctx) => ctx.query[key];
      }
      return (ctx) => ctx.query;

    case "param":
      if (key !== undefined) {
        return (ctx) => ctx.params[key];
      }
      return (ctx) => ctx.params;

    case "header":
      if (key !== undefined) {
        return (ctx) => ctx.request.headers.get(key) ?? undefined;
      }
      return (ctx) => extractHeadersObject(ctx.request);

    case "cookies":
      if (key !== undefined) {
        return (ctx) => ctx.cookies[key];
      }
      return (ctx) => ctx.cookies;

    case "signedCookies":
      if (key !== undefined) {
        return (ctx) => ctx.signedCookies[key];
      }
      return (ctx) => ctx.signedCookies;

    case "session":
      if (key !== undefined) {
        return (ctx) => ctx.session?.[key];
      }
      return (ctx) => ctx.session;

    case "sseSignal":
      return (ctx) => ctx.getSseSignal();

    case "hostParam":
      if (key !== undefined) {
        return (ctx) => ctx.hostParams[key];
      }
      return (ctx) => ctx.hostParams;

    case "ip":
      return (ctx) => ctx.ip;

    case "request":
      return (ctx) => ctx.request;

    case "response":
      return (ctx) => ctx.responseContext;

    case "next":
      return () => () => undefined;

    case "uploadedFile":
      if (key !== undefined) {
        return async (ctx) => {
          const files = await ctx.getUploadedFiles();
          return files.find((file) => file.fieldname === key);
        };
      }
      return async (ctx) => {
        const files = await ctx.getUploadedFiles();
        return files[0];
      };

    case "uploadedFiles":
      if (key !== undefined) {
        return async (ctx) => {
          const files = await ctx.getUploadedFiles();
          return files.filter((file) => file.fieldname === key);
        };
      }
      return async (ctx) => {
        const files = await ctx.getUploadedFiles();
        return [...files];
      };

    case "custom": {
      const factory = param.factory;
      const data = param.data;
      if (!factory) {
        return () => undefined;
      }
      return (_ctx, executionContext) => factory(data, executionContext);
    }
  }
}

/**
 * Precompiles parameter extractors and `ArgumentMetadata` once at bootstrap
 * (zero per-request reflection). Output is sorted ascending by parameter index.
 */
export function compileParameters(params: readonly ParameterMetadata[]): {
  compiled: readonly CompiledParameter[];
  argCount: number;
} {
  if (params.length === 0) {
    return { compiled: [], argCount: 0 };
  }

  const sorted = [...params].sort((a, b) => a.index - b.index);
  let maxIndex = -1;

  const compiled: CompiledParameter[] = sorted.map((param) => {
    if (param.index > maxIndex) {
      maxIndex = param.index;
    }
    const paramtype = mapSourceToParamtype(param.source);
    const metadata: ArgumentMetadata = {
      type: paramtype,
      metatype: param.metatype,
      data: param.key,
      ...(param.schema !== undefined ? { schema: param.schema } : {}),
    };

    return {
      index: param.index,
      source: param.source,
      metadata,
      extract: buildExtractorFn(param),
      paramPipes: param.pipes ? [...param.pipes] : [],
      // Per ADR-008 §2.7: skip global/controller/method pipes on raw @Req(), @Res(), @SseSignal(), and @RawBody()
      skipHigherScopePipes:
        param.source === "request" ||
        param.source === "response" ||
        param.source === "sseSignal" ||
        param.source === "rawBody",
      isAsync:
        param.source === "body" ||
        param.source === "rawBody" ||
        param.source === "uploadedFile" ||
        param.source === "uploadedFiles" ||
        param.source === "custom" ||
        param.schema !== undefined,
      schema: param.schema,
    };
  });

  return { compiled, argCount: maxIndex + 1 };
}

export function hasStandardSchemaValidationPipe(
  pipes: readonly PipeTransform[] | undefined,
): boolean {
  if (!pipes || pipes.length === 0) {
    return false;
  }
  for (let i = 0; i < pipes.length; i++) {
    if (pipes[i] instanceof StandardSchemaValidationPipe) {
      return true;
    }
  }
  return false;
}

/**
 * Executes Stage 7 (Parameter Extraction) and Stage 8 (Pipes: Global -> Controller -> Method -> Param)
 * in ascending parameter index order.
 */
export async function resolveRouteArguments(
  compiledParams: readonly CompiledParameter[],
  argCount: number,
  sharedPipes: readonly PipeTransform[],
  resolvedParamPipes: readonly (readonly PipeTransform[])[],
  ctx: RequestContext,
  executionContext: ExecutionContext,
): Promise<unknown[]> {
  if (argCount === 0) {
    return [];
  }

  const args = new Array<unknown>(argCount);
  const sharedHasStandardSchemaPipe =
    hasStandardSchemaValidationPipe(sharedPipes);

  for (let i = 0; i < compiledParams.length; i++) {
    const param = compiledParams[i];
    if (!param) continue;

    let value = param.isAsync
      ? await param.extract(ctx, executionContext)
      : param.extract(ctx, executionContext);

    if (value instanceof HttpResponseContext) {
      args[param.index] = value;
      continue;
    }

    const paramPipes = resolvedParamPipes[i];
    const delegatedToPipe =
      (!param.skipHigherScopePipes && sharedHasStandardSchemaPipe) ||
      hasStandardSchemaValidationPipe(paramPipes);

    // Inline Standard Schema v1 validation (`@Body(schema)` / `@Body({ schema })`, etc.)
    // When a `StandardSchemaValidationPipe` is registered globally or on the route/param,
    // delegate schema validation to that pipe via `metadata.schema` so its custom options
    // (`transform`, `errorHttpStatusCode`, `validateOptions`, `exceptionFactory`) take full effect.
    if (param.schema && !delegatedToPipe) {
      value = await runInlineStandardSchema(
        param.schema,
        value,
        param.metadata,
      );
    }

    // Run Global -> Controller -> Method pipes (unless raw @Req/@Res)
    if (!param.skipHigherScopePipes && sharedPipes.length > 0) {
      for (let p = 0; p < sharedPipes.length; p++) {
        const pipe = sharedPipes[p];
        if (pipe) {
          value = await pipe.transform(value, param.metadata);
        }
      }
    }

    // Run parameter-scoped pipes
    if (paramPipes && paramPipes.length > 0) {
      for (let p = 0; p < paramPipes.length; p++) {
        const pipe = paramPipes[p];
        if (pipe) {
          value = await pipe.transform(value, param.metadata);
        }
      }
    }

    args[param.index] = value;
  }

  return args;
}
