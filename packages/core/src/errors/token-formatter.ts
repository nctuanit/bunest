import { isForwardReference } from "@bunest/common";

/**
 * Formats any DI injection token, class, symbol, or forwardRef into a readable label
 * for bootstrap error diagnostics.
 */
export function formatToken(token: unknown): string {
  if (token === undefined) {
    return "undefined";
  }
  if (token === null) {
    return "null";
  }
  if (typeof token === "string") {
    return `"${token}"`;
  }
  if (typeof token === "symbol") {
    return token.toString();
  }
  if (typeof token === "function") {
    return token.name || "<anonymous class>";
  }
  if (isForwardReference(token)) {
    try {
      const resolved = token.forwardRef();
      return `forwardRef(${formatToken(resolved)})`;
    } catch {
      return "forwardRef(<unresolved>)";
    }
  }
  return String(token);
}
