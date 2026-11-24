import { Inject, Injectable, Logger } from "../../common/index";
import { I18N_RESOLVERS } from "../i18n.constants";
import { I18nService } from "../i18n.service";
import type { LocaleResolverInput } from "../interfaces/locale-resolver-input.interface";
import type { LocaleResolver } from "../resolvers/locale.resolver";

/** What the HTTP middleware resolves before guards (internal). */
export interface EarlyResolution {
  locale: string;
  /** The `afterGuards` resolvers that rank above `locale`'s, in order. */
  deferred: LocaleResolver[];
}

/**
 * Runs the configured resolvers in order; the first candidate that matches a
 * supported locale wins (internal, shared by the middleware and interceptor).
 */
@Injectable()
export class LocaleResolution {
  private readonly resolvers: LocaleResolver[];
  private readonly i18n: I18nService;
  private readonly logger = new Logger("I18nModule");
  /** The headers the resolvers read, deduplicated, for `Vary`. */
  readonly varyHeaders: string[];

  constructor(
    @Inject(I18N_RESOLVERS)
    resolvers: LocaleResolver[],
    i18n: I18nService,
  ) {
    this.resolvers = resolvers;
    this.i18n = i18n;
    const seen = new Set<string>();
    this.varyHeaders = resolvers
      .flatMap((resolver) => resolver.varyHeaders ?? [])
      .filter((name) => {
        const lower = name.toLowerCase();
        if (seen.has(lower)) {
          return false;
        }
        seen.add(lower);
        return true;
      });
  }

  /** Every resolver, for a call whose guards have run. */
  async resolve(input: LocaleResolverInput): Promise<string> {
    return (await this.first(this.resolvers, input)) ?? this.i18n.defaultLocale;
  }

  /**
   * The resolvers that don't need guards, for the HTTP middleware. The
   * `afterGuards` ones ranked above the match are left for the interceptor.
   */
  async resolveBeforeGuards(
    input: LocaleResolverInput,
  ): Promise<EarlyResolution> {
    const deferred: LocaleResolver[] = [];
    for (const resolver of this.resolvers) {
      if (resolver.afterGuards) {
        deferred.push(resolver);
        continue;
      }
      const locale = await this.candidate(resolver, input);
      if (locale) {
        return { locale, deferred };
      }
    }
    return { locale: this.i18n.defaultLocale, deferred };
  }

  /** The first supported locale `resolvers` return, in order, if any. */
  async first(
    resolvers: readonly LocaleResolver[],
    input: LocaleResolverInput,
  ): Promise<string | undefined> {
    for (const resolver of resolvers) {
      const locale = await this.candidate(resolver, input);
      if (locale) {
        return locale;
      }
    }
    return undefined;
  }

  private async candidate(
    resolver: LocaleResolver,
    input: LocaleResolverInput,
  ): Promise<string | undefined> {
    let result: string | string[] | undefined | null;
    try {
      result = await resolver.resolve(input);
    } catch (err) {
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `Locale resolver ${resolver.constructor.name} failed: ${String(err)}`,
        stack,
      );
      return undefined;
    }

    const candidates = Array.isArray(result) ? result : [result];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const match = this.i18n.matchLocale(candidate);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
}
