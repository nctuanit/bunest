import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/common";
import { getCurrentRequestContext } from "@bunest/http";
import {
  bindRequestI18nStore,
  changeLocale,
  getI18nStore,
  i18nStorage,
  type I18nStore,
} from "../context/i18n.storage";
import { I18nService } from "../i18n.service";
import type { LocaleResolverInput } from "../interfaces/locale-resolver-input.interface";
import { LocaleResolution } from "../services/locale-resolution.service";
import { headersOf, queryOf } from "../utils/request.util";

interface RequestWithHeaders {
  headers: Headers | Record<string, string | string[] | undefined>;
  url?: string;
  originalUrl?: string;
  query?: Record<string, unknown>;
}

/**
 * Enters the locale context where the HTTP middleware doesn't: microservices,
 * WebSocket gateways, GraphQL subscriptions, and GraphQL drivers mounted
 * outside Bunest's middleware. Interceptors run after guards, so guards on
 * those paths don't see the locale. Where the middleware has entered the
 * context, runs the `afterGuards` resolvers it left (internal).
 */
@Injectable()
export class I18nInterceptor implements BunestInterceptor {
  private readonly resolution: LocaleResolution;
  private readonly i18n: I18nService;

  constructor(resolution: LocaleResolution, i18n: I18nService) {
    this.resolution = resolution;
    this.i18n = i18n;
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const store = getI18nStore();
    if (!store) {
      const locale = await this.resolution.resolve(toResolverInput(context));
      const nextStore: I18nStore = { locale, service: this.i18n };
      const reqCtx = getCurrentRequestContext();
      if (reqCtx) {
        bindRequestI18nStore(reqCtx, nextStore);
      }
      return i18nStorage.run(nextStore, () => next.handle());
    }

    const pending = store.pending;
    if (!pending) {
      return next.handle();
    }

    pending.settled ??= this.settle(store, pending, context);
    await pending.settled;
    return i18nStorage.run(store, () => next.handle());
  }

  private async settle(
    store: I18nStore,
    pending: NonNullable<I18nStore["pending"]>,
    context: ExecutionContext,
  ): Promise<void> {
    const locale = await this.resolution.first(
      pending.resolvers,
      toResolverInput(context),
    );
    // `setLocale()` may have settled it meanwhile: an explicit choice wins.
    if (store.pending !== pending) {
      return;
    }
    store.pending = undefined;
    if (locale) {
      changeLocale(store, locale);
    }
  }
}

function toResolverInput(context: ExecutionContext): LocaleResolverInput {
  const request = requestOf(context);
  const query =
    request?.query && typeof request.query === "object"
      ? request.query
      : queryOf(request?.originalUrl ?? request?.url);
  return {
    headers: headersOf(request?.headers),
    query,
    executionContext: context,
  };
}

function requestOf(context: ExecutionContext): RequestWithHeaders | undefined {
  const contextType = context.getType() as string;
  switch (contextType) {
    case "http":
      return withHeaders(context.switchToHttp().getRequest<unknown>());
    case "ws": {
      // socket.io keeps the handshake; raw WebSockets store upgrade request on `client.request`.
      const client = context.switchToWs().getClient<Record<string, unknown>>();
      return withHeaders(client?.handshake) ?? withHeaders(client?.request);
    }
    case "graphql": {
      // Resolvers get (root, args, context, info). Apollo puts the HTTP request
      // at `req`, Mercurius at `reply.request`. For graphql-ws subscriptions,
      // the upgrade request is at `extra.request` of graphql-ws's context.
      const gql = (context.getArgByIndex<Record<string, unknown>>(2) ??
        {}) as Record<string, any>;
      return (
        withHeaders(gql.req) ??
        withHeaders(gql.reply?.request) ??
        withHeaders(gql.req?.extra?.request) ??
        withHeaders(gql.extra?.request)
      );
    }
    default:
      return undefined;
  }
}

function withHeaders(value: unknown): RequestWithHeaders | undefined {
  return value !== null &&
    typeof value === "object" &&
    "headers" in value &&
    Boolean((value as { headers?: unknown }).headers)
    ? (value as RequestWithHeaders)
    : undefined;
}
