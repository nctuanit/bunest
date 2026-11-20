import type { CanActivate, ExecutionContext, Type } from "@bunest/common";

export type { Type };

export type WithoutCallback<T extends any[]> = T extends any
  ? T extends [...infer U, infer C]
    ? C extends Function
      ? U
      : T
    : T
  : never;

export type AllConstructorParameters<T> = T extends {
  new (...o: infer U): void;
  new (...o: infer U2): void;
  new (...o: infer U3): void;
  new (...o: infer U4): void;
  new (...o: infer U5): void;
  new (...o: infer U6): void;
  new (...o: infer U7): void;
}
  ? U | U2 | U3 | U4 | U5 | U6 | U7
  : T extends {
        new (...o: infer U): void;
        new (...o: infer U2): void;
        new (...o: infer U3): void;
        new (...o: infer U4): void;
        new (...o: infer U5): void;
        new (...o: infer U6): void;
      }
    ? U | U2 | U3 | U4 | U5 | U6
    : T extends {
          new (...o: infer U): void;
          new (...o: infer U2): void;
          new (...o: infer U3): void;
          new (...o: infer U4): void;
          new (...o: infer U5): void;
        }
      ? U | U2 | U3 | U4 | U5
      : T extends {
            new (...o: infer U): void;
            new (...o: infer U2): void;
            new (...o: infer U3): void;
            new (...o: infer U4): void;
          }
        ? U | U2 | U3 | U4
        : T extends {
              new (...o: infer U): void;
              new (...o: infer U2): void;
              new (...o: infer U3): void;
            }
          ? U | U2 | U3
          : T extends {
                new (...o: infer U): void;
                new (...o: infer U2): void;
              }
            ? U | U2
            : T extends {
                  new (...o: infer U): void;
                }
              ? U
              : never;

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
  [key: string]: any;
}

export type IAuthGuard = CanActivate & {
  logIn<TRequest extends { logIn: Function } = any>(
    request: TRequest,
  ): Promise<void>;
  handleRequest<TUser = any>(
    err: any,
    user: any,
    info: any,
    context: ExecutionContext,
    status?: any,
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
  done: (err: any, id?: any) => void,
) => any;

export type DeserializeUserFn = (
  payload: any,
  done: (err: any, user?: any) => void,
) => any;

/**
 * Zero-dependency Bunest-native Passport-compatible strategy & serializer registry.
 */
export class BunestPassportInstance {
  private readonly strategies = new Map<string, any>();
  private readonly serializers: SerializeUserFn[] = [];
  private readonly deserializers: DeserializeUserFn[] = [];

  use(name: string, strategy: any): this;
  use(strategy: any): this;
  use(nameOrStrategy: string | any, maybeStrategy?: any): this {
    if (typeof nameOrStrategy === "string") {
      const name = nameOrStrategy.trim();
      if (!name) {
        throw new Error("Strategy name must be a non-empty string");
      }
      this.strategies.set(name, maybeStrategy);
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

  getStrategy(name: string): any | undefined {
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

  async serialize(user: any): Promise<any> {
    if (this.serializers.length === 0) {
      return user;
    }
    let lastErr: unknown;
    for (const fn of this.serializers) {
      try {
        const result = await new Promise<any>((resolve, reject) => {
          let settled = false;
          const done = (err: any, id?: any) => {
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
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.catch((err: unknown) => {
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

  async deserialize(payload: any): Promise<any> {
    if (this.deserializers.length === 0) {
      return payload;
    }
    let lastErr: unknown;
    for (const fn of this.deserializers) {
      try {
        const result = await new Promise<any>((resolve, reject) => {
          let settled = false;
          const done = (err: any, user?: any) => {
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
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.catch((err: unknown) => {
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
  abstract validate(...args: any[]): any;
}

export abstract class PassportSerializer {
  abstract serializeUser(user: any, done: Function): any;
  abstract deserializeUser(payload: any, done: Function): any;

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
        const arity =
          callbackArity === true
            ? typeof validateFn === "function"
              ? validateFn.length + 1
              : undefined
            : callbackArity;
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
