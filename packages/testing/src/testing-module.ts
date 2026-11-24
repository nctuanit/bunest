import {
  isDynamicModule,
  type DynamicModule,
  type LogLevel,
  type LoggerService,
  type MicroserviceInstance,
  type ResponseContext,
  type Type,
} from "@bunest/core";
import {
  BunestApplication,
  BunestApplicationContext,
  type DIContainer,
  type ModuleNode,
  type RequestContainer,
} from "@bunest/core";
import { BunHttpAdapter } from "@bunest/core/http";
import { createMockRequest } from "./fixtures";
import type {
  CreateTestingAppOptions,
  CreateTestingMicroserviceOptions,
  TestClientOptions,
  TestingModuleCompileOptions,
} from "./interfaces/testing.interface";
import { TestClient } from "./test-client";

/**
 * Module-scoped lookup handle returned by `testingModule.select(TargetModule)`
 * enforcing strict visibility within the selected module while inheriting full
 * `BunestApplicationContext` capabilities (`get`, `resolve`, `ContextId`, `{ strict, each }`,
 * and chainable `select`).
 */
export class ScopedTestingModule extends BunestApplicationContext {
  constructor(
    container: DIContainer,
    moduleNode: ModuleNode,
    options: TestingModuleCompileOptions = {},
  ) {
    super(
      container,
      {
        ...options,
        shutdownHooks: false,
      },
      moduleNode.id,
      true,
    );
  }

  /**
   * Chains selection into another static or dynamic module within the same testing graph.
   */
  override select<T>(
    moduleType: Type<T> | DynamicModule,
    _options?: { abortOnError?: boolean },
  ): ScopedTestingModule {
    const targetNode = this.findModuleNode(moduleType);
    if (!targetNode) {
      const label = isDynamicModule(moduleType)
        ? moduleType.module.name || "<DynamicModule>"
        : moduleType.name || "<anonymous>";
      throw new Error(
        `Module "${label}" is not part of this TestingModule graph.`,
      );
    }

    return new ScopedTestingModule(this.container, targetNode, {
      ...this.options,
      lifecycleManager: this.lifecycle,
    });
  }
}

/**
 * Compiled testing module wrapping a Bunest `DIContainer`, supporting direct
 * provider/controller lookups (`get`/`resolve`/`select`), `ContextId` request
 * registration, full lifecycle hooks (`init`/`close`), `BunestApplication`
 * creation (`createBunestApplication` / `createNestApplication`), and
 * zero-socket `TestClient` HTTP testing.
 */
export class TestingModule extends BunestApplicationContext {
  private readonly createdApps: BunestApplication[] = [];

  constructor(
    container: DIContainer,
    options: TestingModuleCompileOptions = {},
  ) {
    super(container, options);
  }

  /**
   * Creates a full `BunestApplication` sharing this testing module's DI container,
   * overrides, and `LifecycleManager` (preventing double-fired init/shutdown hooks
   * or leaked shutdown signal listeners).
   */
  createBunestApplication(
    options: CreateTestingAppOptions = {},
  ): BunestApplication {
    const mergedOptions: CreateTestingAppOptions = {
      ...this.options,
      ...options,
      logger: options.logger !== undefined ? options.logger : this.logger,
      lifecycleManager: this.lifecycle,
    };
    const app = new BunestApplication(
      this.container,
      mergedOptions,
      mergedOptions.httpAdapter,
    );
    this.createdApps.push(app);
    return app;
  }

  /**
   * NestJS-compatible alias for `createBunestApplication(...)`.
   * Accepts either `(options?)` or `(httpAdapter, options?)`.
   */
  createNestApplication(options?: CreateTestingAppOptions): BunestApplication;
  createNestApplication(
    httpAdapter: BunHttpAdapter,
    options?: CreateTestingAppOptions,
  ): BunestApplication;
  createNestApplication(
    adapterOrOptions?: BunHttpAdapter | CreateTestingAppOptions,
    options?: CreateTestingAppOptions,
  ): BunestApplication {
    if (adapterOrOptions instanceof BunHttpAdapter) {
      return this.createBunestApplication({
        ...(options ?? {}),
        httpAdapter: adapterOrOptions,
      });
    }
    return this.createBunestApplication(adapterOrOptions);
  }

  /**
   * NestJS-compatible `createNestMicroservice()` attaching a `MicroserviceInstance`
   * (e.g., `MicroserviceHost` or transport server) to a hybrid testing app sharing
   * this `TestingModule`'s DI container and lifecycle.
   */
  createNestMicroservice<T extends MicroserviceInstance>(
    microservice: T,
    options?: CreateTestingMicroserviceOptions,
  ): T {
    const app = this.createBunestApplication({
      ...(options?.logger !== undefined ? { logger: options.logger } : {}),
    });
    return app.connectMicroservice(microservice, options);
  }

  /**
   * Creates an in-memory `TestClient` dispatching directly through `BunestApplication.fetch()`.
   * Pass an existing `BunestApplication` (plus optional `TestClientOptions`) to reuse its
   * configured global enhancers/prefix, or pass options to spin up a fresh `BunestApplication`.
   */
  createTestClient(
    app: BunestApplication,
    options?: TestClientOptions,
  ): TestClient;
  createTestClient(
    options?: CreateTestingAppOptions & TestClientOptions,
  ): TestClient;
  createTestClient(
    appOrOptions?:
      BunestApplication | (CreateTestingAppOptions & TestClientOptions),
    clientOptions?: TestClientOptions,
  ): TestClient {
    if (appOrOptions instanceof BunestApplication) {
      return TestClient.fromApp(appOrOptions, clientOptions);
    }

    const { baseUrl, defaultHeaders, defaultCookies, ...appOptions } =
      appOrOptions ?? {};
    const app = this.createBunestApplication(appOptions);
    return TestClient.fromApp(app, { baseUrl, defaultHeaders, defaultCookies });
  }

  /**
   * Creates a standalone `RequestContainer` seeded with a native Web `Request`
   * for isolated unit tests of `Scope.REQUEST` providers via `moduleRef.resolve(Token, reqContainer)`.
   */
  createRequestContainer(
    request: Request = createMockRequest("/"),
    responseContext?: ResponseContext,
  ): RequestContainer {
    return this.container.createRequestContainer(request, responseContext);
  }

  override useLogger(logger: LoggerService | LogLevel[] | false): this {
    super.useLogger(logger);
    for (const app of this.createdApps) {
      app.useLogger(logger);
    }
    return this;
  }

  override flushLogs(): void {
    super.flushLogs();
    for (const app of this.createdApps) {
      app.flushLogs();
    }
  }

  override async init(): Promise<this> {
    if (this.isInitialized && this.lifecycle.getIsInitialized()) {
      return this;
    }
    if (this.createdApps.length > 0) {
      const [primaryApp, ...extraApps] = this.createdApps;
      for (const extra of extraApps) {
        await extra.prepareHttpPipeline();
      }
      if (primaryApp) {
        await primaryApp.init();
      }
      this.isInitialized = true;
      return this;
    }
    return super.init();
  }

  /**
   * Narrows provider lookups (`get`/`resolve`) to a specific imported module
   * using strict module visibility (ADR-007). Supports static modules and `DynamicModule`s.
   */
  override select<T>(
    moduleType: Type<T> | DynamicModule,
    _options?: { abortOnError?: boolean },
  ): ScopedTestingModule {
    const mod = this.findModuleNode(moduleType);
    if (!mod) {
      const label = isDynamicModule(moduleType)
        ? moduleType.module.name || "<DynamicModule>"
        : moduleType.name || "<anonymous>";
      throw new Error(
        `Module "${label}" is not part of this TestingModule graph.`,
      );
    }
    return new ScopedTestingModule(this.container, mod, {
      ...this.options,
      lifecycleManager: this.lifecycle,
    });
  }

  /**
   * Closes all created `BunestApplication` instances (stopping any listening
   * HTTP servers), destroys registered `ContextId` containers, and runs shutdown
   * lifecycle hooks at most once via the shared `LifecycleManager`.
   */
  override async close(signal?: string): Promise<void> {
    if (this.isClosed && this.lifecycle.getIsClosed()) {
      return;
    }
    this.isClosed = true;

    if (this.createdApps.length > 0) {
      const [primaryApp, ...extraApps] = this.createdApps;
      for (const extra of extraApps) {
        await extra.getHttpAdapter().close();
      }
      if (primaryApp) {
        await primaryApp.close(signal);
      }
      return;
    }

    await super.close(signal);
  }
}
