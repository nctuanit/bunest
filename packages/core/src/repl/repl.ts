import * as nodeRepl from "node:repl";
import type { DynamicModule, InjectionToken, Type } from "@bunest/common";
import type { BunestApplicationContext } from "../application/bunest-application-context";
import { BunestFactory } from "../application/bunest-factory";
import { MetadataScanner } from "../discovery/metadata-scanner";
import type { IEntryNestModule } from "../interfaces/core-types.interface";

export interface ReplContextFunctions {
  get: <T = any>(token: InjectionToken<T>) => T;
  $: <T = any>(token: InjectionToken<T>) => T;
  resolve: <T = any>(token: InjectionToken<T>) => Promise<T>;
  select: <T>(moduleType: Type<T> | DynamicModule) => BunestApplicationContext;
  debug: (moduleCls?: Type<unknown> | string) => void;
  methods: (tokenOrInstance: InjectionToken | object) => string[];
  help: () => void;
}

/**
 * Builds the NestJS-compatible REPL helper context bound to an active
 * `BunestApplicationContext` (reusable in programmatic tests and interactive sessions).
 */
export function createReplContext(
  app: BunestApplicationContext,
): ReplContextFunctions {
  const metadataScanner = new MetadataScanner();

  const get = <T = any>(token: InjectionToken<T>): T =>
    app.get<T>(token, { strict: false });

  const resolve = <T = any>(token: InjectionToken<T>): Promise<T> =>
    app.resolve<T>(token, undefined, { strict: false });

  const select = <T>(
    moduleType: Type<T> | DynamicModule,
  ): BunestApplicationContext => app.select(moduleType);

  const debug = (moduleCls?: Type<unknown> | string): void => {
    const modules = app.getModules();
    const filterName =
      typeof moduleCls === "function" ? moduleCls.name : moduleCls;
    for (const mod of modules.values()) {
      if (filterName && mod.name !== filterName) {
        continue;
      }
      console.log(`\n${mod.name} (${mod.id}):`);
      if (mod.controllers.length > 0) {
        console.log("  - controllers:");
        for (const ctrl of mod.controllers) {
          console.log(`    ◻ ${ctrl.name || "<AnonymousController>"}`);
        }
      }
      if (mod.providers.size > 0) {
        console.log("  - providers:");
        for (const provider of mod.providers.values()) {
          const label =
            typeof provider.token === "function"
              ? provider.token.name
              : String(provider.token);
          console.log(`    ◻ ${label}`);
        }
      }
    }
  };

  const methods = (tokenOrInstance: InjectionToken | object): string[] => {
    let target: object | undefined;
    if (
      typeof tokenOrInstance === "string" ||
      typeof tokenOrInstance === "symbol"
    ) {
      const resolved = get<object>(tokenOrInstance);
      target =
        resolved && typeof resolved === "object"
          ? Object.getPrototypeOf(resolved)
          : undefined;
    } else if (typeof tokenOrInstance === "function") {
      target = tokenOrInstance.prototype;
    } else if (tokenOrInstance && typeof tokenOrInstance === "object") {
      target = Object.getPrototypeOf(tokenOrInstance);
    }

    const found = metadataScanner.getAllMethodNames(target);
    console.log("Methods:");
    for (const name of found) {
      console.log(`  ◻ ${name}`);
    }
    return found;
  };

  const help = (): void => {
    console.log(
      [
        "Available Bunest REPL functions:",
        "  get(token) / $(token)    Retrieve a singleton provider or controller instance",
        "  resolve(token)           Asynchronously resolve transient/request-scoped providers",
        "  select(ModuleClass)      Navigate into a specific module context",
        "  debug(ModuleClass?)      Print all registered modules, controllers, and providers",
        "  methods(tokenOrInstance) List all public methods on a provider or controller",
        "  help()                   Display this help text",
      ].join("\n"),
    );
  };

  return { get, $: get, resolve, select, debug, methods, help };
}

/**
 * Starts an interactive Bunest REPL session backed by `BunestFactory.createApplicationContext()`,
 * matching NestJS `@nestjs/core` `repl(AppModule)`.
 */
export async function repl(
  module: IEntryNestModule,
  replOptions?: nodeRepl.ReplOptions,
): Promise<nodeRepl.REPLServer> {
  const app = await BunestFactory.createApplicationContext(module, {
    abortOnError: false,
  });
  await app.init();

  const ctxFns = createReplContext(app);
  const server = nodeRepl.start({
    prompt: "> ",
    ignoreUndefined: true,
    ...replOptions,
  });

  Object.assign(server.context, ctxFns, { app });

  server.on("exit", () => {
    void app.close().catch(() => {});
  });

  return server;
}
