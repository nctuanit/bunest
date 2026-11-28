import { Injectable } from "@bunest/core";
import {
  ApiKeyProvider,
  AuthenticationRegistry,
  type ApiKeyRecord,
} from "@bunest/security/auth";
import type { BetterAuthDemoUser } from "./auth.instance";

@Injectable()
export class ServiceApiKeyProvider extends ApiKeyProvider<BetterAuthDemoUser> {
  private readonly records = new Map<string, ApiKeyRecord<BetterAuthDemoUser>>();

  constructor(registry: AuthenticationRegistry) {
    super({ prefix: "bnst" });
    registry.registerProvider(this, { order: 10 });
  }

  issueForUser(user: BetterAuthDemoUser) {
    const generated = this.generate();
    this.records.set(generated.id, { hash: generated.hash, user });
    return { id: generated.id, key: generated.key };
  }

  protected findKey(id: string): ApiKeyRecord<BetterAuthDemoUser> | null {
    return this.records.get(id) ?? null;
  }
}
