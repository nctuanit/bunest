import { Injectable } from "@bunest/core";

export abstract class ShowcaseCacheStore {
  abstract get(key: string): string | undefined;
  abstract set(key: string, value: string): void;
}

@Injectable()
export class InMemoryShowcaseCacheStore extends ShowcaseCacheStore {
  private readonly store = new Map<string, string>();

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }
}

@Injectable()
export class DevShowcaseBanner {
  getBanner(): string {
    return "Bunest Showcase";
  }
}
