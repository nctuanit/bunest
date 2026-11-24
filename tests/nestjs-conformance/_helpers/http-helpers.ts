import type { ModuleMetadata } from "../../../packages/core/src/common";
import type { BunestApplication } from "../../../packages/core/src";
import {
  CapturingLogger,
  ContextIdFactory,
  CookieJar,
  ModuleMocker,
  ScopedTestingModule,
  SupertestAgent,
  SupertestRequest,
  Test,
  TestAgent,
  TestClient,
  TestResponse,
  TestingLogger,
  TestingModule,
  TestingModuleBuilder,
  createAutoMocker,
  createMockCallHandler,
  createMockExecutionContext,
  createMockFn,
  createMockLogger,
  createMockProvider,
  createMockReflector,
  createMockRequest,
  createMockResponseContext,
  createNodeHttpServer,
  parseSseJson,
  readSseEvents,
  request,
  runWithMockRequestContext,
  type AttachOptions,
  type AutoMockerOptions,
  type CapturedLogEntry,
  type CapturingLoggerFilterOptions,
  type CapturingLoggerOptions,
  type ContextId,
  type CreateTestingAppOptions,
  type CreateTestingMicroserviceOptions,
  type FetchCapable,
  type InjectOptions,
  type InjectResponse,
  type LogEntryMatcher,
  type MockCallHandler,
  type MockCallResult,
  type MockExecutionContextOptions,
  type MockFactory,
  type MockFunction,
  type MockMetadata,
  type MockMetadataType,
  type MockRequestOptions,
  type MockRpcContextOptions,
  type MockWsContextOptions,
  type ModuleRefGetOptions,
  type OverrideBy,
  type OverrideByEnhancer,
  type OverrideFactoryOptions,
  type OverrideModule,
  type QueryParamPrimitive,
  type QueryParamValue,
  type ReadSseEventsOptions,
  type SseEvent,
  type SupertestExpectChecker,
  type SupertestFactory,
  type SupertestResponse,
  type SupertestTarget,
  type TestClientOptions,
  type TestRequestOptions,
  type TestRequestRedirect,
  type TestingLoggerOptions,
  type TestingMicroserviceTarget,
  type TestingModuleCompileOptions,
  type TestingModuleOptions,
} from "../../../packages/testing/src";
import {
  ValidationPipe,
  type ValidationPipeOptions,
} from "../../../packages/validation/src";

// Re-export @bunest/testing public APIs so conformance tests can import
// everything cleanly from `_helpers`.
export {
  CapturingLogger,
  ContextIdFactory,
  CookieJar,
  ModuleMocker,
  ScopedTestingModule,
  SupertestAgent,
  SupertestRequest,
  Test,
  TestAgent,
  TestClient,
  TestResponse,
  TestingLogger,
  TestingModule,
  TestingModuleBuilder,
  createAutoMocker,
  createMockCallHandler,
  createMockExecutionContext,
  createMockFn,
  createMockLogger,
  createMockProvider,
  createMockReflector,
  createMockRequest,
  createMockResponseContext,
  createNodeHttpServer,
  parseSseJson,
  readSseEvents,
  request,
  runWithMockRequestContext,
  type AttachOptions,
  type AutoMockerOptions,
  type CapturedLogEntry,
  type CapturingLoggerFilterOptions,
  type CapturingLoggerOptions,
  type ContextId,
  type CreateTestingAppOptions,
  type CreateTestingMicroserviceOptions,
  type FetchCapable,
  type InjectOptions,
  type InjectResponse,
  type LogEntryMatcher,
  type MockCallHandler,
  type MockCallResult,
  type MockExecutionContextOptions,
  type MockFactory,
  type MockFunction,
  type MockMetadata,
  type MockMetadataType,
  type MockRequestOptions,
  type MockRpcContextOptions,
  type MockWsContextOptions,
  type ModuleRefGetOptions,
  type OverrideBy,
  type OverrideByEnhancer,
  type OverrideFactoryOptions,
  type OverrideModule,
  type QueryParamPrimitive,
  type QueryParamValue,
  type ReadSseEventsOptions,
  type SseEvent,
  type SupertestExpectChecker,
  type SupertestFactory,
  type SupertestResponse,
  type SupertestTarget,
  type TestClientOptions,
  type TestRequestOptions,
  type TestRequestRedirect,
  type TestingLoggerOptions,
  type TestingMicroserviceTarget,
  type TestingModuleCompileOptions,
  type TestingModuleOptions,
};

/**
 * Direct shorthand over `Test.createTestingModule(metadata, options)`.
 */
export function createTestingModule(
  metadata: ModuleMetadata,
  options?: TestingModuleOptions,
): TestingModuleBuilder {
  return Test.createTestingModule(metadata, options);
}

/**
 * Upstream NestJS default `ValidationPipe` options (contrasted against Bunest's
 * strict ADR-009 defaults where `whitelist`, `forbidNonWhitelisted`, `transform`
 * are `true` and `errorFormat` is `"bunest"`).
 */
export const NEST_DEFAULT_VALIDATION_PIPE_OPTIONS: Readonly<ValidationPipeOptions> =
  Object.freeze({
    transform: false,
    whitelist: false,
    forbidNonWhitelisted: false,
    forbidUnknownValues: false,
    errorFormat: "list",
  });

/**
 * Constructs a `ValidationPipe` pre-configured with upstream NestJS defaults
 * (`whitelist: false`, `forbidNonWhitelisted: false`, `transform: false`,
 * `errorFormat: "list"`). Use when porting upstream NestJS tests asserting
 * NestJS default pipe behavior, and pair with `bunestStrictValidationPipe()`
 * when verifying Bunest ADR-009 strict defaults.
 */
export function nestCompatibleValidationPipe(
  overrides: ValidationPipeOptions = {},
): ValidationPipe {
  const merged: ValidationPipeOptions = {
    ...NEST_DEFAULT_VALIDATION_PIPE_OPTIONS,
    ...overrides,
  };
  // In NestJS, enabling `whitelist: true` strips unknown keys without throwing
  // unless `forbidNonWhitelisted: true` is also explicitly passed.
  if (
    overrides.whitelist === true &&
    overrides.forbidNonWhitelisted === undefined
  ) {
    merged.forbidNonWhitelisted = false;
  }
  return new ValidationPipe(merged);
}

/**
 * Constructs a `ValidationPipe` using Bunest's default ADR-009 strict security
 * posture (`whitelist: true`, `forbidNonWhitelisted: true`,
 * `forbidUnknownValues: true`, `transform: true`, `errorFormat: "bunest"`).
 */
export function bunestStrictValidationPipe(
  overrides: ValidationPipeOptions = {},
): ValidationPipe {
  return new ValidationPipe(overrides);
}

export interface CreateTestAppOptions {
  readonly testingOptions?: TestingModuleOptions;
  readonly compileOptions?: TestingModuleCompileOptions;
  readonly appOptions?: CreateTestingAppOptions;
  readonly clientOptions?: TestClientOptions;
  /**
   * Optional callback to customize the `TestingModuleBuilder` prior to `compile()`
   * (e.g., `.overrideProvider(...)`, `.overrideGuard(...)`, `.useMocker(...)`).
   */
  readonly customizeBuilder?: (
    builder: TestingModuleBuilder,
  ) => TestingModuleBuilder | void;
  /**
   * Optional callback to configure the created `BunestApplication` before `init()`
   * (e.g., `useGlobalPipes`, `useGlobalGuards`, `enableVersioning`, `setGlobalPrefix`).
   */
  readonly configureApp?: (
    app: BunestApplication,
    moduleRef: TestingModule,
  ) => void | Promise<void>;
  /**
   * Automatically invoke `await app.init()` before returning.
   * @default true
   */
  readonly autoInit?: boolean;
  /**
   * Convenience flag to suppress framework log output (`logger: false`) when no
   * explicit logger was passed in `testingOptions`, `compileOptions`, or `appOptions`.
   * @default false
   */
  readonly silentLogger?: boolean;
}

export interface TestAppContext {
  readonly moduleRef: TestingModule;
  readonly app: BunestApplication;
  readonly client: TestClient;
  /** Zero-socket Supertest-style client bound to `app`. */
  readonly request: (options?: TestClientOptions) => SupertestAgent;
  /** Zero-socket cookie-persisting Supertest agent bound to `app`. */
  readonly agent: (options?: TestClientOptions) => SupertestAgent;
  /** Cleanly closes both `app` and `moduleRef` (idempotent). */
  readonly close: () => Promise<void>;
}

/**
 * Compiles a Bunest `TestingModule`, creates and initializes a `BunestApplication`,
 * and returns ergonomic zero-socket `TestClient` + Supertest `request()`/`agent()`
 * handles with safe lifecycle teardown.
 */
export async function createTestApp(
  metadata: ModuleMetadata,
  options: CreateTestAppOptions = {},
): Promise<TestAppContext> {
  const testingOptions: TestingModuleOptions = {
    ...(options.silentLogger && options.testingOptions?.logger === undefined
      ? { logger: false as const }
      : {}),
    ...options.testingOptions,
  };

  let builder = createTestingModule(metadata, testingOptions);
  if (options.customizeBuilder) {
    const returned = options.customizeBuilder(builder);
    if (returned instanceof TestingModuleBuilder) {
      builder = returned;
    }
  }

  const compileOptions: TestingModuleCompileOptions = {
    ...(options.silentLogger &&
    options.compileOptions?.logger === undefined &&
    testingOptions.logger === undefined
      ? { logger: false as const }
      : {}),
    ...options.compileOptions,
  };

  const moduleRef = await builder.compile(compileOptions);

  try {
    const appOptions: CreateTestingAppOptions = {
      ...(options.silentLogger && options.appOptions?.logger === undefined
        ? { logger: false as const }
        : {}),
      ...options.appOptions,
    };

    const app = moduleRef.createNestApplication(appOptions);

    if (options.configureApp) {
      await options.configureApp(app, moduleRef);
    }

    if (options.autoInit !== false) {
      await app.init();
    }

    const client = moduleRef.createTestClient(app, options.clientOptions);

    return {
      moduleRef,
      app,
      client,
      request: (reqOpts?: TestClientOptions) =>
        request(app, { ...options.clientOptions, ...reqOpts }),
      agent: (reqOpts?: TestClientOptions) =>
        request.agent(app, { ...options.clientOptions, ...reqOpts }),
      close: async () => {
        await moduleRef.close();
      },
    };
  } catch (err) {
    await moduleRef.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Scoped helper around `createTestApp()` that always tears down the application
 * and testing module in a `finally` block.
 */
export async function withTestApp<T>(
  metadata: ModuleMetadata,
  fn: (ctx: TestAppContext) => T | Promise<T>,
  options: CreateTestAppOptions = {},
): Promise<T> {
  const ctx = await createTestApp(metadata, options);
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/**
 * Convenience wrapper for zero-socket or live HTTP Supertest requests.
 * Accepts a `BunestApplication` directly (preferred for zero-socket E2E tests),
 * a `TestClient`, a base URL string, or a live listening Bun `Server`.
 */
export function httpRequest(
  target: SupertestTarget,
  options?: TestClientOptions,
): SupertestAgent {
  return request(target, options);
}
