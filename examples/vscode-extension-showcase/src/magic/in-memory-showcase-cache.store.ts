import { Injectable } from "@bunest/core";
import { ShowcaseCacheStore } from "./showcase-cache-store";

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
