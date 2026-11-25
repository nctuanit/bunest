import type { DynamicModule, InjectionToken, Type } from "../common/index";
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

export interface ReplOptions {
  prompt?: string;
  ignoreUndefined?: boolean;
  useColors?: boolean;
  input?: AsyncIterable<string | Uint8Array>;
  output?: { write(chunk: string): unknown };
  eval?: (
    code: string,
    context: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  writer?: (value: unknown) => string;
}

export interface BunestReplServer {
  readonly context: Record<string, unknown>;
  readonly history: string[];
  readonly closed: boolean;
  displayPrompt(): void;
  evalLine(line: string): Promise<unknown>;
  on(event: "exit" | "reset", listener: (...args: any[]) => void): this;
  once(event: "exit" | "reset", listener: (...args: any[]) => void): this;
  off(event: "exit" | "reset", listener: (...args: any[]) => void): this;
  close(): void;
}

const AsyncFunctionCtor = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

function isValidIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

async function defaultEvalInContext(
  code: string,
  context: Record<string, unknown>,
): Promise<unknown> {
  const keys = Object.keys(context).filter(isValidIdentifier);
  const values = keys.map((k) => context[k]);

  // Try expression form first so `1 + 2`, `get(Svc)`, or `await resolve(Svc)` returns a value
  try {
    const exprFn = new AsyncFunctionCtor(
      ...keys,
      `"use strict"; return (${code});`,
    );
    return await exprFn(...values);
  } catch (exprErr) {
    if (!(exprErr instanceof SyntaxError)) {
      throw exprErr;
    }
  }

  // Fall back to statement form (e.g. `const x = 1;`, blocks, declarations)
  const stmtFn = new AsyncFunctionCtor(...keys, `"use strict"; ${code}`);
  return await stmtFn(...values);
}

class NativeBunReplServer implements BunestReplServer {
  readonly context: Record<string, unknown> = {};
  readonly history: string[] = [];
  private _closed = false;

  private readonly promptText: string;
  private readonly ignoreUndefined: boolean;
  private readonly writerFn: (value: unknown) => string;
  private readonly evalFn: (
    code: string,
    context: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  private readonly output: { write(chunk: string): unknown };
  private readonly listeners = new Map<
    "exit" | "reset",
    Set<(...args: any[]) => void>
  >();
  private cleanupInput?: () => void;

  constructor(options: ReplOptions = {}) {
    this.promptText = options.prompt ?? "> ";
    this.ignoreUndefined = options.ignoreUndefined ?? true;
    const useColors =
      options.useColors ?? Boolean(process.stdout && process.stdout.isTTY);
    this.writerFn =
      options.writer ??
      ((value: unknown) => Bun.inspect(value, { colors: useColors }));
    this.evalFn = options.eval ?? defaultEvalInContext;
    this.output = options.output ?? process.stdout;
  }

  get closed(): boolean {
    return this._closed;
  }

  displayPrompt(): void {
    if (!this._closed) {
      this.output.write(this.promptText);
    }
  }

  on(event: "exit" | "reset", listener: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: "exit" | "reset", listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: "exit" | "reset", listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: "exit" | "reset", ...args: any[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      fn(...args);
    }
  }

  async evalLine(rawLine: string): Promise<unknown> {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    if (trimmed === ".exit") {
      this.close();
      return undefined;
    }
    if (trimmed === ".help") {
      if (typeof this.context.help === "function") {
        (this.context.help as () => void)();
      } else {
        this.output.write(
          "REPL commands: .help, .history, .clear, .exit\n",
        );
      }
      return undefined;
    }
    if (trimmed === ".history") {
      this.output.write(`${this.history.join("\n")}\n`);
      return undefined;
    }
    if (trimmed === ".clear") {
      this.emit("reset", this.context);
      return undefined;
    }

    this.history.push(trimmed);
    const result = await this.evalFn(trimmed, this.context);
    this.context._ = result;
    if (result !== undefined || !this.ignoreUndefined) {
      this.output.write(`${this.writerFn(result)}\n`);
    }
    return result;
  }

  start(input?: AsyncIterable<string | Uint8Array>): void {
    if (input) {
      this.startAsyncIterable(input);
      return;
    }
    if (typeof process !== "undefined" && process.stdin) {
      this.startStdin();
    }
  }

  private startAsyncIterable(input: AsyncIterable<string | Uint8Array>): void {
    const decoder = new TextDecoder();
    const iterator = input[Symbol.asyncIterator]();
    let buffer = "";

    this.cleanupInput = () => {
      void iterator.return?.().catch(() => {});
    };

    void (async () => {
      try {
        this.displayPrompt();
        while (!this._closed) {
          const step = await iterator.next();
          if (step.done || this._closed) {
            break;
          }
          const chunk =
            typeof step.value === "string"
              ? step.value
              : decoder.decode(step.value, { stream: true });
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (let i = 0; i < lines.length && !this._closed; i++) {
            try {
              await this.evalLine(lines[i]!);
            } catch (err) {
              this.output.write(`${this.writerFn(err)}\n`);
            }
            this.displayPrompt();
          }
        }
        if (!this._closed && buffer.trim().length > 0) {
          try {
            await this.evalLine(buffer);
          } catch (err) {
            this.output.write(`${this.writerFn(err)}\n`);
          }
        }
      } finally {
        if (!this._closed) {
          this.close();
        }
      }
    })();
  }

  private startStdin(): void {
    const stdin = process.stdin;
    const decoder = new TextDecoder();
    let buffer = "";
    let chain = Promise.resolve();

    const onData = (chunk: Uint8Array | string) => {
      if (this._closed) return;
      buffer +=
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        chain = chain.then(async () => {
          if (this._closed) return;
          try {
            await this.evalLine(line);
          } catch (err) {
            this.output.write(`${this.writerFn(err)}\n`);
          }
          this.displayPrompt();
        });
      }
    };

    const onEnd = () => {
      chain = chain.then(async () => {
        if (!this._closed && buffer.trim().length > 0) {
          try {
            await this.evalLine(buffer);
          } catch (err) {
            this.output.write(`${this.writerFn(err)}\n`);
          }
        }
        this.close();
      });
    };

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume?.();

    this.cleanupInput = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause?.();
    };

    this.displayPrompt();
  }

  close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    const cleanup = this.cleanupInput;
    this.cleanupInput = undefined;
    cleanup?.();
    this.emit("exit");
  }
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

  const attachHelp = (fn: Function, description: string): void => {
    Object.defineProperty(fn, "help", {
      enumerable: false,
      configurable: true,
      get() {
        return description;
      },
    });
  };

  attachHelp(
    get,
    "get(token) / $(token) - Retrieve a singleton provider or controller instance.",
  );
  attachHelp(
    resolve,
    "resolve(token) - Asynchronously resolve transient or request-scoped providers.",
  );
  attachHelp(
    select,
    "select(ModuleClass) - Navigate into a specific module context.",
  );
  attachHelp(
    debug,
    "debug(ModuleClass?) - Print all registered modules, controllers, and providers.",
  );
  attachHelp(
    methods,
    "methods(tokenOrInstance) - List all public methods on a provider or controller.",
  );
  attachHelp(help, "help() - Display available Bunest REPL helper functions.");

  return { get, $: get, resolve, select, debug, methods, help };
}

/**
 * Starts a Bun-native interactive Bunest REPL session backed by
 * `BunestFactory.createApplicationContext()` and `Bun.inspect()`,
 * matching NestJS `@nestjs/core` `repl(AppModule)` with zero `node:repl` dependency.
 */
export async function repl(
  module: IEntryNestModule,
  replOptions?: ReplOptions,
): Promise<BunestReplServer> {
  const app = await BunestFactory.createApplicationContext(module, {
    abortOnError: false,
  });
  await app.init();

  const ctxFns = createReplContext(app);
  const server = new NativeBunReplServer({
    prompt: "> ",
    ignoreUndefined: true,
    ...replOptions,
  });

  Object.assign(server.context, ctxFns, { app });

  server.on("exit", () => {
    void app.close().catch(() => {});
  });

  server.start(replOptions?.input);

  return server;
}
