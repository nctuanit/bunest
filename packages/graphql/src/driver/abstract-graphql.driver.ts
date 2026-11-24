import { Injectable, Optional } from "@bunest/core";
import { ApplicationConfig, HttpAdapterHost } from "@bunest/core";
import { normalizePath } from "@bunest/core/http";
import type { GraphQLSchema } from "../engine";
import type {
  GqlModuleOptions,
  GraphQLDriver,
} from "../interfaces/graphql.interface";
import { withFilter } from "../pubsub/pub-sub";
import { GraphQLFactory } from "../schema/graphql.factory";
import { ResolverDecoratorHost } from "../services/resolver-decorator-host";

/**
 * Abstract base GraphQL driver mirroring `@nestjs/graphql` `AbstractGraphQLDriver`.
 */
@Injectable()
export abstract class AbstractGraphQLDriver<
  TOptions extends GqlModuleOptions = GqlModuleOptions,
> implements GraphQLDriver<TOptions> {
  constructor(
    @Optional() protected readonly httpAdapterHost?: HttpAdapterHost,
    @Optional() protected readonly applicationConfig?: ApplicationConfig,
    @Optional() protected readonly graphQlFactory?: GraphQLFactory,
    @Optional()
    protected readonly resolverDecoratorHost?: ResolverDecoratorHost,
  ) {}

  abstract start(options: TOptions): Promise<unknown>;
  abstract stop(): Promise<void>;

  async mergeDefaultOptions(
    options: TOptions,
    defaults: Record<string, unknown> = {
      path: "/graphql",
      fieldResolverEnhancers: [],
      stopOnApplicationShutdown: false,
    },
  ): Promise<TOptions> {
    const merged = {
      ...defaults,
      ...options,
    } as TOptions;

    if (merged.useGlobalPrefix && this.applicationConfig) {
      merged.path = this.getNormalizedPath(merged);
      if (merged.subscriptions && typeof merged.subscriptions === "object") {
        const subs = { ...(merged.subscriptions as Record<string, unknown>) };
        for (const key of ["graphql-ws", "subscriptions-transport-ws"]) {
          const subCfg = subs[key];
          if (subCfg && typeof subCfg === "object") {
            const subObj = subCfg as { path?: string };
            const rawSubPath =
              typeof subObj.path === "string" && subObj.path.length > 0
                ? normalizePath(subObj.path)
                : normalizePath(
                    typeof options.path === "string" && options.path.length > 0
                      ? options.path
                      : "/graphql",
                  );
            subs[key] = {
              ...subObj,
              path: this.applyGlobalPrefix(rawSubPath, merged),
            };
          }
        }
        (merged as Record<string, unknown>).subscriptions = subs;
      }
    }

    return merged;
  }

  generateSchema(options: TOptions): Promise<GraphQLSchema> | null {
    const factory = this.graphQlFactory ?? new GraphQLFactory();
    return factory.generateSchema(options as unknown as GqlModuleOptions);
  }

  subscriptionWithFilter(
    instanceRef: unknown,
    filterFn: (
      payload: any,
      variables: any,
      context: any,
    ) => boolean | Promise<boolean>,
    createSubscribeContext: Function,
  ): (...args: unknown[]) => Promise<AsyncIterable<unknown>> {
    return async (...args: unknown[]) => {
      const subscribeFn = await createSubscribeContext();
      return withFilter(
        () => subscribeFn.apply(instanceRef, args),
        (payload, variables, context) => filterFn(payload, variables, context),
      )(args[0], args[1], args[2], args[3]);
    };
  }

  protected getNormalizedPath(options: TOptions): string {
    const raw =
      typeof options.path === "string" && options.path.length > 0
        ? options.path
        : "/graphql";
    return this.applyGlobalPrefix(normalizePath(raw), options);
  }

  protected applyGlobalPrefix(path: string, options: TOptions): string {
    if (!options.useGlobalPrefix || !this.applicationConfig) {
      return path;
    }
    const prefix = this.applicationConfig.getGlobalPrefix?.();
    if (!prefix) {
      return path;
    }
    const cleanPrefix = normalizePath(prefix);
    if (cleanPrefix === "/" || path.startsWith(`${cleanPrefix}/`)) {
      return path;
    }
    return normalizePath(`${cleanPrefix}/${path}`);
  }
}
