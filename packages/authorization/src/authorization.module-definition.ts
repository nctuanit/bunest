import {
  APP_GUARD,
  ConfigurableModuleBuilder,
  type Provider,
} from "@bunest/common";
import { AUTHORIZATION_MODULE_OPTIONS } from "./authorization.constants";
import { AuthorizationGuard } from "./guards/authorization.guard";
import type {
  AuthorizationModuleExtras,
  AuthorizationModuleOptions,
} from "./interfaces/authorization-module-options.interface";

const extras: AuthorizationModuleExtras = {
  isGlobal: true,
  globalGuard: true,
  policies: [],
  imports: [],
};

const CHECKED_OPTIONS = Symbol("AUTHORIZATION_CHECKED_OPTIONS");

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<AuthorizationModuleOptions>({
    optionsInjectionToken: AUTHORIZATION_MODULE_OPTIONS,
  })
    .setClassMethodName("forRoot")
    .setFactoryMethodName("createAuthorizationOptions")
    .setExtras<AuthorizationModuleExtras>(
      extras,
      (definition, { isGlobal, globalGuard, policies = [], imports = [] }) => {
        const providers: Provider[] = [
          ...(definition.providers ?? []),
          ...policies,
          {
            provide: CHECKED_OPTIONS,
            inject: [AUTHORIZATION_MODULE_OPTIONS],
            useFactory: checkOptions,
          },
        ];
        if (globalGuard !== false) {
          providers.push({
            provide: APP_GUARD,
            useExisting: AuthorizationGuard,
          });
        }
        return {
          ...definition,
          global: isGlobal !== false,
          imports: [...(definition.imports ?? []), ...imports],
          providers,
          exports: [...(definition.exports ?? []), ...policies],
        };
      },
    )
    .build();

/**
 * What `forRootAsync()` takes: `useFactory` (with `inject` and `imports`),
 * `useClass` or `useExisting`, plus the structural options (`policies`,
 * `imports`, `globalGuard`, `isGlobal`) next to them.
 */
export type AuthorizationModuleAsyncOptions = typeof ASYNC_OPTIONS_TYPE;

function checkOptions(
  options: Record<string, unknown> | undefined,
): AuthorizationModuleOptions {
  const resolved: Record<string, unknown> = { ...options };
  for (const key of Object.keys(extras)) {
    if (resolved[key] !== undefined) {
      throw new Error(
        `AuthorizationModule: \`${key}\` is in the options the factory returned. It goes at the top level of ` +
          "forRootAsync(), next to useFactory, because it decides what the module registers.",
      );
    }
  }
  if (resolved.getUser !== undefined && typeof resolved.getUser !== "function") {
    throw new Error(
      "AuthorizationModule: `getUser` must be a function that returns the current user (or a promise of it).",
    );
  }
  return resolved as AuthorizationModuleOptions;
}
