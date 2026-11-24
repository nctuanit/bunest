import { Injectable } from "@bunest/core";
import type {
  SessionRecord,
  SessionStore,
} from "../interfaces/session-store.interface";

/**
 * Process-local session store: the default when no source is registered, and a test double.
 */
@Injectable()
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private sweepAt = 1_024;

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const record = this.sessions.get(id);
    return record ? { ...record } : undefined;
  }

  async createSession(record: SessionRecord): Promise<void> {
    const { extra: _, ...stored } = record;
    this.sessions.set(record.id, stored);
    if (this.sessions.size >= this.sweepAt) {
      this.sweep(record.lastActiveAt.getTime());
    }
  }

  async touchSession(id: string, lastActiveAt: Date): Promise<void> {
    const record = this.sessions.get(id);
    if (record && record.lastActiveAt < lastActiveAt) {
      this.sessions.set(id, { ...record, lastActiveAt });
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async listUserSessions(userId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .map((s) => ({ ...s }));
  }

  async deleteUserSessions(userId: string): Promise<void> {
    for (const [id, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(id);
      }
    }
  }

  private sweep(now: number): void {
    for (const [id, s] of this.sessions) {
      if (s.expiresAt.getTime() <= now) {
        this.sessions.delete(id);
      }
    }
    this.sweepAt = Math.max(1_024, this.sessions.size * 2);
  }
}
