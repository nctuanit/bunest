import { Injectable } from "@bunest/common";
import type { OidcTransaction } from "../interfaces/oidc.interface";
import type { OidcStateStore } from "../interfaces/oidc-state-store.interface";

const MAX_PENDING = 10_000;

/**
 * Process-local OIDC state store: drops expired logins and caps at 10,000.
 */
@Injectable()
export class InMemoryOidcStateStore implements OidcStateStore {
  private readonly pending = new Map<string, OidcTransaction>();

  async saveOidcState(transaction: OidcTransaction): Promise<void> {
    const now = transaction.createdAt.getTime();
    for (const [state, tx] of this.pending) {
      if (tx.expiresAt.getTime() > now) {
        break;
      }
      this.pending.delete(state);
    }
    this.pending.set(transaction.state, { ...transaction });
    for (const state of this.pending.keys()) {
      if (this.pending.size <= MAX_PENDING) {
        break;
      }
      this.pending.delete(state);
    }
  }

  async consumeOidcState(state: string): Promise<OidcTransaction | undefined> {
    const tx = this.pending.get(state);
    this.pending.delete(state);
    return tx;
  }
}
