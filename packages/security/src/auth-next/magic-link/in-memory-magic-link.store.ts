import { Injectable } from "@bunest/core";
import type {
  MagicLinkRecord,
  MagicLinkStore,
} from "../interfaces/magic-link-store.interface";

const MAX_PENDING = 10_000;

/**
 * Process-local magic link store: drops expired links and caps at 10,000.
 */
@Injectable()
export class InMemoryMagicLinkStore implements MagicLinkStore {
  private readonly links = new Map<string, MagicLinkRecord>();

  async saveMagicLink(record: MagicLinkRecord): Promise<void> {
    const now = record.createdAt.getTime();
    for (const [id, link] of this.links) {
      if (link.expiresAt.getTime() > now) {
        break;
      }
      this.links.delete(id);
    }
    this.links.set(record.id, { ...record });
    for (const id of this.links.keys()) {
      if (this.links.size <= MAX_PENDING) {
        break;
      }
      this.links.delete(id);
    }
  }

  async consumeMagicLink(id: string): Promise<MagicLinkRecord | undefined> {
    const record = this.links.get(id);
    this.links.delete(id);
    return record;
  }
}
