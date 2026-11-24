import {
  APP_GUARD,
  Inject,
  Module,
  Optional,
  type BunestModule,
  type DynamicModule,
  type MiddlewareConsumer,
  type ModuleImport,
  type Provider,
} from "@bunest/core";
import {
  JWT_AUTH_GUARD_OPTIONS,
  JwtAuthGuard,
  type JwtAuthGuardOptions,
} from "./auth/jwt-auth.guard";
import { PoliciesGuard } from "./auth/policies.guard";
import {
  ROLES_GUARD_OPTIONS,
  RolesGuard,
  type RolesGuardOptions,
} from "./auth/roles.guard";
import {
  SECURITY_HEADERS_OPTIONS,
  SecurityHeadersMiddleware,
  type SecurityHeadersOptions,
} from "./headers/security-headers.middleware";
import type { JwtModuleOptions } from "./jwt/jwt.interface";
import { JwtModule } from "./jwt/jwt.module";
import { ThrottlerGuard } from "./throttler/throttler.guard";
import type { ThrottlerModuleOptions } from "./throttler/throttler.interface";
import { ThrottlerModule } from "./throttler/throttler.module";

export const SECURITY_MODULE_OPTIONS = Symbol.for(
  "bunest:security:module_options",
);

export interface SecurityModuleGlobalGuardsOptions {
  /** Register `JwtAuthGuard` as a global `APP_GUARD` (defaults to `Boolean(options.jwt)`). */
  jwt?: boolean;
  /** Register `RolesGuard` as a global `APP_GUARD` (defaults to `true`). */
  roles?: boolean;
  /** Register `PoliciesGuard` as a global `APP_GUARD` (defaults to `true`). */
  policies?: boolean;
  /** Register `ThrottlerGuard` as a global `APP_GUARD` (defaults to `Boolean(options.throttler)`). */
  throttler?: boolean;
}

export interface SecurityModuleOptions {
  /**
   * Configures `JwtModule.register(jwt)` and provides `JwtService` + `JwtAuthGuard`.
   */
  jwt?: JwtModuleOptions;
  /**
   * Optional configuration passed to `JwtAuthGuard` via `JWT_AUTH_GUARD_OPTIONS`.
   */
  jwtGuard?: JwtAuthGuardOptions;
  /**
   * Optional configuration passed to `RolesGuard` via `ROLES_GUARD_OPTIONS`.
   */
  rolesGuard?: RolesGuardOptions;
  /**
   * Configures `ThrottlerModule.forRoot(throttler)` and provides `ThrottlerGuard`.
   */
  throttler?: ThrottlerModuleOptions;
  /**
   * Automatically registers `APP_GUARD` providers for enabled guards without
   * repeating manual `{ provide: APP_GUARD, useClass: ... }` boilerplate.
   */
  globalGuards?: boolean | SecurityModuleGlobalGuardsOptions;
  /**
   * Applies `SecurityHeadersMiddleware` to all routes (`forRoutes("*")`).
   * Pass `true` for safe defaults or a `SecurityHeadersOptions` object.
   */
  securityHeaders?: boolean | SecurityHeadersOptions;
  /**
   * Registers `SecurityModule` globally so guards, `JwtService`, and options
   * are injectable across all feature modules.
   * @default true
   */
  global?: boolean;
  /** Alias for `global`. */
  isGlobal?: boolean;
}

/**
 * One-line declarative security module composing `JwtModule`, `ThrottlerModule`,
 * global `APP_GUARD` wiring (`ThrottlerGuard`, `JwtAuthGuard`, `RolesGuard`,
 * `PoliciesGuard`), and `SecurityHeadersMiddleware`.
 */
@Module({})
export class SecurityModule implements BunestModule {
  constructor(
    @Optional()
    @Inject(SECURITY_MODULE_OPTIONS)
    private readonly options: SecurityModuleOptions = {},
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    if (this.options.securityHeaders) {
      consumer.apply(SecurityHeadersMiddleware).forRoutes("*");
    }
  }

  static forRoot(options: SecurityModuleOptions = {}): DynamicModule {
    const isGlobal = options.global ?? options.isGlobal ?? true;
    const imports: ModuleImport[] = [];
    const providers: Provider[] = [
      { provide: SECURITY_MODULE_OPTIONS, useValue: options },
      RolesGuard,
      PoliciesGuard,
    ];
    const exportsList: NonNullable<DynamicModule["exports"]> = [
      SECURITY_MODULE_OPTIONS,
      RolesGuard,
      PoliciesGuard,
    ];

    if (options.jwt) {
      const jwtMod = JwtModule.register({
        ...options.jwt,
        global: options.jwt.global ?? isGlobal,
      });
      imports.push(jwtMod);
      exportsList.push(jwtMod);
      providers.push(JwtAuthGuard);
      exportsList.push(JwtAuthGuard);
    }

    if (options.jwtGuard) {
      providers.push({
        provide: JWT_AUTH_GUARD_OPTIONS,
        useValue: options.jwtGuard,
      });
      exportsList.push(JWT_AUTH_GUARD_OPTIONS);
    }

    if (options.rolesGuard) {
      providers.push({
        provide: ROLES_GUARD_OPTIONS,
        useValue: options.rolesGuard,
      });
      exportsList.push(ROLES_GUARD_OPTIONS);
    }

    if (options.throttler) {
      const throttlerMod = ThrottlerModule.forRoot(options.throttler);
      imports.push(throttlerMod);
      exportsList.push(throttlerMod);
    }

    if (options.securityHeaders) {
      const headerOpts: SecurityHeadersOptions =
        typeof options.securityHeaders === "object"
          ? options.securityHeaders
          : {};
      providers.push(
        { provide: SECURITY_HEADERS_OPTIONS, useValue: headerOpts },
        SecurityHeadersMiddleware,
      );
      exportsList.push(SECURITY_HEADERS_OPTIONS, SecurityHeadersMiddleware);
    }

    if (options.globalGuards) {
      const guardFlags: SecurityModuleGlobalGuardsOptions =
        options.globalGuards === true
          ? {
              throttler: Boolean(options.throttler),
              jwt: Boolean(options.jwt),
              roles: true,
              policies: true,
            }
          : {
              throttler:
                options.globalGuards.throttler ?? Boolean(options.throttler),
              jwt: options.globalGuards.jwt ?? Boolean(options.jwt),
              roles: options.globalGuards.roles ?? true,
              policies: options.globalGuards.policies ?? true,
            };

      if (guardFlags.throttler) {
        providers.push({
          provide: APP_GUARD,
          useExisting: ThrottlerGuard,
        });
      }
      if (guardFlags.jwt) {
        if (!options.jwt) {
          providers.push(JwtAuthGuard);
          exportsList.push(JwtAuthGuard);
        }
        providers.push({
          provide: APP_GUARD,
          useExisting: JwtAuthGuard,
        });
      }
      if (guardFlags.roles) {
        providers.push({
          provide: APP_GUARD,
          useExisting: RolesGuard,
        });
      }
      if (guardFlags.policies) {
        providers.push({
          provide: APP_GUARD,
          useExisting: PoliciesGuard,
        });
      }
    }

    return {
      module: SecurityModule,
      global: isGlobal,
      imports,
      providers,
      exports: exportsList,
    };
  }
}
