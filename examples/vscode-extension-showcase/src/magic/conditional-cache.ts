import { Injectable, Profile, RegisterIfMissing } from "@bunest/core";

export abstract class ShowcaseCacheStore {
  abstract get(key: string): string | undefined;
  abstract set(key: string, value: string): void;
}

/**
 * Fallback cache bean registered automatically ONLY if no other provider
 * supplies `ShowcaseCacheStore` (`@RegisterIfMissing`).
 */
@Injectable()
@RegisterIfMissing(ShowcaseCacheStore)
export class InMemoryShowcaseCacheStore extends ShowcaseCacheStore {
  private readonly store = new Map<string, string>();

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }
}

/**
 * Conditional profile-scoped bean active whenever profile is NOT `production`.
 */
@Injectable()
@Profile("!production")
export class DevShowcaseBanner {
  getBanner(): string {
    return "Bunest Customizable Magic Showcase (non-production profile)";
  }
}
