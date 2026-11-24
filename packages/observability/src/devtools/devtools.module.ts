import {
  Controller,
  Get,
  Inject,
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from "@bunest/core";
import {
  DEVTOOLS_OPTIONS,
  DevtoolsService,
  type DevtoolsApplicationGraph,
  type DevtoolsModuleAsyncOptions,
  type DevtoolsModuleOptions,
  type DevtoolsOptionsFactory,
  type DevtoolsRouteNode,
} from "./devtools.service";

function createDevtoolsController(basePath: string): Type<unknown> {
  @Controller(basePath)
  class DevtoolsController {
    constructor(
      @Inject(DevtoolsService)
      private readonly devtools: DevtoolsService,
    ) {}

    @Get("graph")
    getGraph(): DevtoolsApplicationGraph {
      this.devtools.assertEndpointsEnabled();
      return this.devtools.getGraph();
    }

    @Get("routes")
    getRoutes(): { routes: readonly DevtoolsRouteNode[] } {
      this.devtools.assertEndpointsEnabled();
      return { routes: this.devtools.getRoutes() };
    }

    @Get("mermaid")
    getMermaid(): Response {
      this.devtools.assertEndpointsEnabled();
      return new Response(this.devtools.toMermaidGraph(), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  return DevtoolsController;
}

function createAsyncOptionProviders(
  options: DevtoolsModuleAsyncOptions,
): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: DEVTOOLS_OPTIONS,
        useFactory: async (...args: unknown[]) =>
          (await options.useFactory!(...args)) ?? {},
        inject: options.inject ?? [],
      },
    ];
  }

  if (options.useClass) {
    const factoryClass = options.useClass;
    return [
      { provide: factoryClass, useClass: factoryClass },
      {
        provide: DEVTOOLS_OPTIONS,
        useFactory: async (factory: DevtoolsOptionsFactory) =>
          (await factory.createDevtoolsOptions()) ?? {},
        inject: [factoryClass],
      },
    ];
  }

  if (options.useExisting) {
    return [
      {
        provide: DEVTOOLS_OPTIONS,
        useFactory: async (factory: DevtoolsOptionsFactory) =>
          (await factory.createDevtoolsOptions()) ?? {},
        inject: [options.useExisting],
      },
    ];
  }

  throw new Error(
    'DevtoolsModule.registerAsync() requires one of "useFactory", "useClass", or "useExisting".',
  );
}

@Module({})
export class DevtoolsModule {
  /**
   * NestJS `@nestjs/devtools-integration` compatible synchronous registration.
   */
  static register(options: DevtoolsModuleOptions = {}): DynamicModule {
    const exposeEndpoints = options.exposeEndpoints ?? options.http ?? true;
    const basePath = options.path ?? "/_devtools";

    const controllers: Type<unknown>[] = exposeEndpoints
      ? [createDevtoolsController(basePath)]
      : [];

    return {
      module: DevtoolsModule,
      global: options.global,
      controllers,
      providers: [
        { provide: DEVTOOLS_OPTIONS, useValue: options },
        DevtoolsService,
      ],
      exports: [DEVTOOLS_OPTIONS, DevtoolsService],
    };
  }

  /**
   * NestJS `@nestjs/devtools-integration` compatible asynchronous registration.
   */
  static registerAsync(options: DevtoolsModuleAsyncOptions): DynamicModule {
    const exposeEndpoints = options.exposeEndpoints ?? options.http ?? true;
    const basePath = options.path ?? "/_devtools";

    const controllers: Type<unknown>[] = exposeEndpoints
      ? [createDevtoolsController(basePath)]
      : [];

    const asyncProviders = createAsyncOptionProviders(options);

    return {
      module: DevtoolsModule,
      global: options.global,
      imports: options.imports ?? [],
      controllers,
      providers: [
        ...asyncProviders,
        ...(options.extraProviders ?? []),
        DevtoolsService,
      ],
      exports: [DEVTOOLS_OPTIONS, DevtoolsService],
    };
  }

  /**
   * Bunest convenience alias for `DevtoolsModule.register()`.
   */
  static forRoot(options: DevtoolsModuleOptions = {}): DynamicModule {
    return DevtoolsModule.register(options);
  }

  /**
   * Bunest convenience alias for `DevtoolsModule.registerAsync()`.
   */
  static forRootAsync(options: DevtoolsModuleAsyncOptions): DynamicModule {
    return DevtoolsModule.registerAsync(options);
  }
}
