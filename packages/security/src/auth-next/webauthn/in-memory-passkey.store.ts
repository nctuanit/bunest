import { Injectable } from "@bunest/core";
import type {
  PasskeyChallengeRecord,
  PasskeyChallengeType,
  PasskeyCredential,
  PasskeyStore,
} from "./webauthn.interface";

const MAX_PENDING_CHALLENGES = 10_000;

function cloneCredential(cred: PasskeyCredential): PasskeyCredential {
  return {
    ...cred,
    ...(cred.transports ? { transports: [...cred.transports] } : {}),
    createdAt: new Date(cred.createdAt.getTime()),
    ...(cred.lastUsedAt
      ? { lastUsedAt: new Date(cred.lastUsedAt.getTime()) }
      : {}),
  };
}

function cloneChallenge(rec: PasskeyChallengeRecord): PasskeyChallengeRecord {
  return {
    ...rec,
    createdAt: new Date(rec.createdAt.getTime()),
    expiresAt: new Date(rec.expiresAt.getTime()),
  };
}

/**
 * Process-local passkey credential and WebAuthn challenge store.
 * Default when no persistent `PasskeyStore` is registered, and suitable for tests.
 */
@Injectable()
export class InMemoryPasskeyStore implements PasskeyStore {
  private readonly credentials = new Map<string, PasskeyCredential>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly challenges = new Map<string, PasskeyChallengeRecord>();

  async getPasskey(
    credentialId: string,
  ): Promise<PasskeyCredential | undefined> {
    const existing = this.credentials.get(credentialId);
    return existing ? cloneCredential(existing) : undefined;
  }

  async savePasskey(credential: PasskeyCredential): Promise<void> {
    const prev = this.credentials.get(credential.id);
    if (prev && prev.userId !== credential.userId) {
      const prevSet = this.byUser.get(prev.userId);
      prevSet?.delete(credential.id);
      if (prevSet && prevSet.size === 0) {
        this.byUser.delete(prev.userId);
      }
    }
    this.credentials.set(credential.id, cloneCredential(credential));
    let ids = this.byUser.get(credential.userId);
    if (!ids) {
      ids = new Set<string>();
      this.byUser.set(credential.userId, ids);
    }
    ids.add(credential.id);
  }

  async listUserPasskeys(userId: string): Promise<PasskeyCredential[]> {
    const ids = this.byUser.get(userId);
    if (!ids || ids.size === 0) {
      return [];
    }
    const list: PasskeyCredential[] = [];
    for (const id of ids) {
      const cred = this.credentials.get(id);
      if (cred) {
        list.push(cloneCredential(cred));
      }
    }
    return list;
  }

  async updatePasskeyCounter(
    credentialId: string,
    counter: number,
    lastUsedAt?: Date,
  ): Promise<boolean> {
    const existing = this.credentials.get(credentialId);
    if (!existing) {
      return false;
    }
    if (counter === 0) {
      if (existing.counter !== 0) {
        return false;
      }
    } else if (counter <= existing.counter) {
      return false;
    }
    existing.counter = counter;
    if (lastUsedAt !== undefined) {
      existing.lastUsedAt = new Date(lastUsedAt.getTime());
    }
    return true;
  }

  async deletePasskey(credentialId: string): Promise<boolean> {
    const existing = this.credentials.get(credentialId);
    if (!existing) {
      return false;
    }
    this.credentials.delete(credentialId);
    const ids = this.byUser.get(existing.userId);
    if (ids) {
      ids.delete(credentialId);
      if (ids.size === 0) {
        this.byUser.delete(existing.userId);
      }
    }
    return true;
  }

  async deleteUserPasskeys(userId: string): Promise<void> {
    const ids = this.byUser.get(userId);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      this.credentials.delete(id);
    }
    this.byUser.delete(userId);
  }

  async savePasskeyChallenge(record: PasskeyChallengeRecord): Promise<void> {
    const now = record.createdAt.getTime();
    for (const [key, item] of this.challenges) {
      if (item.expiresAt.getTime() <= now) {
        this.challenges.delete(key);
      }
    }
    this.challenges.set(record.challenge, cloneChallenge(record));
    while (this.challenges.size > MAX_PENDING_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.challenges.delete(oldest);
    }
  }

  async consumePasskeyChallenge(
    challenge: string,
    type: PasskeyChallengeType,
  ): Promise<PasskeyChallengeRecord | undefined> {
    const existing = this.challenges.get(challenge);
    if (!existing || existing.type !== type) {
      return undefined;
    }
    this.challenges.delete(challenge);
    return cloneChallenge(existing);
  }
}
