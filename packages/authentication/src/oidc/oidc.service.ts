import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@bunest/common";
import { HttpAdapterHost } from "@bunest/core";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationScope } from "../context/authentication-scope.service";
import { OidcError } from "../errors/oidc.error";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type {
  OidcOptions,
  OidcRedirect,
  OidcRequest,
  OidcStartOptions,
} from "../interfaces/oidc.interface";
import type { OidcProviderConfig } from "../interfaces/oidc-provider.interface";
import type { SessionRecord } from "../interfaces/session-store.interface";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import {
  defaultCookieName,
  readCookie,
  serializeCookie,
} from "../session/cookies.util";
import { SessionService } from "../session/session.service";
import { SignInService } from "../session/sign-in.service";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { safeEqual, safeRedirectPath, sha256 } from "../utils/crypto.util";
import { durationOr, hasExpired } from "../utils/duration.util";
import {
  appendResponseHeader,
  readFirstHeader,
  setResponseHeader,
} from "../utils/headers.util";
import { requireOption } from "../utils/options.util";
import { OidcClient, OidcMetadataCache } from "./oidc.client";
import type { OidcAccountResolver } from "./oidc-account.resolver";

/**
 * OpenID Connect sign-in, behind two routes of your own: a login route that
 * redirects to the provider, and the callback route it sends the browser back to.
 */
@Injectable()
export class OidcService {
  private readonly options?: OidcOptions;
  private readonly metadata: OidcMetadataCache;
  private readonly transactionTtl: number;
  private readonly txCookieName: string;

  constructor(
    private readonly storage: AuthenticationStorage,
    private readonly registry: AuthenticationRegistry,
    private readonly signIn: SignInService,
    private readonly sessions: SessionService,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly scope: AuthenticationScope = new AuthenticationScope(),
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {
    this.options = options?.oidc;
    if (this.options) {
      if (typeof this.options.callbackUrl !== "function") {
        assertCallbackUrl(this.options.callbackUrl);
      }
      if (typeof this.options.providers !== "function") {
        assertProviderCredentials(this.options.providers);
      }
    }
    this.metadata = new OidcMetadataCache(this.options);
    this.transactionTtl = durationOr(this.options?.transactionTtl, "10m");
    this.txCookieName = defaultCookieName("oidc_tx", this.options?.cookie);
  }

  /**
   * Starts a login: stores the transaction, sets its cookie, and returns
   * the provider's authorization URL.
   */
  async start(
    provider: string,
    { redirectTo, link = false, request }: OidcStartOptions = {},
  ): Promise<OidcRedirect> {
    const exchange = this.scope.exchange();
    const req: OidcRequest = request ?? exchange?.request ?? { headers: {} };
    let linking: { userId: string; sessionId: string } | undefined;
    if (link) {
      if (readFirstHeader(req.headers, "sec-fetch-site") === "cross-site") {
        throw new ForbiddenException("Cross-site link refused");
      }
      const session = await this.currentSession(req);
      if (!session) {
        throw new UnauthorizedException("sign in to link an account");
      }
      linking = { userId: session.userId, sessionId: session.id };
    }
    const client = await this.client(provider);
    const { url, transaction, binding } = await client
      .authorizationRequest(
        await this.callbackUrl(provider, req),
        safeRedirectPath(redirectTo),
        this.transactionTtl,
      )
      .catch(toHttp);
    await this.storage.oidcStates.saveOidcState({
      ...transaction,
      ...(linking ? { link: linking } : {}),
    });
    return this.redirect(exchange?.response, url, [
      this.txCookie(binding, this.transactionTtl / 1000),
    ]);
  }

  /**
   * Completes a login on the callback route, and returns where to send the
   * browser: the login's `redirectTo`, else `redirectAfterLogin`.
   */
  async finish(
    provider: string,
    query: Record<string, unknown>,
    { request }: { request?: OidcRequest } = {},
  ): Promise<OidcRedirect> {
    const { options, resolver } = this.feature();
    const exchange = this.scope.exchange();
    const req: OidcRequest = request ?? exchange?.request ?? { headers: {} };
    const state = query.state;
    const bound = readCookie(
      readFirstHeader(req.headers, "cookie"),
      this.txCookieName,
    );
    if (
      typeof state !== "string" ||
      !bound ||
      !safeEqual(sha256(bound), state)
    ) {
      throw new BadRequestException("state mismatch");
    }
    const transaction = await this.storage.oidcStates.consumeOidcState(state);
    if (
      !transaction ||
      transaction.provider !== provider ||
      hasExpired(transaction.expiresAt, this.now())
    ) {
      throw new BadRequestException("unknown or expired login");
    }
    const callbackUrl = await this.callbackUrl(provider, req);
    const client = await this.client(provider);
    const result = await client
      .callback(query, transaction, callbackUrl)
      .catch(toHttp);
    const location = transaction.redirectTo ?? options.redirectAfterLogin ?? "/";
    if (transaction.link) {
      const session = await this.currentSession(req);
      if (session?.id !== transaction.link.sessionId) {
        throw new UnauthorizedException("sign in to link an account");
      }
      const user = await resolver.resolveUser(result.profile, result.tokens, {
        linkTo: { id: session.userId },
      });
      if (!user || user.id !== session.userId) {
        throw new ForbiddenException("account not linked");
      }
      return this.redirect(exchange?.response, location, [
        this.txCookie("", 0),
      ]);
    }
    const user = await resolver.resolveUser(result.profile, result.tokens, {});
    if (!user) {
      throw new ForbiddenException("account not allowed");
    }
    const issued = await this.signIn.signIn(user.id, {
      method: `oidc:${provider}`,
    });
    const { url } = this.redirect(exchange?.response, location, [
      this.txCookie("", 0),
    ]);
    return { url, cookies: [issued.cookie, this.txCookie("", 0)] };
  }

  private redirect(
    response: unknown,
    url: string,
    cookies: string[],
  ): OidcRedirect {
    if (response) {
      for (const cookie of cookies) {
        appendResponseHeader(this.adapterHost, response, "Set-Cookie", cookie);
      }
      setResponseHeader(
        this.adapterHost,
        response,
        "Cache-Control",
        "no-store",
      );
    }
    return { url, cookies };
  }

  private feature(): { options: OidcOptions; resolver: OidcAccountResolver } {
    const resolver = this.registry.handler("oidc");
    if (!this.options || !resolver) {
      throw new Error(
        "OidcService: OpenID Connect is not enabled. Configure `oidc` in the AuthenticationModule options, and register " +
          "an OidcAccountResolver: `registry.registerHandler('oidc', this)`.",
      );
    }
    return { options: this.options, resolver };
  }

  private async currentSession(
    request: OidcRequest,
  ): Promise<SessionRecord | null> {
    const session = await this.sessions.validate(
      this.sessions.tokenFrom(request),
    );
    return session && session.mfa !== "pending" ? session : null;
  }

  private async client(name: string): Promise<OidcClient> {
    const { providers } = this.feature().options;
    let config: OidcProviderConfig | null | undefined;
    if (typeof providers === "function") {
      config = await providers(name);
      if (config) {
        assertResolvedCredentials(name, config);
      }
    } else {
      config = Object.hasOwn(providers, name) ? providers[name] : undefined;
    }
    if (!config) {
      throw new NotFoundException();
    }
    return new OidcClient(name, config, this.options, this.metadata);
  }

  private async callbackUrl(
    provider: string,
    request: OidcRequest,
  ): Promise<string> {
    const { callbackUrl } = this.feature().options;
    const url =
      typeof callbackUrl === "function"
        ? await callbackUrl(request)
        : callbackUrl;
    if (typeof callbackUrl === "function") {
      assertCallbackUrl(url, "the `oidc.callbackUrl` function must return");
    }
    return url.replaceAll(":provider", encodeURIComponent(provider));
  }

  private txCookie(value: string, maxAge: number): string {
    return serializeCookie(this.txCookieName, value, {
      ...this.options?.cookie,
      sameSite: "lax",
      maxAge,
    });
  }

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }
}

function assertCallbackUrl(
  value: unknown,
  must = "`oidc.callbackUrl` must be",
): void {
  let url: URL | undefined;
  try {
    url =
      typeof value === "string"
        ? new URL(value.replaceAll(":provider", "provider"))
        : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(
      `OidcService: ${must} the absolute URL of your callback route, with \`:provider\` where the ` +
        `provider's name goes, e.g. 'https://app.example.com/auth/oidc/:provider/callback'. Got ${JSON.stringify(value)}.`,
    );
  }
}

const CREDENTIALS = {
  clientId: "the client id the provider issued",
  clientSecret:
    "the client secret the provider issued; a public client sets `tokenEndpointAuthMethod: 'none'` instead",
} as const;

function assertProviderCredentials(
  providers: Record<string, OidcProviderConfig>,
): void {
  requireOption(
    providers,
    "oidc.providers",
    "the providers users can sign in with, by name, or a function of the name",
  );
  for (const [name, config] of Object.entries(providers)) {
    requireOption(
      config?.clientId,
      `oidc.providers.${name}.clientId`,
      CREDENTIALS.clientId,
    );
    if (config.tokenEndpointAuthMethod !== "none") {
      requireOption(
        config.clientSecret,
        `oidc.providers.${name}.clientSecret`,
        CREDENTIALS.clientSecret,
      );
    }
  }
}

function assertResolvedCredentials(
  name: string,
  config: OidcProviderConfig,
): void {
  for (const key of ["clientId", "clientSecret"] as const) {
    if (
      !config[key] &&
      (key === "clientId" || config.tokenEndpointAuthMethod !== "none")
    ) {
      throw new Error(
        `OidcService: the \`oidc.providers\` function returned the provider '${name}' without its \`${key}\` ` +
          `(${CREDENTIALS[key]}).`,
      );
    }
  }
}

function toHttp(error: unknown): never {
  if (!(error instanceof OidcError)) {
    throw error;
  }
  const Exception = {
    request: BadRequestException,
    verification: UnauthorizedException,
    unavailable: BadGatewayException,
  }[error.kind];
  throw new Exception(error.message);
}
