import type { LocaleResolverInput } from "../interfaces/locale-resolver-input.interface";
import { first } from "../utils/request.util";
import { LocaleResolver } from "./locale.resolver";

/** `x-lang: pl`. The header name defaults to `x-lang`. */
export class HeaderLocaleResolver extends LocaleResolver {
  override readonly varyHeaders: readonly string[];
  private readonly header: string;

  constructor(header = "x-lang") {
    super();
    this.header = header.toLowerCase();
    this.varyHeaders = [header];
  }

  override resolve({ headers }: LocaleResolverInput): string | undefined {
    return first(headers[this.header]);
  }
}
