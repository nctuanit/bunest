import {
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { HttpAdapterHost } from "@bunest/core";
import { hasVerifiedEmail } from "../account/email.util";
import {
  AUTHENTICATION_GUARD_BRAND,
  AUTHENTICATION_METADATA,
} from "../authentication.constants";
import { AuthenticationError } from "../errors/authentication.error";
import type { RouteAuthentication } from "../interfaces/authenticate-options.interface";
import type { CredentialProvider } from "../interfaces/authentication-registry.interface";
import type { AuthenticationResult } from "../interfaces/authentication-result.interface";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import {
  getRawResult,
  setAuthState,
  setRawResult,
} from "../utils/auth-state.util";
import {
  refusal,
  refusalOf,
  type Refusal,
} from "../utils/transport-errors.util";

/** Which provider produced a result, for `@Authenticate({ providers })` on a cached result. */
const producedBy = new WeakMap<
  AuthenticationResult<any, any>,
  CredentialProvider
>();

const MFA_REQUIRED: Refusal = {
  message: "Second factor required",
  code: "mfa_required",
};
const EMAIL_UNVERIFIED: Refusal = {
  status: 403,
  message: "Email address not verified",
  code: "email_unverified",
};
/** No provider recognized any credentials. */
const MISSING_CREDENTIALS: Refusal = { code: "missing_credentials" };

/**
 * Runs the registered providers in order and records the first result on
 * the call.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  /**
   * How `@bunest/security/authz` recognizes this guard, subclasses included,
   * whatever their names: it fails at startup when this guard would run
   * after its own.
   */
  static readonly [AUTHENTICATION_GUARD_BRAND] = true;

  constructor(
    private readonly reflector: Reflector,
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: AuthenticationRegistry,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.route(context);
    if (route.public) {
      if (context.getType<string>() === "ws") {
        setAuthState(context, null, { perCallOnly: true });
      }
      return true;
    }

    const only = route.providers;
    const all = this.registry.providers;
    const providers = only
      ? all.filter((p) => only.some((type) => p instanceof type))
      : all;

    let raw = getRawResult(context);
    if (only && raw) {
      const producer = producedBy.get(raw);
      if (!producer || !providers.includes(producer)) {
        raw = undefined;
      }
    }
    if (raw === undefined) {
      raw = await this.authenticate(context, providers, !only);
      if (!only) {
        setRawResult(context, raw);
      }
    }

    const pending = raw?.mfa === "pending";
    const result = pending ? null : raw;
    if (!result) {
      if (route.optional) {
        setAuthState(context, null);
        return true;
      }
      if (!only) {
        this.forgetConnection(context);
      }
      if (pending) {
        return this.fail(context, MFA_REQUIRED);
      }
      return this.fail(
        context,
        MISSING_CREDENTIALS,
        this.challenges(context, providers),
      );
    }

    if (route.mfa && result.mfa !== "verified") {
      return this.fail(context, MFA_REQUIRED);
    }

    if (route.verifiedEmail) {
      const handler = this.registry.handler("emailVerification");
      const verified = handler?.isVerified
        ? await handler.isVerified(result.user)
        : hasVerifiedEmail(result.user);
      if (!verified) {
        return this.fail(context, EMAIL_UNVERIFIED);
      }
    }

    setAuthState(context, result);
    return true;
  }

  private route(context: ExecutionContext): RouteAuthentication {
    return {
      ...this.reflector.get<RouteAuthentication>(
        AUTHENTICATION_METADATA,
        context.getClass(),
      ),
      ...this.reflector.get<RouteAuthentication>(
        AUTHENTICATION_METADATA,
        context.getHandler(),
      ),
    };
  }

  private async authenticate(
    context: ExecutionContext,
    providers: readonly CredentialProvider[],
    everyProvider: boolean,
  ): Promise<AuthenticationResult<any, any> | null> {
    for (const provider of providers) {
      try {
        const result = await provider.authenticate(context);
        if (result?.user) {
          producedBy.set(result, provider);
          return result;
        }
      } catch (error) {
        if (error instanceof AuthenticationError) {
          if (everyProvider || error.status === 401) {
            this.forgetConnection(context);
          }
          return this.fail(context, refusalOf(error), error.challenge);
        }
        throw error;
      }
    }
    return null;
  }

  private forgetConnection(context: ExecutionContext): void {
    if (context.getType<string>() === "ws") {
      setAuthState(context, null);
    }
  }

  private challenges(
    context: ExecutionContext,
    providers: readonly CredentialProvider[],
  ): string | undefined {
    const list = new Set(
      providers
        .map((p) => p.challenge?.(context))
        .filter((c): c is string => !!c),
    );
    return [...list].join(", ") || undefined;
  }

  private async fail(
    context: ExecutionContext,
    reason: Refusal,
    challenge?: string,
  ): Promise<never> {
    throw await refusal(context, reason, {
      challenge,
      adapterHost: this.adapterHost,
    });
  }
}
