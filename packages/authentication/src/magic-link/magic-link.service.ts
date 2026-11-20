import { Inject, Injectable, Optional } from "@bunest/common";
import { HttpAdapterHost } from "@bunest/core";
import { isMailableEmail, normalizeEmail } from "../account/email.util";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationScope } from "../context/authentication-scope.service";
import { MagicLinkError } from "../errors/magic-link.error";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type {
  CreatedMagicLink,
  MagicLinkOptions,
  MagicLinkRequest,
} from "../interfaces/magic-link.interface";
import type { IssuedSession } from "../interfaces/session.interface";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import {
  defaultCookieName,
  readCookie,
  serializeCookie,
} from "../session/cookies.util";
import { SignInService } from "../session/sign-in.service";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { firstHeader } from "../utils/auth-state.util";
import {
  randomToken,
  safeEqual,
  safeRedirectPath,
  sha256,
  TOKEN_PATTERN,
} from "../utils/crypto.util";
import { durationOr, hasExpired } from "../utils/duration.util";
import { appendResponseHeader, type HeadersInput } from "../utils/headers.util";
import { requireUrlOption } from "../utils/options.util";
import type { MagicLinkHandler } from "./magic-link.handler";

function linkId(token: string, binding: string | undefined): string {
  return sha256(binding === undefined ? token : `${token}.${binding}`);
}

function hintOf(token: string): string {
  return sha256(`nestjs-authentication magic-link hint ${token}`).slice(0, 12);
}

const PENDING_LINKS = 5;
const HINT_PATTERN = /^[\w-]{12}$/;

interface PendingLink {
  hint: string;
  secret: string;
}

function readPending(value: string | undefined): PendingLink[] {
  return (value ?? "")
    .split("~")
    .map((pair) => pair.split("."))
    .filter(
      ([hint, secret, ...rest]) =>
        hint !== undefined &&
        HINT_PATTERN.test(hint) &&
        TOKEN_PATTERN.test(secret ?? "") &&
        rest.length === 0,
    )
    .slice(0, PENDING_LINKS)
    .map(([hint, secret]) => ({ hint: hint!, secret: secret! }));
}

function writePending(links: PendingLink[]): string {
  return links.map(({ hint, secret }) => `${hint}.${secret}`).join("~");
}

/**
 * Passwordless sign-in links: 256-bit single-use tokens, stored hashed,
 * short-lived, and bound to the browser that requested them.
 */
@Injectable()
export class MagicLinkService {
  private readonly options?: MagicLinkOptions;
  private readonly ttl: number;
  private readonly bindToBrowser: boolean;
  private readonly txCookieName: string;

  constructor(
    private readonly storage: AuthenticationStorage,
    private readonly registry: AuthenticationRegistry,
    private readonly signIn: SignInService,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly scope: AuthenticationScope = new AuthenticationScope(),
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
  ) {
    this.options = options?.magicLink;
    if (this.options) {
      requireUrlOption(
        this.options.url,
        "magicLink.url",
        "the page that receives the link",
      );
    }
    this.ttl = durationOr(this.options?.ttl, "15m");
    this.bindToBrowser = this.options?.bindToBrowser !== false;
    this.txCookieName = defaultCookieName("magic_link_tx", this.options?.cookie);
  }

  /**
   * Creates a link and hands it to `MagicLinkHandler.send()`. The token is
   * not returned.
   */
  async create(
    email: string,
    { redirectTo }: { redirectTo?: unknown } = {},
  ): Promise<CreatedMagicLink> {
    const { options, handler } = this.feature();
    this.signIn.refuseCrossOrigin(this.scope.exchange()?.request);
    const now = this.now();
    const expiresAt = new Date(now + this.ttl);
    const normalized = typeof email === "string" ? normalizeEmail(email) : "";
    if (!isMailableEmail(normalized)) {
      return { expiresAt };
    }
    const token = randomToken();
    const binding = this.bindToBrowser ? randomToken() : undefined;
    const safe = safeRedirectPath(redirectTo);
    await this.storage.magicLinks.saveMagicLink({
      id: linkId(token, binding),
      email: normalized,
      createdAt: new Date(now),
      expiresAt,
      ...(safe ? { redirectTo: safe } : {}),
    });
    let cookie: string | undefined;
    if (binding) {
      const hint = hintOf(token);
      const before = readPending(
        this.pendingCookie(this.scope.exchange()?.request),
      ).filter((link) => link.hint !== hint);
      cookie = this.txCookie(
        writePending([{ hint, secret: binding }, ...before].slice(0, PENDING_LINKS)),
        this.ttl / 1000,
      );
      this.setCookie(cookie);
    }
    const url = new URL(options.url);
    url.searchParams.set("token", token);
    await handler.send({ email: normalized, url: url.toString(), expiresAt });
    return { expiresAt, ...(cookie ? { cookie } : {}) };
  }

  /**
   * Burns the token, asks `MagicLinkHandler.resolveUser()` for the user, and
   * signs them in on this browser through `SignInService`.
   */
  async consume(
    token: string,
    { request }: { request?: MagicLinkRequest } = {},
  ): Promise<(IssuedSession & { redirectTo?: string }) | null> {
    const { handler } = this.feature();
    this.signIn.refuseCrossOrigin(this.scope.exchange()?.request);
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
      return this.refuse("unknown");
    }
    let binding: string | undefined;
    let pending: PendingLink[] = [];
    let link: PendingLink | undefined;
    if (this.bindToBrowser) {
      pending = readPending(
        this.pendingCookie(request ?? this.scope.exchange()?.request),
      );
      const hint = hintOf(token);
      link = pending.find((candidate) => safeEqual(candidate.hint, hint));
      if (!link) {
        this.events.emit({
          type: "magic-link-refused",
          reason: "not-this-browser",
        });
        throw new MagicLinkError();
      }
      binding = link.secret;
    }
    const record = await this.storage.magicLinks.consumeMagicLink(
      linkId(token, binding),
    );
    const rest = writePending(pending.filter((candidate) => candidate !== link));
    this.setCookie(this.txCookie(rest, rest ? this.ttl / 1000 : 0));
    if (!record) {
      return this.refuse("unknown");
    }
    if (hasExpired(record.expiresAt, this.now())) {
      return this.refuse("expired", record.email);
    }
    const user = await handler.resolveUser(record.email);
    if (!user) {
      return this.refuse("refused", record.email);
    }
    if (typeof user.email !== "string") {
      throw new TypeError(
        "MagicLinkHandler.resolveUser() must return the account\u2019s stored `email` with its `id`: the link signs in " +
          "only the account whose address it was sent to.",
      );
    }
    if (normalizeEmail(user.email) !== record.email) {
      return this.refuse("refused", record.email);
    }
    const issued = await this.signIn.signIn(user.id, { method: "magic-link" });
    return { ...issued, redirectTo: record.redirectTo };
  }

  private feature(): { options: MagicLinkOptions; handler: MagicLinkHandler } {
    const handler = this.registry.handler("magicLink");
    if (!this.options || !handler) {
      throw new Error(
        "MagicLinkService: magic links are not enabled. Configure `magicLink` in the AuthenticationModule options, and " +
          "register a MagicLinkHandler: `registry.registerHandler('magicLink', this)`.",
      );
    }
    return { options: this.options, handler };
  }

  private refuse(
    reason: "unknown" | "expired" | "refused",
    email?: string,
  ): null {
    this.events.emit({
      type: "magic-link-refused",
      reason,
      ...(email ? { email } : {}),
    });
    return null;
  }

  private pendingCookie(
    request: { headers: HeadersInput } | undefined,
  ): string | undefined {
    return readCookie(firstHeader(request?.headers, "cookie"), this.txCookieName);
  }

  private txCookie(value: string, maxAge: number): string {
    return serializeCookie(this.txCookieName, value, {
      ...this.options?.cookie,
      sameSite: "lax",
      maxAge,
    });
  }

  private setCookie(cookie: string): void {
    if (!this.bindToBrowser) {
      return;
    }
    const response = this.scope.exchange()?.response;
    if (response) {
      appendResponseHeader(this.adapterHost, response, "Set-Cookie", cookie);
    }
  }

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }
}
