import { Injectable } from "@bunest/core";
import {
  ApiKeyProvider,
  AuthenticationRegistry,
  JwtBearerProvider,
  type ApiKeyRecord,
  type JwtClaims,
} from "@bunest/security/auth";
import { IdentityStore, type AppUser } from "./users.store";

@Injectable()
export class AppJwtBearerProvider extends JwtBearerProvider<AppUser> {
  constructor(
    registry: AuthenticationRegistry,
    private readonly store: IdentityStore,
  ) {
    super();
    registry.registerProvider(this, { order: 0 });
  }

  validate(claims: JwtClaims): AppUser | null {
    if (typeof claims.sub !== "string") return null;
    return this.store.findUserById(claims.sub) ?? null;
  }
}

@Injectable()
export class AppApiKeyProvider extends ApiKeyProvider<AppUser> {
  constructor(
    registry: AuthenticationRegistry,
    private readonly store: IdentityStore,
  ) {
    super({ prefix: "bnst" });
    registry.registerProvider(this, { order: 10 });
  }

  protected findKey(id: string): ApiKeyRecord<AppUser> | null {
    const keyRecord = this.store.findApiKey(id);
    if (!keyRecord) return null;
    const user = this.store.findUserById(keyRecord.userId);
    if (!user) return null;
    return { hash: keyRecord.hash, user };
  }
}
