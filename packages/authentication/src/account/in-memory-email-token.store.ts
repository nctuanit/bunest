import { Injectable } from "@bunest/common";
import type {
  EmailTokenPurpose,
  EmailTokenRecord,
  EmailTokenStore,
} from "../interfaces/email-token-store.interface";

const MAX_PENDING = 10_000;

/**
 * Process-local email token store: drops expired tokens and caps at 10,000.
 */
@Injectable()
export class InMemoryEmailTokenStore implements EmailTokenStore {
  private readonly tokens = new Map<string, EmailTokenRecord>();

  async saveEmailToken(record: EmailTokenRecord): Promise<void> {
    const now = record.createdAt.getTime();
    for (const [id, token] of this.tokens) {
      if (token.expiresAt.getTime() > now) {
        break;
      }
      this.tokens.delete(id);
    }
    this.tokens.set(record.id, { ...record });
    if (this.tokens.size > MAX_PENDING) {
      let first: EmailTokenRecord | undefined;
      for (const token of this.tokens.values()) {
        if (!first || token.expiresAt.getTime() < first.expiresAt.getTime()) {
          first = token;
        }
      }
      if (first) {
        this.tokens.delete(first.id);
      }
    }
  }

  async consumeEmailToken(
    id: string,
    purpose: EmailTokenPurpose,
  ): Promise<EmailTokenRecord | undefined> {
    const record = this.tokens.get(id);
    if (record?.purpose !== purpose) {
      return undefined;
    }
    this.tokens.delete(id);
    return record;
  }

  async deleteUserEmailTokens(
    userId: string,
    purpose: EmailTokenPurpose,
  ): Promise<void> {
    for (const [id, token] of this.tokens) {
      if (token.userId === userId && token.purpose === purpose) {
        this.tokens.delete(id);
      }
    }
  }
}
