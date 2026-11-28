import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
} from "@bunest/core";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationScope } from "../context/authentication-scope.service";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type { EmailTokenRecord } from "../interfaces/email-token-store.interface";
import type {
  PasswordResetAccount,
  PasswordResetOptions,
  PasswordResetResult,
  ResetPasswordOptions,
} from "../interfaces/password-reset.interface";
import { TokenService } from "../jwt/token.service";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import {
  isHashablePassword,
  PasswordHasher,
} from "../services/password-hasher.service";
import { SessionService } from "../session/session.service";
import { SignInService } from "../session/sign-in.service";
import { AuthenticationStorage } from "../storage/authentication.storage";
import {
  randomToken,
  safeEqual,
  sha256,
  TOKEN_PATTERN,
} from "../utils/crypto.util";
import { durationOr, hasExpired } from "../utils/duration.util";
import { requireUrlOption } from "../utils/options.util";
import { isMailableEmail, normalizeEmail } from "./email.util";
import type { PasswordResetHandler } from "./password-reset.handler";

/**
 * "Forgot your password?": reset links that are 256-bit single-use tokens,
 * stored hashed, short-lived, and bound to the address they were sent to and
 * to the password they replace.
 */
@Injectable()
export class PasswordResetService implements OnModuleDestroy {
  private static readonly logger = new Logger("PasswordResetService");
  private readonly options?: PasswordResetOptions;
  private readonly ttl: number;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly storage: AuthenticationStorage,
    private readonly registry: AuthenticationRegistry,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly signInService: SignInService,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
    private readonly scope: AuthenticationScope = new AuthenticationScope(),
  ) {
    this.options = options?.passwordReset;
    if (this.options) {
      requireUrlOption(
        this.options.url,
        "passwordReset.url",
        "the page that receives the link",
      );
    }
    this.ttl = durationOr(this.options?.ttl, "1h");
  }

  /**
   * Starts a reset for `email`, if it belongs to an account. Returns at once,
   * before the account is looked up, so neither answer nor timing reveals which
   * addresses are registered.
   */
  request(email: string): void {
    this.feature();
    const requested = typeof email === "string" ? normalizeEmail(email) : "";
    if (!isMailableEmail(requested)) {
      return;
    }
    const work = Bun.sleep(0)
      .then(() => this.issue(requested))
      .catch((error) =>
        PasswordResetService.logger.error(
          "A password reset request failed",
          error instanceof Error ? error.stack : String(error),
        ),
      );
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /**
   * Sets a new password with a reset token.
   */
  async reset(
    token: string,
    password: string,
    { signIn = false }: ResetPasswordOptions = {},
  ): Promise<PasswordResetResult | null> {
    const { handler } = this.feature();
    if (signIn) {
      this.signInService.refuseCrossOrigin(this.scope.exchange()?.request);
    }
    if (
      typeof token !== "string" ||
      !TOKEN_PATTERN.test(token) ||
      !isHashablePassword(password)
    ) {
      return null;
    }
    const record = await this.storage.emailTokens.consumeEmailToken(
      sha256(token),
      "password-reset",
    );
    if (!record || hasExpired(record.expiresAt, this.now())) {
      return null;
    }
    let account: PasswordResetAccount | null;
    try {
      account = await this.setPassword(handler, record, password);
    } catch (error) {
      await this.storage.emailTokens
        .saveEmailToken(record)
        .catch((saveError) =>
          PasswordResetService.logger.error(
            "Could not give back a password reset link",
            saveError instanceof Error ? saveError.stack : String(saveError),
          ),
        );
      throw error;
    }
    if (!account) {
      return null;
    }
    await this.storage.emailTokens.deleteUserEmailTokens(
      account.id,
      "password-reset",
    );
    await this.revokeSignIns(account.id);
    await this.registry
      .handler("emailVerification")
      ?.markVerified(account.id, account.email);
    this.events.emit({ type: "password-reset", userId: account.id });
    const signedIn = signIn
      ? await this.signInService.signIn(account.id, {
          method: "password-reset",
        })
      : undefined;
    return { userId: account.id, ...(signedIn ? { signedIn } : {}) };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.inFlight);
  }

  private async issue(requested: string): Promise<void> {
    const { options, handler } = this.feature();
    const found = await handler.findUser(requested);
    if (!found) {
      this.events.emit({ type: "password-reset-requested", email: requested });
      return;
    }
    const account = checked(found);
    const token = randomToken();
    const now = this.now();
    const expiresAt = new Date(now + this.ttl);
    await this.storage.emailTokens.saveEmailToken({
      id: sha256(token),
      purpose: "password-reset",
      userId: account.id,
      email: account.email,
      fingerprint: fingerprint(account.passwordHash),
      createdAt: new Date(now),
      expiresAt,
    });
    this.events.emit({
      type: "password-reset-requested",
      email: requested,
      userId: account.id,
    });
    const url = new URL(options.url);
    url.searchParams.set("token", token);
    await handler.send({
      userId: account.id,
      email: account.email,
      url: url.toString(),
      expiresAt,
    });
  }

  private async setPassword(
    handler: PasswordResetHandler,
    record: EmailTokenRecord,
    password: string,
  ): Promise<PasswordResetAccount | null> {
    const found = await handler.findUser(normalizeEmail(record.email));
    const account = found ? checked(found) : null;
    if (
      !account ||
      account.id !== record.userId ||
      account.email !== record.email ||
      !safeEqual(fingerprint(account.passwordHash), record.fingerprint ?? "")
    ) {
      return null;
    }
    const passwordHash = await this.hash(handler, password);
    await this.revokeSignIns(account.id);
    await handler.updatePassword(account.id, passwordHash);
    return account;
  }

  private async hash(
    handler: PasswordResetHandler,
    password: string,
  ): Promise<string> {
    if (!handler.hashPassword) {
      return this.hasher.hash(password);
    }
    const passwordHash = await handler.hashPassword(password);
    if (typeof passwordHash !== "string" || passwordHash === "") {
      throw new TypeError(
        "PasswordResetHandler.hashPassword() must return the new password's hash, a non-empty string.",
      );
    }
    return passwordHash;
  }

  private async revokeSignIns(userId: string): Promise<void> {
    await this.sessions.revokeAll(userId);
    await this.tokens.revokeAll(userId);
  }

  private feature(): {
    options: PasswordResetOptions;
    handler: PasswordResetHandler;
  } {
    const handler = this.registry.handler("passwordReset");
    if (!this.options || !handler) {
      throw new Error(
        "PasswordResetService: password reset is not enabled. Configure `passwordReset` in the AuthenticationModule " +
          "options, and register a PasswordResetHandler: `registry.registerHandler('passwordReset', this)`.",
      );
    }
    return { options: this.options, handler };
  }

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }
}

function checked(account: PasswordResetAccount): PasswordResetAccount {
  if (typeof account.email !== "string" || account.email.trim() === "") {
    throw new TypeError(
      "PasswordResetHandler.findUser() must return the account\u2019s stored `email`: the link goes there, never to the " +
        "address typed in the form.",
    );
  }
  if (account.passwordHash === undefined) {
    throw new TypeError(
      "PasswordResetHandler.findUser() must return `passwordHash` (`null` for an account without a password): a link " +
        "works only while it is unchanged. Does the query leave the column out (TypeORM `select: false`)?",
    );
  }
  return account;
}

function fingerprint(passwordHash: string | null): string {
  return sha256(
    `nestjs-authentication password-reset v1 ${passwordHash ?? ""}`,
  );
}
