import type { Provider } from "../interfaces/provider.interface";
import type { InjectionToken, Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

/**
 * Symbol metadata key storing conditional provider/controller registration rules.
 */
export const CONDITION_METADATA_KEY = Symbol.for("bunest:metadata:conditions");

/**
 * Evaluation context passed to `@RegisterIf(...)` predicates and
 * `evaluateProviderConditions(...)`.
 */
export interface ConditionContext {
  readonly env: Record<string, string | undefined>;
  readonly profiles: ReadonlySet<string>;
  readonly registeredTokens: ReadonlySet<InjectionToken>;
  readonly target: Type<unknown>;
}

/**
 * Matcher accepted by `@RegisterIfEnv(key, matcher?)`.
 */
export type EnvConditionMatcher =
  | string
  | RegExp
  | ((value: string | undefined) => boolean);

/**
 * Stored conditional registration rule attached to a provider or controller class.
 */
export type ProviderCondition =
  | {
      readonly kind: "predicate";
      readonly phase: "eager";
      readonly predicate: (ctx: ConditionContext) => boolean;
    }
  | {
      readonly kind: "env";
      readonly phase: "eager";
      readonly key: string;
      readonly matcher?: EnvConditionMatcher;
    }
  | {
      readonly kind: "profile";
      readonly phase: "eager";
      readonly profiles: readonly string[];
    }
  | {
      readonly kind: "missing";
      readonly phase: "deferred";
      readonly token?: InjectionToken;
    };

function appendCondition(target: Function, condition: ProviderCondition): void {
  // Prepend on own constructor metadata so stacked decorators evaluate top-to-bottom
  // without ever mutating parent class metadata.
  MetadataRegistry.prependOwnArray<ProviderCondition>(
    CONDITION_METADATA_KEY,
    [condition],
    target,
  );
}

/**
 * Conditionally registers the decorated provider or controller only when
 * `predicate(ctx)` returns `true` during module scanning.
 */
export function RegisterIf(
  predicate: (ctx: ConditionContext) => boolean,
): ClassDecorator {
  return (target: Function) => {
    appendCondition(target, {
      kind: "predicate",
      phase: "eager",
      predicate,
    });
  };
}

/**
 * Conditionally registers the decorated provider or controller based on an
 * environment variable value (`Bun.env[key]`).
 *
 * - Without `matcher`: requires `env[key]` to be defined and non-empty (`!== ""`).
 * - With a `string` matcher: requires exact equality `env[key] === matcher`.
 * - With a `RegExp` matcher: requires `env[key]` to be defined and match the regex.
 * - With a function matcher: requires `matcher(env[key])` to return `true`.
 */
export function RegisterIfEnv(
  key: string,
  matcher?: EnvConditionMatcher,
): ClassDecorator {
  return (target: Function) => {
    appendCondition(target, {
      kind: "env",
      phase: "eager",
      key,
      ...(matcher !== undefined ? { matcher } : {}),
    });
  };
}

/**
 * Registers the decorated fallback provider ONLY when no unconditional or earlier
 * provider already provides `token` (defaults to the decorated class or its
 * explicit `{ provide }` token).
 *
 * Evaluated in pass 2 of `ModuleScanner`, after explicit/unconditional providers
 * have been collected, so user overrides always win cleanly.
 */
export function RegisterIfMissing(token?: InjectionToken): ClassDecorator {
  return (target: Function) => {
    appendCondition(target, {
      kind: "missing",
      phase: "deferred",
      ...(token !== undefined ? { token } : {}),
    });
  };
}

/**
 * Conditionally registers the decorated provider or controller based on active
 * runtime profiles (e.g. `@Profile("production")`, `@Profile("dev", "staging")`,
 * `@Profile("!test")`).
 *
 * Active profiles are resolved in order from:
 * 1. `BunestCreateOptions.profiles`
 * 2. `AutoModuleMetadata.profiles`
 * 3. `Bun.env.BUNEST_PROFILES` / `Bun.env.BUNEST_PROFILE`
 * 4. `Bun.env.NODE_ENV`
 */
export function Profile(...profiles: string[]): ClassDecorator {
  const normalized = profiles
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return (target: Function) => {
    appendCondition(target, {
      kind: "profile",
      phase: "eager",
      profiles: normalized,
    });
  };
}

/**
 * Returns all own `ProviderCondition` entries declared on a class or instance's
 * constructor (in top-to-bottom declaration order).
 */
export function getProviderConditions(
  target: object,
): readonly ProviderCondition[] {
  const ctor =
    typeof target === "function"
      ? target
      : (target as { constructor?: unknown }).constructor;
  if (typeof ctor !== "function") {
    return [];
  }
  return (
    MetadataRegistry.getOwn<readonly ProviderCondition[]>(
      CONDITION_METADATA_KEY,
      ctor,
    ) ?? []
  );
}

/**
 * Extracts the decorated implementation class (if any) and explicit DI token
 * from a class or `Provider` definition.
 */
export function getProviderConditionTarget(
  provider: Provider | Type<unknown>,
): {
  readonly targetClass?: Type<unknown>;
  readonly provideToken: InjectionToken;
} {
  if (typeof provider === "function") {
    return { targetClass: provider, provideToken: provider };
  }
  if ("useClass" in provider && typeof provider.useClass === "function") {
    return { targetClass: provider.useClass, provideToken: provider.provide };
  }
  return { provideToken: provider.provide };
}

/**
 * Returns `true` if `provider` carries at least one deferred (`@RegisterIfMissing`)
 * condition that must be evaluated in pass 2 of `ModuleScanner`.
 */
export function hasDeferredConditions(
  provider: Provider | Type<unknown>,
): boolean {
  const { targetClass } = getProviderConditionTarget(provider);
  if (!targetClass) {
    return false;
  }
  const conditions = getProviderConditions(targetClass);
  for (let i = 0; i < conditions.length; i++) {
    if (conditions[i]!.phase === "deferred") {
      return true;
    }
  }
  return false;
}

function evaluateEnvCondition(
  key: string,
  matcher: EnvConditionMatcher | undefined,
  env: Record<string, string | undefined>,
): boolean {
  const value = env[key];
  if (matcher === undefined) {
    return value !== undefined && value !== "";
  }
  if (typeof matcher === "string") {
    return value === matcher;
  }
  if (matcher instanceof RegExp) {
    if (value === undefined) {
      return false;
    }
    matcher.lastIndex = 0;
    return matcher.test(value);
  }
  return Boolean(matcher(value));
}

function evaluateProfileCondition(
  expressions: readonly string[],
  activeProfiles: ReadonlySet<string>,
): boolean {
  if (expressions.length === 0) {
    return true;
  }
  const positives: string[] = [];
  const negatives: string[] = [];

  for (let i = 0; i < expressions.length; i++) {
    const expr = expressions[i]!.trim();
    if (!expr) {
      continue;
    }
    if (expr.startsWith("!")) {
      const negated = expr.slice(1).trim();
      if (negated) {
        negatives.push(negated);
      }
    } else {
      positives.push(expr);
    }
  }

  for (let i = 0; i < negatives.length; i++) {
    if (activeProfiles.has(negatives[i]!)) {
      return false;
    }
  }

  if (positives.length === 0) {
    return true;
  }

  for (let i = 0; i < positives.length; i++) {
    if (activeProfiles.has(positives[i]!)) {
      return true;
    }
  }
  return false;
}

function evaluateSingleCondition(
  condition: ProviderCondition,
  provideToken: InjectionToken,
  ctx: ConditionContext,
): boolean {
  switch (condition.kind) {
    case "predicate":
      return Boolean(condition.predicate(ctx));
    case "env":
      return evaluateEnvCondition(condition.key, condition.matcher, ctx.env);
    case "profile":
      return evaluateProfileCondition(condition.profiles, ctx.profiles);
    case "missing": {
      const checkToken = condition.token ?? provideToken;
      return !ctx.registeredTokens.has(checkToken);
    }
  }
}

export type PartialConditionContext = Omit<ConditionContext, "target"> & {
  readonly target?: Type<unknown>;
};

/**
 * Evaluates ALL conditions (`@RegisterIf`, `@RegisterIfEnv`, `@Profile`,
 * `@RegisterIfMissing`) attached to `provider` against `ctx`.
 */
export function evaluateProviderConditions(
  provider: Provider | Type<unknown>,
  ctx: PartialConditionContext,
): boolean {
  const { targetClass, provideToken } = getProviderConditionTarget(provider);
  if (!targetClass) {
    return true;
  }
  const conditions = getProviderConditions(targetClass);
  if (conditions.length === 0) {
    return true;
  }
  const fullCtx: ConditionContext = {
    env: ctx.env,
    profiles: ctx.profiles,
    registeredTokens: ctx.registeredTokens,
    target: targetClass,
  };
  for (let i = 0; i < conditions.length; i++) {
    if (!evaluateSingleCondition(conditions[i]!, provideToken, fullCtx)) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates ONLY pass-1 eager conditions (`@RegisterIf`, `@RegisterIfEnv`, `@Profile`).
 */
export function evaluateEagerProviderConditions(
  provider: Provider | Type<unknown>,
  ctx: PartialConditionContext,
): boolean {
  const { targetClass, provideToken } = getProviderConditionTarget(provider);
  if (!targetClass) {
    return true;
  }
  const conditions = getProviderConditions(targetClass);
  if (conditions.length === 0) {
    return true;
  }
  const fullCtx: ConditionContext = {
    env: ctx.env,
    profiles: ctx.profiles,
    registeredTokens: ctx.registeredTokens,
    target: targetClass,
  };
  for (let i = 0; i < conditions.length; i++) {
    const cond = conditions[i]!;
    if (cond.phase !== "eager") {
      continue;
    }
    if (!evaluateSingleCondition(cond, provideToken, fullCtx)) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates ONLY pass-2 deferred conditions (`@RegisterIfMissing`).
 */
export function evaluateDeferredProviderConditions(
  provider: Provider | Type<unknown>,
  ctx: PartialConditionContext,
): boolean {
  const { targetClass, provideToken } = getProviderConditionTarget(provider);
  if (!targetClass) {
    return true;
  }
  const conditions = getProviderConditions(targetClass);
  if (conditions.length === 0) {
    return true;
  }
  const fullCtx: ConditionContext = {
    env: ctx.env,
    profiles: ctx.profiles,
    registeredTokens: ctx.registeredTokens,
    target: targetClass,
  };
  for (let i = 0; i < conditions.length; i++) {
    const cond = conditions[i]!;
    if (cond.phase !== "deferred") {
      continue;
    }
    if (!evaluateSingleCondition(cond, provideToken, fullCtx)) {
      return false;
    }
  }
  return true;
}

/**
 * Parses comma-delimited strings or string arrays into trimmed non-empty profile names.
 */
export function parseProfilesList(
  raw: string | readonly string[] | undefined,
): string[] {
  if (raw === undefined) {
    return [];
  }
  const items = typeof raw === "string" ? raw.split(",") : raw;
  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const part = items[i];
    if (typeof part !== "string") {
      continue;
    }
    const subParts = part.split(",");
    for (let j = 0; j < subParts.length; j++) {
      const trimmed = subParts[j]!.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

export interface ResolveActiveProfilesOptions {
  readonly explicitProfiles?: readonly string[];
  readonly moduleProfiles?: readonly string[];
  readonly env?: Record<string, string | undefined>;
}

/**
 * Resolves the active runtime profile set following Bunest's precedence:
 * 1. `BunestCreateOptions.profiles` (`explicitProfiles`)
 * 2. `AutoModuleMetadata.profiles` (`moduleProfiles`)
 * 3. `env.BUNEST_PROFILES` / `env.BUNEST_PROFILE`
 * 4. `env.NODE_ENV`
 */
export function resolveActiveProfiles(
  options: ResolveActiveProfilesOptions = {},
): Set<string> {
  if (options.explicitProfiles !== undefined) {
    return new Set(parseProfilesList(options.explicitProfiles));
  }
  if (options.moduleProfiles !== undefined) {
    return new Set(parseProfilesList(options.moduleProfiles));
  }
  const env = options.env ?? (Bun.env as Record<string, string | undefined>);
  const bunestProfiles = env.BUNEST_PROFILES;
  if (bunestProfiles !== undefined && bunestProfiles.trim().length > 0) {
    return new Set(parseProfilesList(bunestProfiles));
  }
  const bunestProfile = env.BUNEST_PROFILE;
  if (bunestProfile !== undefined && bunestProfile.trim().length > 0) {
    return new Set(parseProfilesList(bunestProfile));
  }
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== undefined && nodeEnv.trim().length > 0) {
    return new Set(parseProfilesList(nodeEnv));
  }
  return new Set();
}
