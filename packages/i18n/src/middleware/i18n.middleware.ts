import {
  Inject,
  Injectable,
  type BunestMiddleware,
  type NextFunction,
  type ResponseContext,
} from "@bunest/common";
import { getCurrentRequestContext } from "@bunest/http";
import {
  bindRequestI18nStore,
  i18nStorage,
  type I18nStore,
} from "../context/i18n.storage";
import { I18N_MODULE_OPTIONS } from "../i18n.constants";
import { I18nService } from "../i18n.service";
import type { I18nModuleOptions } from "../interfaces/i18n-module-options.interface";
import { LocaleResolution } from "../services/locale-resolution.service";
import { headersOf, queryOf } from "../utils/request.util";

interface NodeResponseLike {
  headersSent?: boolean;
  getHeader?(name: string): unknown;
  setHeader?(name: string, value: string): unknown;
  writeHead?(...args: unknown[]): unknown;
}

interface BunestResponseLike extends ResponseContext {
  getHeader?(name: string): string | undefined;
  isHeadersSent?(): boolean;
}

export type I18nMiddlewareRequest =
  | Request
  | {
      headers: Headers | Record<string, string | string[] | undefined>;
      url?: string;
      originalUrl?: string;
      query?: Record<string, unknown>;
    };

export type I18nMiddlewareResponse = ResponseContext | NodeResponseLike;

/**
 * Resolves the request locale and runs the rest of the request pipeline
 * (guards, interceptors, pipes, handler, exception filters) inside the
 * locale context. `afterGuards` resolvers ranked above the match are left
 * to the interceptor. Supports Bunest's native Web `Request` + `ResponseContext`
 * as well as Node/Express/Fastify `req`/`res` objects. Also sets
 * `Content-Language` and `Vary` unless `responseHeaders: false` (internal).
 */
@Injectable()
export class I18nMiddleware implements BunestMiddleware {
  private readonly resolution: LocaleResolution;
  private readonly i18n: I18nService;
  private readonly options: I18nModuleOptions;

  constructor(
    resolution: LocaleResolution,
    i18n: I18nService,
    @Inject(I18N_MODULE_OPTIONS)
    options: I18nModuleOptions,
  ) {
    this.resolution = resolution;
    this.i18n = i18n;
    this.options = options;
  }

  async use(
    req: I18nMiddlewareRequest,
    res: I18nMiddlewareResponse,
    next: NextFunction | ((err?: unknown) => unknown),
  ): Promise<void> {
    const reqAny = req as {
      headers?: Headers | Record<string, string | string[] | undefined>;
      url?: string;
      originalUrl?: string;
      query?: Record<string, unknown>;
    };
    const query =
      reqAny.query && typeof reqAny.query === "object"
        ? reqAny.query
        : queryOf(reqAny.originalUrl ?? reqAny.url);
    const headers = headersOf(reqAny.headers);

    const { locale, deferred } = await this.resolution.resolveBeforeGuards({
      headers,
      query,
    });

    const store: I18nStore = { locale, service: this.i18n };
    if (deferred.length) {
      store.pending = { resolvers: deferred };
    }

    const reqCtx = getCurrentRequestContext();
    if (reqCtx) {
      bindRequestI18nStore(reqCtx, store);
    }

    if (this.options.responseHeaders !== false) {
      if (isBunestResponse(res)) {
        const corsVary = reqCtx?.hasCorsHeaders()
          ? (reqCtx.corsHeaders.get("vary") ?? undefined)
          : undefined;
        this.setBunestHeaders(res, locale, corsVary);
        store.onChange = (nextLocale) => {
          if (!res.isHeadersSent?.()) {
            res.header("Content-Language", nextLocale);
          }
        };
      } else if (hasSetHeader(res)) {
        this.setNodeHeaders(res, locale);
        store.onChange = (nextLocale) => {
          if (!res.headersSent) {
            res.setHeader!("Content-Language", nextLocale);
          }
        };
      }
    }

    const result = i18nStorage.run(store, () => next());
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      await (result as PromiseLike<unknown>);
    }
  }

  private setBunestHeaders(
    res: BunestResponseLike,
    locale: string,
    corsVary: string | undefined,
  ): void {
    res.header("Content-Language", locale);
    const vary = this.resolution.varyHeaders;
    if (!vary.length) {
      return;
    }
    const existingVary =
      res.getHeader?.("vary") ?? res.getHeaders().get("vary") ?? undefined;
    res.header("Vary", mergeVary([corsVary, existingVary], vary));
  }

  private setNodeHeaders(res: NodeResponseLike, locale: string): void {
    res.setHeader!("Content-Language", locale);
    const vary = this.resolution.varyHeaders;
    if (!vary.length) {
      return;
    }
    res.setHeader!("Vary", mergeVary(res.getHeader?.("vary"), vary));
    // Whatever sets Vary later replaces this value: a handler's @Header(), or
    // Fastify, which passes its reply headers to writeHead(). Merge once more
    // right before the headers go out.
    const writeHead = res.writeHead;
    if (typeof writeHead !== "function") {
      return;
    }
    let merged = false;
    res.writeHead = function (this: NodeResponseLike, ...args: unknown[]) {
      if (!merged) {
        merged = true;
        mergeIntoWriteHead(res, args, vary);
      }
      return writeHead.apply(this, args);
    };
  }
}

function isBunestResponse(res: unknown): res is BunestResponseLike {
  return (
    res !== null &&
    typeof res === "object" &&
    typeof (res as BunestResponseLike).header === "function" &&
    typeof (res as BunestResponseLike).getHeaders === "function"
  );
}

function hasSetHeader(res: unknown): res is NodeResponseLike {
  return (
    res !== null &&
    typeof res === "object" &&
    typeof (res as NodeResponseLike).setHeader === "function"
  );
}

/**
 * Adds `vary` to the Vary header that `writeHead(status, [message], [headers])`
 * is about to send: the one in `headers` when it has one (it wins over
 * setHeader()), the response's own otherwise. Rewrites `args` in place.
 */
function mergeIntoWriteHead(
  res: NodeResponseLike,
  args: unknown[],
  vary: readonly string[],
): void {
  const at = typeof args[1] === "string" ? 2 : 1;
  const headers = args[at];
  if (Array.isArray(headers)) {
    // Raw form: [name, value, name, value, ...]
    const index = headers.findIndex(
      (h, i) => i % 2 === 0 && String(h).toLowerCase() === "vary",
    );
    if (index !== -1) {
      const nextHeaders = [...headers];
      nextHeaders[index + 1] = mergeVary(headers[index + 1], vary);
      args[at] = nextHeaders;
      return;
    }
  } else if (headers && typeof headers === "object") {
    const headerRecord = headers as Record<string, unknown>;
    const name = Object.keys(headerRecord).find(
      (h) => h.toLowerCase() === "vary",
    );
    if (name !== undefined) {
      args[at] = {
        ...headerRecord,
        [name]: mergeVary(headerRecord[name], vary),
      };
      return;
    }
  }
  res.setHeader!("Vary", mergeVary(res.getHeader?.("vary"), vary));
}

/** `current` plus the names it lacks, compared case-insensitively. `*` stays alone. */
function mergeVary(current: unknown, names: readonly string[]): string {
  const values = [current]
    .flat(Infinity)
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.includes("*")) {
    return "*";
  }
  const present = new Set(values.map((value) => value.toLowerCase()));
  return [
    ...values,
    ...names.filter((name) => !present.has(name.toLowerCase())),
  ].join(", ");
}
