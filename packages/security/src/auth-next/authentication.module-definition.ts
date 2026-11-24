import {
  APP_GUARD,
  ConfigurableModuleBuilder,
  Logger,
  type FactoryProvider,
} from "@bunest/core";
import {
  AUTHENTICATION_MODULE_OPTIONS,
  AUTHENTICATION_STORAGE_REQUIREMENTS,
} from "./authentication.constants";
import { AuthenticationGuard } from "./guards/authentication.guard";
import type {
  AuthenticationModuleExtras,
  AuthenticationModuleOptions,
} from "./interfaces/authentication-module-options.interface";
import {
  AuthenticationRegistry,
  LOCK_REGISTRY,
} from "./services/authentication-registry.service";
import { SessionCookieProvider } from "./session/session-cookie.provider";
import {
  contractsUsedBy,
  type AuthenticationFeature,
  type AuthenticationStorageRequirements,
} from "./storage/authentication.storage";

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<AuthenticationModuleOptions>({
    optionsInjectionToken: AUTHENTICATION_MODULE_OPTIONS,
  })
    .setClassMethodName("forRoot")
    .setFactoryMethodName("createAuthenticationOptions")
    .setExtras<AuthenticationModuleExtras>(
      { isGlobal: true, globalGuard: true },
      (definition, extras) => ({
        ...definition,
        global: extras.isGlobal ?? true,
        providers: [
          ...(definition.providers ?? []),
          ...(extras.globalGuard === false
            ? []
            : [{ provide: APP_GUARD, useExisting: AuthenticationGuard }]),
        ],
      }),
    )
    .build();

/**
 * What `forRootAsync()` takes: `useFactory` (with `inject` and `imports`),
 * `useClass` or `useExisting`, plus `globalGuard` and `isGlobal` next to them.
 */
export type AuthenticationModuleAsyncOptions = typeof ASYNC_OPTIONS_TYPE;

/** @internal The module options, once `startupChecks()` accepted them. */
export const CHECKED_OPTIONS: unique symbol = Symbol(
  "AUTHENTICATION_CHECKED_OPTIONS",
);

/**
 * @internal Runs once at startup: fails on options that don't exist, then warns
 * about lifetimes that look like seconds.
 */
export const startupChecks: FactoryProvider<AuthenticationModuleOptions> = {
  provide: CHECKED_OPTIONS,
  inject: [AUTHENTICATION_MODULE_OPTIONS],
  useFactory: (resolved: AuthenticationModuleOptions | undefined) => {
    const options = resolved ?? {};
    checkKeys(options as Record<string, unknown>);
    const logger = new Logger("AuthenticationModule");
    warnShortLifetimes(options, logger);
    warnIdleSwitches(options, logger);
    return options;
  },
};

/**
 * @internal The storage contracts the configured features use, for the
 * production guard.
 */
export const storageRequirements: FactoryProvider<AuthenticationStorageRequirements> =
  {
    provide: AUTHENTICATION_STORAGE_REQUIREMENTS,
    inject: [CHECKED_OPTIONS, AuthenticationRegistry],
    useFactory: (
      options: AuthenticationModuleOptions,
      registry: AuthenticationRegistry,
    ) => ({
      get contracts() {
        registry[LOCK_REGISTRY]();
        const enabled: Record<AuthenticationFeature, boolean> = {
          sessionCookie: registry.providers.some(
            (provider) => provider instanceof SessionCookieProvider,
          ),
          refreshToken:
            options.accessToken !== undefined && options.refreshToken !== false,
          mfa: options.mfa !== undefined,
          magicLink: options.magicLink !== undefined,
          oidc: options.oidc !== undefined,
          passwordReset: options.passwordReset !== undefined,
          emailVerification: options.emailVerification !== undefined,
        };
        return contractsUsedBy(
          (Object.keys(enabled) as AuthenticationFeature[]).filter(
            (feature) => enabled[feature],
          ),
        );
      },
      allowInMemoryStorage: options.allowInMemoryStorage === true,
    }),
  };

const KNOWN_OPTIONS = new Set([
  "session",
  "password",
  "mfa",
  "magicLink",
  "accessToken",
  "refreshToken",
  "oidc",
  "passwordReset",
  "emailVerification",
  "allowInMemoryStorage",
]);

const REGISTERED: Record<string, string> = {
  providers:
    "credential providers register themselves: provide the class in one of your modules, and call " +
    "`registry.registerProvider(this, { order })` from its constructor, with `registry: AuthenticationRegistry` injected",
  magicLinkHandler:
    "handlers register themselves: `registry.registerHandler('magicLink', this)` from the handler's constructor",
  oidcAccountResolver:
    "handlers register themselves: `registry.registerHandler('oidc', this)` from the resolver's constructor",
  passwordResetHandler:
    "handlers register themselves: `registry.registerHandler('passwordReset', this)` from the handler's constructor",
  emailVerificationHandler:
    "handlers register themselves: `registry.registerHandler('emailVerification', this)` from the handler's constructor",
  oidcPath:
    "the OIDC routes are your own controller now, calling OidcService; set `oidc.callbackUrl` to its callback URL",
  imports:
    "forRoot() takes values only; forRootAsync() takes `imports` for its factory",
  stores:
    "storage is registered by a provider: implement the store interfaces in an @Injectable() class and call " +
    "`storage.registerSource({ sessions: this, ... })` from its constructor, with `storage: AuthenticationStorage` injected",
};

function checkKeys(options: Record<string, unknown>): void {
  for (const key of Object.keys(options)) {
    if (KNOWN_OPTIONS.has(key)) {
      continue;
    }
    if (key === "isGlobal" || key === "globalGuard") {
      throw new Error(
        `AuthenticationModule: \`${key}\` is in the options the factory returned. It goes at the top level of ` +
          "forRootAsync(), next to useFactory, because it decides what the module registers.",
      );
    }
    const hint = REGISTERED[key];
    throw new Error(
      `AuthenticationModule: \`${key}\` is not an option` +
        (hint
          ? `: ${hint}.`
          : `. The options are ${[...KNOWN_OPTIONS].join(", ")}.`),
    );
  }
}

function warnIdleSwitches(
  options: AuthenticationModuleOptions,
  logger: Logger,
): void {
  if (options.refreshToken === false && options.accessToken === undefined) {
    logger.warn(
      "`refreshToken: false` has no effect without `accessToken`: refresh tokens are only issued with access tokens.",
    );
  }
}

const LIFETIMES: readonly [
  string,
  (options: AuthenticationModuleOptions) => unknown,
][] = [
  ["accessToken.ttl", (options) => options.accessToken?.ttl],
  ["refreshToken.ttl", (options) => (options.refreshToken || undefined)?.ttl],
  [
    "refreshToken.absoluteTtl",
    (options) => (options.refreshToken || undefined)?.absoluteTtl,
  ],
  ["session.absoluteTtl", (options) => options.session?.absoluteTtl],
  ["session.idleTtl", (options) => options.session?.idleTtl],
  ["mfa.pendingTtl", (options) => options.mfa?.pendingTtl],
  ["magicLink.ttl", (options) => options.magicLink?.ttl],
  ["oidc.transactionTtl", (options) => options.oidc?.transactionTtl],
  ["passwordReset.ttl", (options) => options.passwordReset?.ttl],
  ["emailVerification.ttl", (options) => options.emailVerification?.ttl],
];

function warnShortLifetimes(
  options: AuthenticationModuleOptions,
  logger: Logger,
): void {
  for (const [path, read] of LIFETIMES) {
    const value = read(options);
    if (typeof value !== "number" || !(value > 0 && value < 60_000)) {
      continue;
    }
    logger.warn(
      `\`${path}\` is ${value} milliseconds. Numeric lifetimes are milliseconds, not seconds as in ` +
        `@nestjs/jwt: did you mean '${asSeconds(value)}'?`,
    );
  }
}

function asSeconds(value: number): string {
  if (value % 3_600 === 0) {
    return `${value / 3_600}h`;
  }
  if (value % 60 === 0) {
    return `${value / 60}m`;
  }
  return `${value}s`;
}
