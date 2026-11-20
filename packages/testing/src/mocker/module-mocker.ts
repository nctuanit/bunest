import type { InjectionToken } from "@bunest/common";
import type { MockFactory } from "@bunest/core";

export interface MockCallResult {
  readonly type: "return" | "throw";
  readonly value: unknown;
}

/**
 * Lightweight zero-dependency callable spy function compatible with `bun:test`
 * and standalone auto-mocking (no `jest-mock` dependency required).
 */
export interface MockFunction<
  TArgs extends unknown[] = any[],
  TReturn = any,
> {
  (...args: TArgs): TReturn;
  readonly calls: TArgs[];
  readonly results: MockCallResult[];
  readonly callCount: number;
  readonly called: boolean;
  mockReturnValue(value: TReturn): this;
  mockReturnValueOnce(value: TReturn): this;
  mockResolvedValue<T = Awaited<TReturn>>(value: T): this;
  mockResolvedValueOnce<T = Awaited<TReturn>>(value: T): this;
  mockRejectedValue(error: unknown): this;
  mockRejectedValueOnce(error: unknown): this;
  mockImplementation(fn: (...args: TArgs) => TReturn): this;
  mockImplementationOnce(fn: (...args: TArgs) => TReturn): this;
  mockClear(): this;
  mockReset(): this;
  getMockName(): string;
  setMockName(name: string): this;
}

type OnceAction<TArgs extends unknown[], TReturn> =
  | { readonly kind: "impl"; readonly fn: (...args: TArgs) => TReturn }
  | { readonly kind: "return"; readonly value: TReturn };

/**
 * Creates a standalone callable `MockFunction` spy.
 */
export function createMockFn<
  TArgs extends unknown[] = any[],
  TReturn = any,
>(
  initialImpl?: (...args: TArgs) => TReturn,
  name = "bunest.fn()",
): MockFunction<TArgs, TReturn> {
  const calls: TArgs[] = [];
  const results: MockCallResult[] = [];
  let defaultImpl: ((...args: TArgs) => TReturn) | undefined = initialImpl;
  let hasDefaultReturn = false;
  let defaultReturnValue: TReturn | undefined;
  const onceQueue: OnceAction<TArgs, TReturn>[] = [];
  let displayName = name;

  const mockFn = function (this: unknown, ...args: TArgs): TReturn {
    calls.push(args);
    try {
      let output: TReturn;
      const nextOnce = onceQueue.shift();
      if (nextOnce) {
        output =
          nextOnce.kind === "impl"
            ? nextOnce.fn.apply(this, args)
            : nextOnce.value;
      } else if (defaultImpl) {
        output = defaultImpl.apply(this, args);
      } else if (hasDefaultReturn) {
        output = defaultReturnValue as TReturn;
      } else {
        output = undefined as TReturn;
      }
      results.push({ type: "return", value: output });
      return output;
    } catch (error) {
      results.push({ type: "throw", value: error });
      throw error;
    }
  } as MockFunction<TArgs, TReturn>;

  Object.defineProperties(mockFn, {
    calls: {
      enumerable: true,
      get: () => calls,
    },
    results: {
      enumerable: true,
      get: () => results,
    },
    callCount: {
      enumerable: true,
      get: () => calls.length,
    },
    called: {
      enumerable: true,
      get: () => calls.length > 0,
    },
  });

  mockFn.mockReturnValue = (value: TReturn) => {
    defaultImpl = undefined;
    hasDefaultReturn = true;
    defaultReturnValue = value;
    return mockFn;
  };

  mockFn.mockReturnValueOnce = (value: TReturn) => {
    onceQueue.push({ kind: "return", value });
    return mockFn;
  };

  mockFn.mockResolvedValue = <T = Awaited<TReturn>>(value: T) => {
    defaultImpl = () => Promise.resolve(value) as unknown as TReturn;
    hasDefaultReturn = false;
    return mockFn;
  };

  mockFn.mockResolvedValueOnce = <T = Awaited<TReturn>>(value: T) => {
    onceQueue.push({
      kind: "impl",
      fn: () => Promise.resolve(value) as unknown as TReturn,
    });
    return mockFn;
  };

  mockFn.mockRejectedValue = (error: unknown) => {
    defaultImpl = () => Promise.reject(error) as unknown as TReturn;
    hasDefaultReturn = false;
    return mockFn;
  };

  mockFn.mockRejectedValueOnce = (error: unknown) => {
    onceQueue.push({
      kind: "impl",
      fn: () => Promise.reject(error) as unknown as TReturn,
    });
    return mockFn;
  };

  mockFn.mockImplementation = (fn: (...args: TArgs) => TReturn) => {
    defaultImpl = fn;
    hasDefaultReturn = false;
    return mockFn;
  };

  mockFn.mockImplementationOnce = (fn: (...args: TArgs) => TReturn) => {
    onceQueue.push({ kind: "impl", fn });
    return mockFn;
  };

  mockFn.mockClear = () => {
    calls.length = 0;
    results.length = 0;
    return mockFn;
  };

  mockFn.mockReset = () => {
    calls.length = 0;
    results.length = 0;
    onceQueue.length = 0;
    defaultImpl = undefined;
    hasDefaultReturn = false;
    defaultReturnValue = undefined;
    return mockFn;
  };

  mockFn.getMockName = () => displayName;
  mockFn.setMockName = (nextName: string) => {
    displayName = nextName;
    return mockFn;
  };

  return mockFn;
}

export type MockMetadataType =
  | "object"
  | "array"
  | "regexp"
  | "function"
  | "constant"
  | "collection"
  | "null"
  | "undefined";

export interface MockMetadata<T = unknown> {
  ref?: number;
  refID?: number;
  type?: MockMetadataType;
  name?: string;
  value?: T;
  length?: number;
  members?: Record<string, MockMetadata<unknown>>;
  mockImpl?: T;
}

const SKIPPED_PROTOTYPE_KEYS = new Set<string | symbol>([
  "constructor",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

const SKIPPED_PROXY_KEYS = new Set<string | symbol>([
  "then",
  "catch",
  "finally",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
  "onRequestDestroy",
  Symbol.toStringTag,
  Symbol.toPrimitive,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.dispose,
  Symbol.asyncDispose,
]);

/**
 * Collects all method names along a class's prototype chain (stopping before `Object.prototype`).
 */
function collectPrototypeMethodNames(cls: Function): string[] {
  const names = new Set<string>();
  let current: object | null = cls.prototype as object | null;

  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (SKIPPED_PROTOTYPE_KEYS.has(key)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && typeof descriptor.value === "function") {
        names.add(key);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return [...names];
}

/**
 * Zero-dependency Bun-native `ModuleMocker` modeled after `jest-mock`'s `ModuleMocker`
 * so NestJS auto-mocking recipes (`useMocker`) work out of the box without external npm packages.
 */
export class ModuleMocker {
  constructor(readonly globalObject: typeof globalThis = globalThis) {}

  /**
   * Creates a callable `MockFunction` spy.
   */
  fn<TArgs extends unknown[] = any[], TReturn = any>(
    implementation?: (...args: TArgs) => TReturn,
  ): MockFunction<TArgs, TReturn> {
    return createMockFn(implementation);
  }

  /**
   * Inspects a class, function, or object and produces serializable `MockMetadata`
   * describing its methods and prototype members.
   */
  getMetadata<T = unknown>(
    component: T,
    refs = new Map<unknown, number>(),
  ): MockMetadata<T> | null {
    if (component === null) {
      return { type: "null" };
    }
    if (component === undefined) {
      return { type: "undefined" };
    }

    const kind = typeof component;
    if (
      kind === "string" ||
      kind === "number" ||
      kind === "boolean" ||
      kind === "symbol" ||
      kind === "bigint"
    ) {
      return { type: "constant", value: component };
    }

    if (component instanceof RegExp) {
      return { type: "regexp", value: component };
    }
    if (Array.isArray(component)) {
      return { type: "array" };
    }
    if (component instanceof Map || component instanceof Set) {
      return { type: "collection" };
    }

    const existingRef = refs.get(component);
    if (existingRef !== undefined) {
      return { ref: existingRef };
    }

    const refID = refs.size + 1;
    refs.set(component, refID);

    if (kind === "function") {
      const fn = component as unknown as Function;
      const members: Record<string, MockMetadata<unknown>> = {};

      // Static properties on the class/function
      for (const key of Object.getOwnPropertyNames(fn)) {
        if (
          key === "length" ||
          key === "name" ||
          key === "prototype" ||
          key === "arguments" ||
          key === "caller"
        ) {
          continue;
        }
        const desc = Object.getOwnPropertyDescriptor(fn, key);
        if (desc && typeof desc.value === "function") {
          members[key] = { type: "function", name: key };
        }
      }

      // Prototype methods along full inheritance chain
      const protoMethods = collectPrototypeMethodNames(fn);
      if (protoMethods.length > 0 || fn.prototype) {
        const protoMembers: Record<string, MockMetadata<unknown>> = {};
        for (const methodName of protoMethods) {
          protoMembers[methodName] = {
            type: "function",
            name: `${fn.name || "Mock"}.${methodName}`,
          };
        }
        members.prototype = {
          type: "object",
          members: protoMembers,
        };
      }

      return {
        refID,
        type: "function",
        name: fn.name || "Mock",
        length: fn.length,
        members,
      };
    }

    // Plain object
    const obj = component as Record<string, unknown>;
    const members: Record<string, MockMetadata<unknown>> = {};
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (SKIPPED_PROTOTYPE_KEYS.has(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || !("value" in desc)) {
        continue;
      }
      const childMeta = this.getMetadata(desc.value, refs);
      if (childMeta) {
        members[key] = childMeta;
      }
    }

    return {
      refID,
      type: "object",
      members,
    };
  }

  /**
   * Generates a runnable mock constructor, spy function, or object from `MockMetadata`.
   * For class tokens, returns a constructible class whose prototype methods are `MockFunction` spies,
   * supporting NestJS's canonical `const Mock = mocker.generateFromMetadata(meta); return new Mock();`.
   */
  generateFromMetadata<T = unknown>(metadata: MockMetadata<T>): T {
    return this.buildFromMetadata(metadata, new Map()) as T;
  }

  /**
   * Directly instantiates a mocked object for a class token without invoking its constructor.
   * Preserves `instanceof cls` and replaces every prototype method with a `MockFunction` spy.
   */
  mockClass<T extends object>(
    cls: abstract new (...args: any[]) => T,
  ): T & Record<string, MockFunction> {
    const instance = Object.create(
      cls.prototype as object,
    ) as Record<string, unknown>;
    const className = cls.name || "AnonymousClass";

    for (const methodName of collectPrototypeMethodNames(cls)) {
      instance[methodName] = createMockFn(
        undefined,
        `${className}.${methodName}`,
      );
    }

    return instance as T & Record<string, MockFunction>;
  }

  private buildFromMetadata(
    metadata: MockMetadata<unknown>,
    refs: Map<number, unknown>,
  ): unknown {
    if (metadata.ref !== undefined && refs.has(metadata.ref)) {
      return refs.get(metadata.ref);
    }

    switch (metadata.type) {
      case "null":
        return null;
      case "undefined":
        return undefined;
      case "constant":
        return metadata.value;
      case "regexp":
        return metadata.value instanceof RegExp
          ? new RegExp(metadata.value.source, metadata.value.flags)
          : /(?:)/;
      case "array":
        return [];
      case "collection":
        return new Map();
      case "function": {
        const protoMembers = metadata.members?.prototype?.members;
        if (protoMembers) {
          const mockName = metadata.name || "Mock";
          const MockCtor = function (this: Record<string, unknown>) {
            if (this && typeof this === "object") {
              for (const [methodName, memberMeta] of Object.entries(
                protoMembers,
              )) {
                if (memberMeta.type === "function") {
                  this[methodName] = createMockFn(
                    undefined,
                    memberMeta.name ?? `${mockName}.${methodName}`,
                  );
                }
              }
            }
          } as unknown as new (...args: unknown[]) => Record<string, unknown>;

          Object.defineProperty(MockCtor, "name", {
            value: mockName,
            configurable: true,
          });

          if (metadata.refID !== undefined) {
            refs.set(metadata.refID, MockCtor);
          }

          for (const [methodName, memberMeta] of Object.entries(protoMembers)) {
            if (memberMeta.type === "function") {
              (MockCtor.prototype as Record<string, unknown>)[methodName] =
                createMockFn(
                  undefined,
                  memberMeta.name ?? `${mockName}.${methodName}`,
                );
            }
          }

          if (metadata.members) {
            for (const [key, memberMeta] of Object.entries(metadata.members)) {
              if (key === "prototype") {
                continue;
              }
              (MockCtor as unknown as Record<string, unknown>)[key] =
                this.buildFromMetadata(memberMeta, refs);
            }
          }

          return MockCtor;
        }

        const fnMock = createMockFn(undefined, metadata.name ?? "mockFn");
        if (metadata.refID !== undefined) {
          refs.set(metadata.refID, fnMock);
        }
        return fnMock;
      }
      case "object": {
        const obj: Record<string, unknown> = {};
        if (metadata.refID !== undefined) {
          refs.set(metadata.refID, obj);
        }
        if (metadata.members) {
          for (const [key, memberMeta] of Object.entries(metadata.members)) {
            obj[key] = this.buildFromMetadata(memberMeta, refs);
          }
        }
        return obj;
      }
      default:
        return undefined;
    }
  }
}

export interface AutoMockerOptions {
  /**
   * Explicit per-token mock overrides checked before auto-generating mocks.
   */
  readonly overrides?:
    | ReadonlyMap<InjectionToken, unknown>
    | ReadonlyArray<readonly [InjectionToken, unknown]>;
  /**
   * Custom fallback factory invoked before default class auto-mocking.
   * Return `undefined` to fall through to default auto-mocking.
   */
  readonly customFactory?: MockFactory;
  /**
   * When `true`, unregistered string/symbol tokens receive a lazy Proxy whose
   * accessed methods return `MockFunction` spies.
   * When `false` (default), non-class tokens return `undefined` so missing
   * string/symbol tokens fail fast unless provided in `overrides` or `customFactory`.
   * @default false
   */
  readonly mockUnregisteredTokens?: boolean;
}

function createProxyMock(tokenName: string): Record<string, MockFunction> {
  const cache = new Map<string | symbol, MockFunction>();
  return new Proxy({} as Record<string, MockFunction>, {
    get(_target, prop) {
      if (SKIPPED_PROXY_KEYS.has(prop)) {
        return undefined;
      }
      let fn = cache.get(prop);
      if (!fn) {
        fn = createMockFn(undefined, `${tokenName}.${String(prop)}`);
        cache.set(prop, fn);
      }
      return fn;
    },
  });
}

/**
 * Creates a ready-to-use `MockFactory` for `TestingModuleBuilder.useMocker(...)`.
 *
 * @example
 * ```ts
 * const moduleRef = await Test.createTestingModule({
 *   providers: [UsersService],
 * })
 *   .useMocker(createAutoMocker())
 *   .compile();
 * ```
 */
export function createAutoMocker(options: AutoMockerOptions = {}): MockFactory {
  const mocker = new ModuleMocker();
  const overridesMap = new Map<InjectionToken, unknown>(
    options.overrides instanceof Map
      ? options.overrides.entries()
      : options.overrides ?? [],
  );

  return (token: InjectionToken): unknown => {
    if (overridesMap.has(token)) {
      return overridesMap.get(token);
    }

    if (options.customFactory) {
      const custom = options.customFactory(token);
      if (custom !== undefined) {
        return custom;
      }
    }

    if (typeof token === "function") {
      return mocker.mockClass(token as abstract new (...args: any[]) => object);
    }

    if (options.mockUnregisteredTokens) {
      return createProxyMock(String(token));
    }

    return undefined;
  };
}
