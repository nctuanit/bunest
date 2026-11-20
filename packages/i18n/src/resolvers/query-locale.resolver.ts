import type { LocaleResolverInput } from "../interfaces/locale-resolver-input.interface";
import { first } from "../utils/request.util";
import { LocaleResolver } from "./locale.resolver";

/** `?lang=pl`. The query parameter name defaults to `lang`. */
export class QueryLocaleResolver extends LocaleResolver {
  private readonly param: string;

  constructor(param = "lang") {
    super();
    this.param = param;
  }

  override resolve({ query }: LocaleResolverInput): string | undefined {
    return first(query[this.param]);
  }
}
