import {
  type BunestInterceptor,
  type BunestMiddleware,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExceptionFilterLike,
  ForbiddenException,
  type GuardLike,
  HttpStatus,
  type InterceptorLike,
  InternalServerErrorException,
  Logger,
  type MiddlewareFunction,
  type NextFunction,
  type PipeLike,
  type PipeTransform,
  REQUEST,
  REQUEST_CONTEXT,
  RequestMethod,
  type RouteHttpMethod,
  Scope,
  type SecurityRequestHook,
  StreamableFile,
  type ViewEngineRenderer,
} from "../../common/index";
import { HttpExecutionContext } from "../context/execution-context";
import {
  type RequestContext,
  requestContextStorage,
} from "../context/request-context";
import { HttpResponseContext } from "../context/response-context";
import type {
  HttpRuntimeBridge,
  RequestScopeContainer,
} from "../interfaces/http-bridge.interface";
import { assertBodySizeHeader } from "../parsers/body-parser";
import type { ScannedRoute } from "../scanner/controller-scanner";
import {
  createPreflightResponse,
  evaluateCors,
  mergeCorsHeaders,
  type NormalizedCorsOptions,
} from "../security/cors";
import type { CompiledCsrfProtection } from "../security/csrf-protection";
import {
  applySecurityHeaders,
  type CompiledSecurityHeaders,
} from "../security/security-headers";
import {
  type CompiledExceptionFilter,
  type DefaultExceptionFilter,
  executeExceptionFilters,
  extractFilterCatchTypes,
  wrapHttpLikeMiddlewareError,
} from "./exception-handler";
import {
  type CompiledParameter,
  hasStandardSchemaValidationPipe,
  resolveRouteArguments,
  runInlineStandardSchema,
} from "./param-extractor";
import {
  mergeHeadersOntoNativeResponse,
  serializeResponse,
  serializeResponseMaybeAsync,
} from "./response-serializer";

export type MiddlewareEntry =
  | MiddlewareFunction
  | BunestMiddleware
  | (new (...args: any[]) => BunestMiddleware);

export type ResolvedMiddleware = MiddlewareFunction | BunestMiddleware;

export interface CompiledRoute {
  readonly route: ScannedRoute;
  readonly compiledParams: readonly CompiledParameter[];
  readonly argCount: number;
  readonly requiresRequestScope: boolean;

  // Ordered enhancer specifications (for request-scoped resolution when needed)
  readonly middlewareSpecs: readonly MiddlewareEntry[];
  readonly guardSpecs: readonly GuardLike[];
  readonly interceptorSpecs: readonly InterceptorLike[];
  readonly sharedPipeSpecs: readonly PipeLike[];
  readonly filterSpecs: readonly {
    readonly spec: ExceptionFilterLike;
    readonly catchTypes: readonly (new (...args: any[]) => any)[];
  }[];

  // Pre-resolved singleton fast-path instances (populated at bootstrap when !requiresRequestScope)
  readonly singletonController?: object;
  readonly singletonHandler?: (...args: unknown[]) => unknown;
  readonly singletonMiddlewares?: readonly ResolvedMiddleware[];
  readonly singletonGuards?: readonly CanActivate[];
  readonly singletonInterceptors?: readonly BunestInterceptor[];
  readonly singletonSharedPipes?: readonly PipeTransform[];
  readonly singletonParamPipes?: readonly (readonly PipeTransform[])[];
  readonly singletonFilters?: readonly CompiledExceptionFilter[];

  // Precomputed hot-path flags (populated once at bootstrap)
  readonly isFastSingleton?: boolean;
  readonly isStandardResponse?: boolean;
  readonly defaultStatus?: number;
  readonly hasCustomParam?: boolean;
}

export interface PipelineRuntimeConfig {
  readonly bridge: HttpRuntimeBridge;
  readonly cors?: NormalizedCorsOptions;
  readonly csrfProtection?: CompiledCsrfProtection;
  readonly securityHeaders?: CompiledSecurityHeaders;
  readonly bodyLimit?: number;
  readonly hasDiskMultipart?: boolean;
  readonly viewRenderer?: ViewEngineRenderer;
  readonly baseViewsDir?: string;
  readonly defaultFilter: DefaultExceptionFilter;
  readonly globalFilters: readonly CompiledExceptionFilter[];
  readonly globalFilterSpecs: readonly {
    readonly spec: ExceptionFilterLike;
    readonly catchTypes: readonly (new (...args: any[]) => any)[];
  }[];
  readonly hasRequestScopedGlobalFilter?: boolean;
  readonly onRequestHook?: Function;
  readonly onResponseHook?: Function;
  readonly onRouteTriggered?: (
    requestMethod: RequestMethod,
    path: string,
  ) => void;
  readonly securityHooks?: readonly SecurityRequestHook<Request>[];
  readonly mapException?: (error: unknown) => unknown;
  readonly customErrorHandler?: {
    readonly handler: Function;
    readonly prefix?: string;
  };
  readonly onErrorTrace?: (
    error: unknown,
    ctx: RequestContext,
    host: HttpExecutionContext,
    response: Response,
  ) => Response | void;
}

function shouldEnforceBodyLimitHeader(
  req: Request,
  runtime: PipelineRuntimeConfig,
): boolean {
  if (runtime.bodyLimit === undefined) {
    return false;
  }
  if (runtime.hasDiskMultipart) {
    const ct = req.headers.get("content-type");
    if (ct && ct.trimStart().toLowerCase().startsWith("multipart/form-data")) {
      return false;
    }
  }
  return true;
}

const FAST_JSON_200 = { status: 200 };
const FAST_JSON_201 = { status: 201 };

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function isSimpleJsonObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    !(value instanceof Response) &&
    !(value instanceof StreamableFile) &&
    !(value instanceof ReadableStream) &&
    !(value instanceof Blob) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value)
  );
}

function serializeFastOrFull(
  value: unknown,
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime?: PipelineRuntimeConfig,
): Response | Promise<Response> {
  if (
    compiled.isStandardResponse &&
    !ctx.hasResponseContext() &&
    ctx.request.method !== "HEAD" &&
    isSimpleJsonObject(value)
  ) {
    const status = compiled.defaultStatus ?? HttpStatus.OK;
    if (
      status !== HttpStatus.NO_CONTENT &&
      status !== HttpStatus.NOT_MODIFIED &&
      (status < 100 || status >= 200)
    ) {
      try {
        return Response.json(
          value,
          status === 200
            ? FAST_JSON_200
            : status === 201
              ? FAST_JSON_201
              : { status },
        );
      } catch (err) {
        throw new InternalServerErrorException(
          "Failed to serialize response body",
          { cause: err },
        );
      }
    }
  }
  const out = serializeResponseMaybeAsync(value, compiled.route, ctx);
  if (runtime && isThenable(out)) {
    return out.catch((err) => handleFastError(err, compiled, ctx, runtime));
  }
  return out;
}

function handleFastError(
  error: unknown,
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
): Promise<Response> {
  const mappedError = runtime.mapException
    ? runtime.mapException(error)
    : error;
  const execCtx = new HttpExecutionContext(
    ctx,
    compiled.route.controller,
    compiled.route.handlerFn,
    compiled.route.handlerKey,
  );
  return executeExceptionFilters(
    mappedError,
    compiled.singletonFilters ?? runtime.globalFilters,
    runtime.defaultFilter,
    ctx,
    execCtx,
  );
}

async function runSingleArgAsync(
  extracted: unknown,
  param: CompiledParameter,
  sharedPipes: readonly PipeTransform[],
  paramPipes: readonly PipeTransform[],
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
): Promise<Response> {
  try {
    let val = isThenable(extracted) ? await extracted : extracted;

    if (!(val instanceof HttpResponseContext)) {
      const delegatedToPipe =
        (!param.skipHigherScopePipes &&
          hasStandardSchemaValidationPipe(sharedPipes)) ||
        hasStandardSchemaValidationPipe(paramPipes);

      if (param.schema && !delegatedToPipe) {
        val = await runInlineStandardSchema(param.schema, val, param.metadata);
      }

      if (!param.skipHigherScopePipes && sharedPipes.length > 0) {
        for (let i = 0; i < sharedPipes.length; i++) {
          const pipe = sharedPipes[i];
          if (pipe) {
            const transformed = pipe.transform(val, param.metadata);
            val = isThenable(transformed) ? await transformed : transformed;
          }
        }
      }

      if (paramPipes.length > 0) {
        for (let i = 0; i < paramPipes.length; i++) {
          const pipe = paramPipes[i];
          if (pipe) {
            const transformed = pipe.transform(val, param.metadata);
            val = isThenable(transformed) ? await transformed : transformed;
          }
        }
      }
    }

    let result = compiled.singletonHandler!.call(
      compiled.singletonController,
      val,
    );
    if (isThenable(result)) {
      result = await result;
    }

    return await serializeFastOrFull(result, compiled, ctx, runtime);
  } catch (err) {
    return handleFastError(err, compiled, ctx, runtime);
  }
}

async function runMultiArgAsync(
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
): Promise<Response> {
  try {
    const execCtx = compiled.hasCustomParam
      ? new HttpExecutionContext(
          ctx,
          compiled.route.controller,
          compiled.route.handlerFn,
          compiled.route.handlerKey,
        )
      : (undefined as unknown as HttpExecutionContext);

    let args: unknown[];
    try {
      args = await resolveRouteArguments(
        compiled.compiledParams,
        compiled.argCount,
        compiled.singletonSharedPipes!,
        compiled.singletonParamPipes!,
        ctx,
        execCtx,
      );
    } catch (paramErr) {
      await ctx.cleanupUploadedDiskFiles();
      throw paramErr;
    }

    let result = compiled.singletonHandler!.apply(
      compiled.singletonController,
      args,
    );
    if (isThenable(result)) {
      result = await result;
    }

    return await serializeFastOrFull(result, compiled, ctx, runtime);
  } catch (err) {
    return handleFastError(err, compiled, ctx, runtime);
  }
}

/**
 * Ultra-lean hot path for pure singleton routes with zero middleware, zero guards,
 * zero interceptors, and CORS disabled. Preserves full `AsyncLocalStorage` propagation,
 * body-limit enforcement, pipes, and exception filter handling while eliminating
 * unnecessary Promises, `Headers`, `HttpResponseContext`, and `HttpExecutionContext` allocations.
 */
export function executeFastSingletonRoute(
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
): Response | Promise<Response> {
  return requestContextStorage.run(ctx, () => {
    try {
      if (shouldEnforceBodyLimitHeader(ctx.request, runtime)) {
        assertBodySizeHeader(ctx.request, runtime.bodyLimit);
      }

      const argCount = compiled.argCount;

      // 0-arg route fast path (e.g. GET /health)
      if (argCount === 0) {
        const result = compiled.singletonHandler!.call(
          compiled.singletonController,
        );
        if (isThenable(result)) {
          return Promise.resolve(result)
            .then((val) => serializeFastOrFull(val, compiled, ctx, runtime))
            .catch((err) => handleFastError(err, compiled, ctx, runtime));
        }
        return serializeFastOrFull(result, compiled, ctx, runtime);
      }

      // 1-arg route fast path (e.g. GET /users/:id, POST /users, POST /users/validated)
      if (
        argCount === 1 &&
        compiled.compiledParams.length === 1 &&
        compiled.compiledParams[0]!.index === 0
      ) {
        const p0 = compiled.compiledParams[0]!;
        const sharedPipes = compiled.singletonSharedPipes!;
        const p0Pipes = compiled.singletonParamPipes![0]!;
        const execCtx = compiled.hasCustomParam
          ? new HttpExecutionContext(
              ctx,
              compiled.route.controller,
              compiled.route.handlerFn,
              compiled.route.handlerKey,
            )
          : (undefined as unknown as HttpExecutionContext);

        const extracted = p0.extract(ctx, execCtx);

        if (
          !p0.isAsync &&
          !isThenable(extracted) &&
          (p0.skipHigherScopePipes || sharedPipes.length === 0) &&
          p0Pipes.length === 0
        ) {
          const result = compiled.singletonHandler!.call(
            compiled.singletonController,
            extracted,
          );
          if (isThenable(result)) {
            return Promise.resolve(result)
              .then((val) => serializeFastOrFull(val, compiled, ctx, runtime))
              .catch((err) => handleFastError(err, compiled, ctx, runtime));
          }
          return serializeFastOrFull(result, compiled, ctx, runtime);
        }

        return runSingleArgAsync(
          extracted,
          p0,
          sharedPipes,
          p0Pipes,
          compiled,
          ctx,
          runtime,
        );
      }

      // General multi-arg fast singleton path
      return runMultiArgAsync(compiled, ctx, runtime);
    } catch (err) {
      return handleFastError(err, compiled, ctx, runtime);
    }
  });
}

function isMiddlewareInstance(value: unknown): value is BunestMiddleware {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BunestMiddleware).use === "function"
  );
}

function isMiddlewareClass(
  value: unknown,
): value is new (...args: any[]) => BunestMiddleware {
  return (
    typeof value === "function" &&
    typeof (value as { prototype?: { use?: unknown } }).prototype?.use ===
      "function"
  );
}

async function resolveMiddleware(
  entry: MiddlewareEntry,
  bridge: HttpRuntimeBridge,
  requestContainer?: RequestScopeContainer,
  controllerToken?: new (...args: any[]) => unknown,
): Promise<ResolvedMiddleware> {
  if (isMiddlewareInstance(entry)) {
    return entry;
  }
  if (isMiddlewareClass(entry)) {
    return bridge.resolveEnhancer<BunestMiddleware>(
      entry,
      requestContainer,
      undefined,
      controllerToken,
    );
  }
  return entry as MiddlewareFunction;
}

function invokeMiddleware(
  mw: ResolvedMiddleware,
  ctx: RequestContext,
  next: NextFunction,
): Response | void | Promise<Response | void> {
  if (typeof mw === "function") {
    return mw(ctx.request, ctx.responseContext, next);
  }
  return mw.use(ctx.request, ctx.responseContext, next);
}

function finalizeShortCircuitResponse(
  response: Response,
  ctx: RequestContext,
): Response {
  return mergeHeadersOntoNativeResponse(response, ctx);
}

async function executeMiddlewareChain(
  middlewares: readonly ResolvedMiddleware[],
  ctx: RequestContext,
  downstream: () => Promise<Response>,
): Promise<Response> {
  if (middlewares.length === 0) {
    return downstream();
  }

  const dispatch = async (index: number): Promise<Response> => {
    if (index >= middlewares.length) {
      return downstream();
    }

    const mw = middlewares[index];
    if (!mw) {
      return dispatch(index + 1);
    }

    let nextCalled = false;
    let nextPromise: Promise<Response> | undefined;

    const next: NextFunction = () => {
      if (!nextCalled) {
        nextCalled = true;
        nextPromise = dispatch(index + 1);
      }
      return nextPromise!;
    };

    let result: unknown;
    try {
      result = await invokeMiddleware(mw, ctx, next);
    } catch (mwErr) {
      if (!nextCalled) {
        throw wrapHttpLikeMiddlewareError(mwErr);
      }
      throw mwErr;
    }

    if (result instanceof Response) {
      return nextCalled ? result : finalizeShortCircuitResponse(result, ctx);
    }

    if (nextCalled && nextPromise) {
      return await nextPromise;
    }

    // Middleware did not call next() and did not return a Response -> short-circuit using ResponseContext
    const status = ctx.hasResponseContext()
      ? (ctx.responseContext.getStatus() ?? 200)
      : 200;
    const headers = new Headers();
    if (ctx.hasCorsHeaders()) {
      mergeCorsHeaders(headers, ctx.corsHeaders);
    }
    if (ctx.hasResponseContext()) {
      const resHeaders = ctx.responseContext.getHeadersIfInitialized();
      if (resHeaders) {
        resHeaders.forEach((value, key) => {
          if (key.toLowerCase() === "set-cookie") return;
          headers.set(key, value);
        });
      }
      for (const cookie of ctx.responseContext.getSetCookies()) {
        headers.append("Set-Cookie", cookie);
      }
    }
    return new Response(null, { status, headers });
  };

  return dispatch(0);
}

/**
 * Executes the full 11-stage HTTP pipeline (ADR-008) for a compiled route,
 * dispatching to `executeFastSingletonRoute` when eligible.
 */
export function executeCompiledRoute(
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
  allowedMethodsForPath?: string,
): Response | Promise<Response> {
  if (compiled.route.isSse) {
    ctx.enableSseSignal();
  }
  if (compiled.isFastSingleton) {
    return executeFastSingletonRoute(compiled, ctx, runtime);
  }
  return executeFullCompiledRoute(
    compiled,
    ctx,
    runtime,
    allowedMethodsForPath,
  );
}

function toRequestMethodEnum(method: RouteHttpMethod): RequestMethod {
  switch (method) {
    case "GET":
      return RequestMethod.GET;
    case "POST":
      return RequestMethod.POST;
    case "PUT":
      return RequestMethod.PUT;
    case "DELETE":
      return RequestMethod.DELETE;
    case "PATCH":
      return RequestMethod.PATCH;
    case "OPTIONS":
      return RequestMethod.OPTIONS;
    case "HEAD":
      return RequestMethod.HEAD;
    case "SEARCH":
      return RequestMethod.SEARCH;
    case "PROPFIND":
      return RequestMethod.PROPFIND;
    case "PROPPATCH":
      return RequestMethod.PROPPATCH;
    case "MKCOL":
      return RequestMethod.MKCOL;
    case "COPY":
      return RequestMethod.COPY;
    case "MOVE":
      return RequestMethod.MOVE;
    case "LOCK":
      return RequestMethod.LOCK;
    case "UNLOCK":
      return RequestMethod.UNLOCK;
    case "QUERY":
      return RequestMethod.QUERY;
    default:
      return RequestMethod.ALL;
  }
}

export async function runAdapterOnRequestHook(
  hook: Function,
  req: Request,
  res: RequestContext["responseContext"],
): Promise<void> {
  if (hook.length >= 3) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      try {
        const ret = hook(req, res, done);
        if (isThenable(ret)) {
          Promise.resolve(ret).then(
            () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            },
            (e) => {
              if (!settled) {
                settled = true;
                reject(e);
              }
            },
          );
        }
      } catch (e) {
        done(e);
      }
    });
    return;
  }
  await hook(req, res);
}

function matchesSegmentPrefix(
  pathname: string,
  prefix: string | undefined,
): boolean {
  if (!prefix || prefix === "/") {
    return true;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

async function invokeCustomErrorHandler(
  customErrorHandler: { readonly handler: Function; readonly prefix?: string },
  error: unknown,
  ctx: RequestContext,
): Promise<Response | undefined> {
  if (!matchesSegmentPrefix(ctx.pathname, customErrorHandler.prefix)) {
    return undefined;
  }
  const resCtx = ctx.responseContext;
  let nextCalled = false;
  const result = await customErrorHandler.handler(
    error,
    ctx.request,
    resCtx,
    () => {
      nextCalled = true;
    },
  );
  if (result instanceof Response) {
    return mergeHeadersOntoNativeResponse(result, ctx);
  }
  const sent = resCtx.getSentResponse();
  if (sent) {
    return sent;
  }
  if (!nextCalled && result !== undefined) {
    return serializeResponse(
      result,
      { method: "GET", httpCode: resCtx.getStatus() ?? 500 },
      ctx,
    );
  }
  return undefined;
}

async function executeFullCompiledRoute(
  compiled: CompiledRoute,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
  allowedMethodsForPath?: string,
): Promise<Response> {
  const { route } = compiled;
  let requestContainer: RequestScopeContainer | undefined;

  if (compiled.requiresRequestScope && runtime.bridge.createRequestContainer) {
    requestContainer = runtime.bridge.createRequestContainer(
      ctx.request,
      ctx.responseContext,
    );
    requestContainer.registerRequestValue(REQUEST, ctx.request);
    requestContainer.registerRequestValue(REQUEST_CONTEXT, ctx);
    ctx.container = requestContainer;
  }

  const executionContext = new HttpExecutionContext(
    ctx,
    route.controller,
    route.handlerFn,
    route.handlerKey,
  );

  return requestContextStorage.run(ctx, async () => {
    let activeFilters: readonly CompiledExceptionFilter[] =
      compiled.singletonFilters ?? runtime.globalFilters;

    const finalizeResponse = async (res: Response): Promise<Response> => {
      const secured = runtime.securityHeaders
        ? applySecurityHeaders(res, runtime.securityHeaders)
        : res;
      if (runtime.onResponseHook) {
        await runtime.onResponseHook(ctx.request, ctx.responseContext);
      }
      return secured;
    };

    try {
      const runDownstream = async (): Promise<Response> => {
        const earlySent = ctx.responseContext.getSentResponse();
        if (earlySent) {
          return await finalizeResponse(earlySent);
        }

        // Resolve non-request-scoped filters upfront so exceptions during controller DI
        // resolution hit singleton/transient filters, while deferring request-scoped
        // filters until after the request-scoped controller resolves successfully.
        const deferRequestScopedFilters =
          compiled.requiresRequestScope &&
          compiled.singletonController === undefined;

        if (compiled.requiresRequestScope) {
          const resolvedFilters: CompiledExceptionFilter[] = [];
          for (let i = 0; i < compiled.filterSpecs.length; i++) {
            const item = compiled.filterSpecs[i];
            if (!item) continue;
            if (
              deferRequestScopedFilters &&
              runtime.bridge.requiresEnhancerRequestScope?.(
                item.spec,
                "filter",
                route.controller,
              )
            ) {
              continue;
            }
            const instance =
              await runtime.bridge.resolveEnhancer<ExceptionFilter>(
                item.spec,
                requestContainer,
                "filter",
                route.controller,
              );
            const catchTypes =
              runtime.bridge.resolveFilterCatchTypes?.(item.spec, instance) ??
              item.catchTypes;
            resolvedFilters.push({
              filter: instance,
              catchTypes,
            });
          }
          activeFilters = resolvedFilters;
        }

      // Stage 3: Security / CORS Pre-Processing
      if (runtime.onErrorTrace) ctx.traceStage = "security";
      if (runtime.cors) {
        const corsResult = await evaluateCors(
          ctx.request,
          runtime.cors,
          allowedMethodsForPath,
        );
        mergeCorsHeaders(ctx.corsHeaders, corsResult.headers);

        if (corsResult.isPreflight && !runtime.cors.preflightContinue) {
          const preflight = createPreflightResponse(corsResult, runtime.cors);
          return await finalizeResponse(preflight);
        }
      }

      if (runtime.csrfProtection) {
        runtime.csrfProtection.evaluate(ctx.request, ctx.pathname);
      }

      if (runtime.securityHooks && runtime.securityHooks.length > 0) {
        const resCtx = ctx.responseContext;
        const headerBridge = {
          setHeader: (name: string, value: string) =>
            resCtx.header(name, value),
          removeHeader: (name: string) => resCtx.removeHeader(name),
        };
        for (let i = 0; i < runtime.securityHooks.length; i++) {
          const hook = runtime.securityHooks[i];
          if (!hook) continue;
          const rejection = hook(ctx.request, headerBridge);
          if (rejection instanceof Error) {
            throw rejection;
          }
        }
      }

      if (shouldEnforceBodyLimitHeader(ctx.request, runtime)) {
        assertBodySizeHeader(ctx.request, runtime.bodyLimit);
      }

      // Resolve middleware chain (pre-resolved on singleton fast path)
      let middlewares: readonly ResolvedMiddleware[];
      if (compiled.singletonMiddlewares) {
        middlewares = compiled.singletonMiddlewares;
      } else {
        const resolved: ResolvedMiddleware[] = [];
        for (let i = 0; i < compiled.middlewareSpecs.length; i++) {
          const mw = compiled.middlewareSpecs[i];
          if (mw) {
            resolved.push(
              await resolveMiddleware(
                mw,
                runtime.bridge,
                requestContainer,
                route.controller,
              ),
            );
          }
        }
        middlewares = resolved;
      }

      // Stage 4: Middleware -> Stages 5..11
      if (runtime.onErrorTrace) ctx.traceStage = "middleware";
      const mwResponse = await executeMiddlewareChain(
        middlewares,
        ctx,
        async () => {
        // Stage 5: Guards (Global -> Controller -> Method)
        if (runtime.onErrorTrace) ctx.traceStage = "guard";
        let guards: readonly CanActivate[];
        if (compiled.singletonGuards) {
          guards = compiled.singletonGuards;
        } else {
          const resolved: CanActivate[] = [];
          for (let i = 0; i < compiled.guardSpecs.length; i++) {
            const g = compiled.guardSpecs[i];
            if (g) {
              resolved.push(
                await runtime.bridge.resolveEnhancer<CanActivate>(
                  g,
                  requestContainer,
                  "guard",
                  route.controller,
                ),
              );
            }
          }
          guards = resolved;
        }

        for (let i = 0; i < guards.length; i++) {
          const guard = guards[i];
          if (!guard) continue;
          const allowed = await guard.canActivate(executionContext);
          if (!allowed) {
            throw new ForbiddenException("Forbidden resource");
          }
        }

        // Stage 6 & 10: Interceptors (Global -> Controller -> Method before; reverse after)
        if (runtime.onErrorTrace) ctx.traceStage = "interceptor";
        let interceptors: readonly BunestInterceptor[];
        if (compiled.singletonInterceptors) {
          interceptors = compiled.singletonInterceptors;
        } else {
          const resolved: BunestInterceptor[] = [];
          for (let i = 0; i < compiled.interceptorSpecs.length; i++) {
            const ic = compiled.interceptorSpecs[i];
            if (ic) {
              resolved.push(
                await runtime.bridge.resolveEnhancer<BunestInterceptor>(
                  ic,
                  requestContainer,
                  "interceptor",
                  route.controller,
                ),
              );
            }
          }
          interceptors = resolved;
        }

        // Innermost handler: Stage 7 (Params) -> Stage 8 (Pipes) -> Stage 9 (Controller Handler)
        const executeInnerStages = async (): Promise<unknown> => {
          let sharedPipes: readonly PipeTransform[];
          let paramPipesList: readonly (readonly PipeTransform[])[];

          if (compiled.singletonSharedPipes && compiled.singletonParamPipes) {
            sharedPipes = compiled.singletonSharedPipes;
            paramPipesList = compiled.singletonParamPipes;
          } else {
            const resolvedShared: PipeTransform[] = [];
            for (let i = 0; i < compiled.sharedPipeSpecs.length; i++) {
              const p = compiled.sharedPipeSpecs[i];
              if (p) {
                resolvedShared.push(
                  await runtime.bridge.resolveEnhancer<PipeTransform>(
                    p,
                    requestContainer,
                    "pipe",
                    route.controller,
                  ),
                );
              }
            }
            sharedPipes = resolvedShared;

            const resolvedParams: PipeTransform[][] = [];
            for (let i = 0; i < compiled.compiledParams.length; i++) {
              const cp = compiled.compiledParams[i];
              const pipes: PipeTransform[] = [];
              if (cp && cp.paramPipes.length > 0) {
                for (let j = 0; j < cp.paramPipes.length; j++) {
                  const p = cp.paramPipes[j];
                  if (p) {
                    pipes.push(
                      await runtime.bridge.resolveEnhancer<PipeTransform>(
                        p,
                        requestContainer,
                        "pipe",
                        route.controller,
                      ),
                    );
                  }
                }
              }
              resolvedParams.push(pipes);
            }
            paramPipesList = resolvedParams;
          }

          // Stages 7 & 8: Extract parameters & run pipes
          if (runtime.onErrorTrace) ctx.traceStage = "pipe";
          let args: unknown[];
          try {
            args = await resolveRouteArguments(
              compiled.compiledParams,
              compiled.argCount,
              sharedPipes,
              paramPipesList,
              ctx,
              executionContext,
            );
          } catch (paramErr) {
            await ctx.cleanupUploadedDiskFiles();
            throw paramErr;
          }

          // Stage 9: Invoke controller handler (+ optional onRouteTriggered hook)
          if (runtime.onRouteTriggered) {
            runtime.onRouteTriggered(
              toRequestMethodEnum(route.method),
              route.fullPath,
            );
          }

          const controllerInstance =
            compiled.singletonController ??
            (await runtime.bridge.resolveController(
              route.controller,
              requestContainer,
            ));

          if (deferRequestScopedFilters && compiled.filterSpecs.length > 0) {
            const allFilters: CompiledExceptionFilter[] = [];
            for (let i = 0; i < compiled.filterSpecs.length; i++) {
              const item = compiled.filterSpecs[i];
              if (!item) continue;
              const instance =
                await runtime.bridge.resolveEnhancer<ExceptionFilter>(
                  item.spec,
                  requestContainer,
                  "filter",
                  route.controller,
                );
              const catchTypes =
                runtime.bridge.resolveFilterCatchTypes?.(item.spec, instance) ??
                item.catchTypes;
              allFilters.push({
                filter: instance,
                catchTypes,
              });
            }
            activeFilters = allFilters;
          }

          const handlerMethod =
            compiled.singletonHandler ??
            ((controllerInstance as Record<string | symbol, unknown>)[
              route.handlerKey
            ] as (...a: unknown[]) => unknown);

          if (runtime.onErrorTrace) ctx.traceStage = "handler";
          const rawResult = await handlerMethod.apply(controllerInstance, args);
          if (rawResult instanceof Response) {
            innerHandlerResponse = rawResult;
          }
          return rawResult;
        };

        let innerHandlerResponse: Response | undefined;
        let handlerResult: unknown;
        if (interceptors.length === 0) {
          handlerResult = await executeInnerStages();
        } else {
          let nextHandler: CallHandler = { handle: executeInnerStages };
          for (let i = interceptors.length - 1; i >= 0; i--) {
            const interceptor = interceptors[i];
            if (!interceptor) continue;
            const currentNext = nextHandler;
            nextHandler = {
              handle: () =>
                Promise.resolve(
                  interceptor.intercept(executionContext, currentNext),
                ),
            };
          }
          handlerResult = await nextHandler.handle();
        }

        // Preserve status & headers if an interceptor wrapped the handler's native Response (e.g. `{ data: response }`)
        if (
          innerHandlerResponse &&
          !(handlerResult instanceof Response) &&
          handlerResult !== null &&
          typeof handlerResult === "object"
        ) {
          const vals = Object.values(handlerResult as Record<string, unknown>);
          if (vals.includes(innerHandlerResponse)) {
            if (ctx.responseContext.getStatus() === undefined) {
              ctx.responseContext.status(innerHandlerResponse.status);
            }
            const existingHeaders = ctx.responseContext.getHeadersIfInitialized();
            innerHandlerResponse.headers.forEach((v, k) => {
              if (k.toLowerCase() === "content-type") return;
              if (!existingHeaders || !existingHeaders.has(k)) {
                ctx.responseContext.header(k, v);
              }
            });
            if (innerHandlerResponse.body) {
              void innerHandlerResponse.body.cancel().catch(() => {});
            }
          }
        }

        // Stage 11: Response Serialization (ADR-010) + optional @Render() + Security Headers
        if (runtime.onErrorTrace) ctx.traceStage = "serialization";
        let response: Response;
        const sentDirectly = ctx.hasResponseContext()
          ? ctx.responseContext.getSentResponse()
          : undefined;
        if (sentDirectly && handlerResult === undefined) {
          response = sentDirectly;
        } else if (
          route.renderTemplate &&
          !(handlerResult instanceof Response) &&
          runtime.viewRenderer
        ) {
          const model =
            handlerResult && typeof handlerResult === "object"
              ? (handlerResult as Record<string, unknown>)
              : {};
          const html = await runtime.viewRenderer(route.renderTemplate, model, {
            baseViewsDir: runtime.baseViewsDir,
          });
          ctx.responseContext.header(
            "Content-Type",
            "text/html; charset=utf-8",
          );
          response = serializeResponse(html, route, ctx);
        } else {
          response = await serializeResponseMaybeAsync(
            handlerResult,
            route,
            ctx,
          );
        }
        return await finalizeResponse(response);
      });
      return runtime.securityHeaders
        ? applySecurityHeaders(mwResponse, runtime.securityHeaders)
        : mwResponse;
      };

      if (runtime.onRequestHook) {
        const hookFn = runtime.onRequestHook;
        if (hookFn.length >= 3) {
          return await new Promise<Response>((resolve, reject) => {
            let doneCalled = false;
            let settled = false;
            const settleResolve = (res: Response) => {
              if (!settled) {
                settled = true;
                resolve(res);
              }
            };
            const settleReject = (err: unknown) => {
              if (!settled) {
                settled = true;
                reject(err);
              }
            };
            const done = (err?: unknown) => {
              if (doneCalled) return;
              doneCalled = true;
              if (err !== undefined && err !== null) {
                settleReject(err);
                return;
              }
              // Invoke runDownstream synchronously inside done() so AsyncLocalStorage
              // contexts established by the hook (e.g. `storage.run('hook', done)`)
              // propagate across body parsing, handler execution, and onResponseHook.
              runDownstream().then(settleResolve, settleReject);
            };
            try {
              const maybePromise = hookFn(ctx.request, ctx.responseContext, done);
              if (isThenable(maybePromise)) {
                Promise.resolve(maybePromise).then(
                  () => {
                    if (!doneCalled) {
                      done();
                    }
                  },
                  (err) => {
                    if (doneCalled) {
                      new Logger("RequestHook").error(err);
                    } else {
                      settleReject(err);
                    }
                  },
                );
              }
            } catch (err) {
              if (doneCalled) {
                new Logger("RequestHook").error(err);
              } else {
                settleReject(err);
              }
            }
          });
        }
        await hookFn(ctx.request, ctx.responseContext);
      }

      return await runDownstream();
    } catch (rawError) {
      const error = runtime.mapException
        ? runtime.mapException(rawError)
        : rawError;
      // Ensure CORS headers are attached on errors thrown before or during CORS stage
      if (
        runtime.cors &&
        (!ctx.hasCorsHeaders() ||
          ctx.corsHeaders.get("access-control-allow-origin") === null)
      ) {
        try {
          const corsResult = await evaluateCors(
            ctx.request,
            runtime.cors,
            allowedMethodsForPath,
          );
          mergeCorsHeaders(ctx.corsHeaders, corsResult.headers);
        } catch {
          // Ignore secondary CORS evaluation failures inside exception path
        }
      }

      if (runtime.customErrorHandler && activeFilters.length === 0) {
        const customRes = await invokeCustomErrorHandler(
          runtime.customErrorHandler,
          error,
          ctx,
        );
        if (customRes) {
          return await finalizeResponse(customRes);
        }
      }

      const errorResponse = await executeExceptionFilters(
        error,
        activeFilters,
        runtime.defaultFilter,
        ctx,
        executionContext,
      );
      const finalized = await finalizeResponse(errorResponse);
      if (runtime.onErrorTrace) {
        const traced = runtime.onErrorTrace(
          error,
          ctx,
          executionContext,
          finalized,
        );
        if (traced instanceof Response) return traced;
      }
      return finalized;
    } finally {
      if (requestContainer) {
        await requestContainer.destroy().catch(() => {});
      }
    }
  });
}

class FallbackControllerStub {}
function fallbackHandlerStub(): void {}

/**
 * Routes 404 / 405 / pre-route exceptions through Global Exception Filters
 * and `DefaultExceptionFilter` while preserving CORS headers (ADR-008 & ADR-011).
 */
export async function executeFallbackException(
  error: unknown,
  ctx: RequestContext,
  runtime: PipelineRuntimeConfig,
  allowedMethodsForPath?: string,
): Promise<Response> {
  return requestContextStorage.run(ctx, async () => {
    let requestContainer: RequestScopeContainer | undefined;
    try {
      if (runtime.cors) {
        try {
          const corsResult = await evaluateCors(
            ctx.request,
            runtime.cors,
            allowedMethodsForPath,
          );
          mergeCorsHeaders(ctx.corsHeaders, corsResult.headers);
        } catch {
          // Ignore CORS failures on error path
        }
      }

      const host = new HttpExecutionContext(
        ctx,
        FallbackControllerStub,
        fallbackHandlerStub,
        "fallback",
      );

      let activeFilters: readonly CompiledExceptionFilter[] =
        runtime.globalFilters;

      if (
        runtime.hasRequestScopedGlobalFilter &&
        runtime.globalFilterSpecs.length > 0
      ) {
        if (runtime.bridge.createRequestContainer) {
          requestContainer = runtime.bridge.createRequestContainer(
            ctx.request,
            ctx.responseContext,
          );
          requestContainer.registerRequestValue(REQUEST, ctx.request);
          requestContainer.registerRequestValue(REQUEST_CONTEXT, ctx);
          ctx.container = requestContainer;
        }

        const resolved: CompiledExceptionFilter[] = [];
        for (let i = 0; i < runtime.globalFilterSpecs.length; i++) {
          const item = runtime.globalFilterSpecs[i];
          if (!item) continue;
          const instance =
            await runtime.bridge.resolveEnhancer<ExceptionFilter>(
              item.spec,
              requestContainer,
              "filter",
            );
          const catchTypes =
            runtime.bridge.resolveFilterCatchTypes?.(item.spec, instance) ??
            item.catchTypes;
          resolved.push({
            filter: instance,
            catchTypes,
          });
        }
        activeFilters = resolved;
      }

      const fallbackRes = await executeExceptionFilters(
        error,
        activeFilters,
        runtime.defaultFilter,
        ctx,
        host,
      );
      const secured = runtime.securityHeaders
        ? applySecurityHeaders(fallbackRes, runtime.securityHeaders)
        : fallbackRes;
      if (runtime.onErrorTrace) {
        if (!ctx.traceStage) ctx.traceStage = "routing";
        const traced = runtime.onErrorTrace(error, ctx, host, secured);
        if (traced instanceof Response) return traced;
      }
      return secured;
    } finally {
      if (requestContainer) {
        await requestContainer.destroy().catch(() => {});
      }
    }
  });
}

/**
 * Helper used during bootstrap to pre-compile global/controller/method filter specs.
 */
export function buildFilterSpec(spec: ExceptionFilterLike): {
  readonly spec: ExceptionFilterLike;
  readonly catchTypes: readonly (new (...args: any[]) => any)[];
} {
  return {
    spec,
    catchTypes: extractFilterCatchTypes(spec),
  };
}

export function isRouteExplicitlyRequestScoped(route: ScannedRoute): boolean {
  return route.scope === Scope.REQUEST;
}
