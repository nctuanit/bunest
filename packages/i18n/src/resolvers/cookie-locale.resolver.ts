import type { LocaleResolverInput } from "../interfaces/locale-resolver-input.interface";
import { first } from "../utils/request.util";
import { LocaleResolver } from "./locale.resolver";

/** `Cookie: lang=pl`. The cookie name defaults to `lang`. */
export class CookieLocaleResolver extends LocaleResolver {
  private readonly name: string;
  override readonly varyHeaders: readonly string[] = ["Cookie"];

  constructor(name = "lang") {
    super();
    this.name = name;
  }

  override resolve({ headers }: LocaleResolverInput): string | undefined {
    return readCookie(first(headers.cookie), this.name);
  }
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== name) {
      continue;
    }
    let value = pair.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}
