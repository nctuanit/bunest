export abstract class ShowcaseCacheStore {
  abstract get(key: string): string | undefined;
  abstract set(key: string, value: string): void;
}
