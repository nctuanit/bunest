import { Inject, Injectable, Logger, Optional } from "@bunest/common";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationEvents } from "../events/authentication-events.service";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type { EmailVerificationOptions } from "../interfaces/email-verification.interface";
import { AuthenticationRegistry } from "../services/authentication-registry.service";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { randomToken, sha256, TOKEN_PATTERN } from "../utils/crypto.util";
import { durationOr, hasExpired } from "../utils/duration.util";
import { requireUrlOption } from "../utils/options.util";
import type { EmailVerificationHandler } from "./email-verification.handler";

/**
 * Email verification links: 256-bit single-use tokens, stored hashed, bound
 * to the user and to the address they were sent to.
 */
@Injectable()
export class EmailVerificationService {
  private static readonly logger = new Logger("EmailVerificationService");
  private readonly options?: EmailVerificationOptions;
  private readonly ttl: number;

  constructor(
    private readonly storage: AuthenticationStorage,
    private readonly registry: AuthenticationRegistry,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
    private readonly events: AuthenticationEvents = new AuthenticationEvents(),
  ) {
    this.options = options?.emailVerification;
    if (this.options) {
      requireUrlOption(
        this.options.url,
        "emailVerification.url",
        "the page that receives the link",
      );
    }
    this.ttl = durationOr(this.options?.ttl, "24h");
  }

  /**
   * Sends a verification link for the user's current address, through
   * `EmailVerificationHandler.send()`.
   */
  async send(user: {
    id: string;
    email: string;
  }): Promise<{ expiresAt: Date }> {
    const { options, handler } = this.feature();
    if (typeof user?.email !== "string" || user.email.trim() === "") {
      throw new TypeError(
        "EmailVerificationService.send(): the user needs an `email` to send the link to.",
      );
    }
    const email = user.email;
    const token = randomToken();
    const now = this.now();
    const expiresAt = new Date(now + this.ttl);
    await this.storage.emailTokens.saveEmailToken({
      id: sha256(token),
      purpose: "email-verification",
      userId: user.id,
      email,
      createdAt: new Date(now),
      expiresAt,
    });
    const url = new URL(options.url);
    url.searchParams.set("token", token);
    await handler.send({
      userId: user.id,
      email,
      url: url.toString(),
      expiresAt,
    });
    return { expiresAt };
  }

  /**
   * Burns the token and asks `EmailVerificationHandler.markVerified()` to
   * record the address, if it is still the user's.
   */
  async verify(
    token: string,
  ): Promise<{ userId: string; email: string } | null> {
    const { handler } = this.feature();
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
      return null;
    }
    const record = await this.storage.emailTokens.consumeEmailToken(
      sha256(token),
      "email-verification",
    );
    if (!record || hasExpired(record.expiresAt, this.now())) {
      return null;
    }
    let verified: boolean;
    try {
      verified = await handler.markVerified(record.userId, record.email);
    } catch (error) {
      await this.storage.emailTokens
        .saveEmailToken(record)
        .catch((saveError) =>
          EmailVerificationService.logger.error(
            "Could not give back an email verification link",
            saveError instanceof Error ? saveError.stack : String(saveError),
          ),
        );
      throw error;
    }
    if (!verified) {
      return null;
    }
    await this.storage.emailTokens.deleteUserEmailTokens(
      record.userId,
      "email-verification",
    );
    this.events.emit({
      type: "email-verified",
      userId: record.userId,
      email: record.email,
    });
    return { userId: record.userId, email: record.email };
  }

  private feature(): {
    options: EmailVerificationOptions;
    handler: EmailVerificationHandler;
  } {
    const handler = this.registry.handler("emailVerification");
    if (!this.options || !handler) {
      throw new Error(
        "EmailVerificationService: email verification is not enabled. Configure `emailVerification` in the " +
          "AuthenticationModule options, and register an EmailVerificationHandler: `registry.registerHandler('emailVerification', this)`.",
      );
    }
    return { options: this.options, handler };
  }

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }
}
