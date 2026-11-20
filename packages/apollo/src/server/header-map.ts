/**
 * Case-insensitive header map mirroring `@apollo/server` `HeaderMap`.
 */
export class HeaderMap extends Map<string, string> {
  override set(key: string, value: string): this {
    return super.set(key.toLowerCase(), value);
  }

  override get(key: string): string | undefined {
    return super.get(key.toLowerCase());
  }

  override has(key: string): boolean {
    return super.has(key.toLowerCase());
  }

  override delete(key: string): boolean {
    return super.delete(key.toLowerCase());
  }
}
