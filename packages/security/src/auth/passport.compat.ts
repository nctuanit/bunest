import type { CanActivate, ExecutionContext, Type } from "@bunest/core";
import { isFunction, isPromiseLike } from "@bunest/core/common";

export type { Type };

export type WithoutCallback<T extends any[]> = T extends any
  ? T extends [...infer U, infer C]
    ? C extends Function
      ? U
      : T
    : T
  : never;

type CtorParams7To5<T, Fallback> = T extends {
  new (...o: infer U1): void;
  new (...o: infer U2): void;
  new (...o: infer U3): void;
  new (...o: infer U4): void;
  new (...o: infer U5): void;
  new (...o: infer U6): void;
  new (...o: infer U7): void;
}
  ? U1 | U2 | U3 | U4 | U5 | U6 | U7
  : T extends {
        new (...o: infer U1): void;
        new (...o: infer U2): void;
        new (...o: infer U3): void;
        new (...o: infer U4): void;
        new (...o: infer U5): void;
        new (...o: infer U6): void;
      }
    ? U1 | U2 | U3 | U4 | U5 | U6
    : T extends {
          new (...o: infer U1): void;
          new (...o: infer U2): void;
          new (...o: infer U3): void;
          new (...o: infer U4): void;
          new (...o: infer U5): void;
        }
      ? U1 | U2 | U3 | U4 | U5
      : Fallback;

type CtorParams4To2<T, Fallback> = T extends {
  new (...o: infer U1): void;
  new (...o: infer U2): void;
  new (...o: infer U3): void;
  new (...o: infer U4): void;
}
  ? U1 | U2 | U3 | U4
  : T extends {
        new (...o: infer U1): void;
        new (...o: infer U2): void;
        new (...o: infer U3): void;
      }
    ? U1 | U2 | U3
    : T extends {
          new (...o: infer U1): void;
          new (...o: infer U2): void;
        }
      ? U1 | U2
      : Fallback;

type CtorParams1<T> = T extends { new (...o: infer U): void } ? U : never;

export type AllConstructorParameters<T> = CtorParams7To5<
  T,
  CtorParams4To2<T, CtorParams1<T>>
>;

export interface AuthGuardAuthenticateOptions {
  session?: boolean;
  property?: string;
  assignProperty?: string;
  failureRedirect?: string;
  successRedirect?: string;
  failureMessage?: boolean | string;
  successMessage?: boolean | string;
  scope?: string | string[];
  state?: string;
  prompt?: string;
  defaultStrategy?: never;
  [key: string]: unknown;
}

export type IAuthGuard = CanActivate & {
  logIn<TRequest extends { logIn: Function } = any>(
    request: TRequest,
  ): Promise<void>;
  handleRequest<TUser = any>(
    err: unknown,
    user: unknown,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser;
  getAuthenticateOptions(
    context: ExecutionContext,
  ):
    | Promise<AuthGuardAuthenticateOptions>
    | AuthGuardAuthenticateOptions
    | undefined;
  getRequest(context: ExecutionContext): any;
};

export type SerializeUserFn = (
  user: any,
  done: (err: unknown, id?: unknown) => void,
) => unknown;

export type DeserializeUserFn = (
  payload: any,
  done: (err: unknown, user?: unknown) => void,
) => unknown;

export interface PassportStrategyLike {
  readonly name?: string;
  authenticate?(req: unknown, options?: Record<string, unknown>): unknown;
  validate?(...args: any[]): unknown;
}

/**
 * Zero-dependency Bunest-native Passport-compatible strategy & serializer registry.
 */
export class BunestPassportInstance {
  private readonly strategies = new Map<string, PassportStrategyLike>();
  private readonly serializers: SerializeUserFn[] = [];
  private readonly deserializers: DeserializeUserFn[] = [];

  use(name: string, strategy: PassportStrategyLike): this;
  use(strategy: PassportStrategyLike): this;
  use(
    nameOrStrategy: string | PassportStrategyLike,
    maybeStrategy?: PassportStrategyLike,
  ): this {
    if (typeof nameOrStrategy === "string") {
      const name = nameOrStrategy.trim();
      if (!name) {
        throw new Error("Strategy name must be a non-empty string");
      }
      this.strategies.set(name, maybeStrategy!);
      return this;
    }

    const strategy = nameOrStrategy;
    const name: unknown = strategy?.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Passport strategy must declare a non-empty name");
    }
    this.strategies.set(name, strategy);
    return this;
  }

  unuse(name: string): this {
    this.strategies.delete(name);
    return this;
  }

  getStrategy(name: string): PassportStrategyLike | undefined {
    return this.strategies.get(name);
  }

  hasStrategy(name: string): boolean {
    return this.strategies.has(name);
  }

  listStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }

  serializeUser(fn: SerializeUserFn): void {
    this.serializers.push(fn);
  }

  deserializeUser(fn: DeserializeUserFn): void {
    this.deserializers.push(fn);
  }

  hasSerializers(): boolean {
    return this.serializers.length > 0;
  }

  hasDeserializers(): boolean {
    return this.deserializers.length > 0;
  }

  async serialize(user: unknown): Promise<unknown> {
    if (this.serializers.length === 0) {
      return user;
    }
    let lastErr: unknown;
    for (const fn of this.serializers) {
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          const done = (err: unknown, id?: unknown) => {
            if (settled) return;
            settled = true;
            if (err && err !== "pass") {
              reject(err);
            } else if (err === "pass") {
              resolve(PASS_SENTINEL);
            } else {
              resolve(id);
            }
          };
          const maybePromise = fn(user, done);
          if (isPromiseLike(maybePromise)) {
            Promise.resolve(maybePromise).catch((err: unknown) => {
              if (!settled) {
                settled = true;
                reject(err);
              }
            });
          }
        });
        if (result !== PASS_SENTINEL) {
          return result;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr !== undefined) {
      throw lastErr;
    }
    return user;
  }

  async deserialize(payload: unknown): Promise<unknown> {
    if (this.deserializers.length === 0) {
      return payload;
    }
    let lastErr: unknown;
    for (const fn of this.deserializers) {
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          const done = (err: unknown, user?: unknown) => {
            if (settled) return;
            settled = true;
            if (err && err !== "pass") {
              reject(err);
            } else if (err === "pass") {
              resolve(PASS_SENTINEL);
            } else {
              resolve(user);
            }
          };
          const maybePromise = fn(payload, done);
          if (isPromiseLike(maybePromise)) {
            Promise.resolve(maybePromise).catch((err: unknown) => {
              if (!settled) {
                settled = true;
                reject(err);
              }
            });
          }
        });
        if (result !== PASS_SENTINEL) {
          return result;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr !== undefined) {
      throw lastErr;
    }
    return payload;
  }

  clear(): void {
    this.strategies.clear();
    this.serializers.length = 0;
    this.deserializers.length = 0;
  }
}

const PASS_SENTINEL = Symbol("bunest:passport:pass");

export const defaultPassportInstance = new BunestPassportInstance();

export abstract class AbstractStrategy {
  abstract validate(...args: any[]): unknown;
}

export abstract class PassportSerializer {
  abstract serializeUser(user: any, done: Function): unknown;
  abstract deserializeUser(payload: any, done: Function): unknown;

  constructor() {
    const passportInstance = this.getPassportInstance();
    passportInstance.serializeUser((user, done) =>
      this.serializeUser(user, done),
    );
    passportInstance.deserializeUser((payload, done) =>
      this.deserializeUser(payload, done),
    );
  }

  getPassportInstance(): BunestPassportInstance {
    return defaultPassportInstance;
  }
}

abstract class PassportStrategyMixin<TValidationResult> {
  abstract validate(
    ...args: any[]
  ): TValidationResult | Promise<TValidationResult>;
}

/**
 * Zero-dependency NestJS `@nestjs/passport`-compatible `PassportStrategy` mixin.
 * Wraps a base strategy class, bridges `validate(...)` to a verification callback,
 * and auto-registers the instantiated strategy with Bunest's native Passport registry.
 */
export function PassportStrategy<
  T extends Type<any> = any,
  TUser = unknown,
  TValidationResult = TUser | false | null,
>(
  Strategy: T,
  name?: string,
  callbackArity?: true | number,
): {
  new (
    ...args: WithoutCallback<AllConstructorParameters<T>>
  ): InstanceType<T> & PassportStrategyMixin<TValidationResult>;
} {
  abstract class StrategyWithMixin extends Strategy {
    abstract validate(
      ...args: any[]
    ): TValidationResult | Promise<TValidationResult>;

    constructor(...args: any[]) {
      const callback = async (...params: any[]) => {
        const done = params[params.length - 1];
        try {
          const validateResult = await this.validate(...params);
          if (typeof done === "function") {
            if (Array.isArray(validateResult)) {
              done(null, ...validateResult);
            } else {
              done(null, validateResult);
            }
          }
          return validateResult;
        } catch (err) {
          if (typeof done === "function") {
            done(err, null);
            return;
          }
          throw err;
        }
      };

      if (callbackArity !== undefined) {
        const validateFn = new.target?.prototype?.validate;
        let arity: number | undefined;
        if (callbackArity !== true) {
          arity = callbackArity;
        } else if (isFunction(validateFn)) {
          arity = validateFn.length + 1;
        }
        if (arity !== undefined) {
          Object.defineProperty(callback, "length", {
            value: arity,
            configurable: true,
          });
        }
      }

      super(...args, callback);

      const passportInstance = this.getPassportInstance();
      const selfNamed = this as unknown as { name?: unknown };
      const existingName =
        typeof selfNamed.name === "string" && selfNamed.name.trim().length > 0
          ? selfNamed.name
          : undefined;
      const resolvedName = name ?? existingName ?? (Strategy.name || "default");

      if (name) {
        Object.defineProperty(this, "name", {
          value: resolvedName,
          configurable: true,
          writable: true,
          enumerable: true,
        });
        passportInstance.use(resolvedName, this);
      } else {
        if (!existingName) {
          Object.defineProperty(this, "name", {
            value: resolvedName,
            configurable: true,
            writable: true,
            enumerable: true,
          });
        }
        passportInstance.use(this);
      }
    }

    getPassportInstance(): BunestPassportInstance {
      return defaultPassportInstance;
    }
  }

  return StrategyWithMixin as unknown as {
    new (
      ...args: WithoutCallback<AllConstructorParameters<T>>
    ): InstanceType<T> & PassportStrategyMixin<TValidationResult>;
  };
}
