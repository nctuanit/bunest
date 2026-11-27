import {
  APP_INTERCEPTOR,
  Module,
  type DynamicModule,
  type OnModuleInit,
} from "@bunest/core";
import { ModuleRef } from "@bunest/core";
import { EmailVerificationService } from "./account/email-verification.service";
import { PasswordResetService } from "./account/password-reset.service";
import { AUTHENTICATION_MODULE_OPTIONS } from "./authentication.constants";
import {
  ConfigurableModuleClass,
  startupChecks,
  storageRequirements,
  type AuthenticationModuleAsyncOptions,
  type OPTIONS_TYPE,
} from "./authentication.module-definition";
import { AuthenticationContext } from "./context/authentication.context";
import { AuthenticationScope } from "./context/authentication-scope.service";
import { AuthenticationEvents } from "./events/authentication-events.service";
import { AuthenticationGuard } from "./guards/authentication.guard";
import { AuthenticationScopeInterceptor } from "./interceptors/authentication-scope.interceptor";
import type { AuthenticationModuleOptions } from "./interfaces/authentication-module-options.interface";
import { TokenService } from "./jwt/token.service";
import { MagicLinkService } from "./magic-link/magic-link.service";
import { MfaService } from "./mfa/mfa.service";
import { OidcService } from "./oidc/oidc.service";
import {
  AuthenticationRegistry,
  LOCK_REGISTRY,
} from "./services/authentication-registry.service";
import { PasswordHasher } from "./services/password-hasher.service";
import { WsAuthenticator } from "./services/ws-authenticator.service";
import { SessionService } from "./session/session.service";
import { SignInService } from "./session/sign-in.service";
import {
  AuthenticationStorage,
  LOCK_STORAGE,
} from "./storage/authentication.storage";
import { WebAuthnService } from "./webauthn/webauthn.service";

/**
 * `AuthenticationModule.forRoot({ session, mfa, ... })`, or
 * `forRootAsync({ inject, useFactory })` for values read from config. Global
 * by default.
 */
@Module({
  providers: [
    startupChecks,
    storageRequirements,
    AuthenticationRegistry,
    AuthenticationStorage,
    AuthenticationScope,
    AuthenticationContext,
    AuthenticationScopeInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: AuthenticationScopeInterceptor },
    AuthenticationGuard,
    AuthenticationEvents,
    WsAuthenticator,
    SessionService,
    SignInService,
    {
      provide: PasswordHasher,
      inject: [AUTHENTICATION_MODULE_OPTIONS],
      useFactory: (options: AuthenticationModuleOptions) =>
        new PasswordHasher(options.password),
    },
    MfaService,
    TokenService,
    EmailVerificationService,
    PasswordResetService,
    MagicLinkService,
    OidcService,
    WebAuthnService,
  ],
  exports: [
    AUTHENTICATION_MODULE_OPTIONS,
    AuthenticationRegistry,
    AuthenticationStorage,
    AuthenticationContext,
    AuthenticationGuard,
    AuthenticationEvents,
    WsAuthenticator,
    SessionService,
    SignInService,
    PasswordHasher,
    MfaService,
    TokenService,
    EmailVerificationService,
    PasswordResetService,
    MagicLinkService,
    OidcService,
    WebAuthnService,
  ],
})
export class AuthenticationModule
  extends ConfigurableModuleClass
  implements OnModuleInit
{
  constructor(
    private readonly registry: AuthenticationRegistry,
    private readonly storage: AuthenticationStorage,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  static override forRoot(options: typeof OPTIONS_TYPE = {}): DynamicModule {
    return super.forRoot(options);
  }

  static override forRootAsync(
    options: AuthenticationModuleAsyncOptions,
  ): DynamicModule {
    return super.forRootAsync(options);
  }

  onModuleInit(): void {
    this.registry[LOCK_REGISTRY]();
    this.storage[LOCK_STORAGE]();
    assertGraphqlContextPerRequest(this.moduleRef);
  }
}

function assertGraphqlContextPerRequest(moduleRef: ModuleRef): void {
  let options: { context?: unknown } | undefined;
  try {
    options = moduleRef.get<{ context?: unknown }>("GqlModuleOptions", {
      strict: false,
    });
  } catch {
    return;
  }
  if (typeof options?.context === "object" && options.context !== null) {
    throw new Error(
      "AuthenticationModule: the GraphQL module\u2019s `context` is an object, shared by every request: the first " +
        "request is kept as its `req`, and every later operation would be authenticated as that caller. Make it a " +
        "function that builds one per request: `context: ({ req, res }) => ({ req, res, ...yourValues })`.",
    );
  }
}
