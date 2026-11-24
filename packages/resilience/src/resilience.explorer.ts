import {
  Injectable,
  Logger,
  METADATA_KEYS,
  MetadataRegistry,
  RequestMethod,
  type OnModuleInit,
  type Type,
} from "@bunest/core";
import {
  DiscoveryService,
  MetadataScanner,
  type InstanceWrapper,
} from "@bunest/core";
import { signalOfAttempt } from "./context/attempt-scope.context";
import { ResilienceInterceptor } from "./interceptors/resilience.interceptor";
import {
  EntrypointPlanner,
  type Entrypoint,
} from "./services/entrypoint-planner.service";
import {
  collectFallbackTargetMethods,
  hasResilienceMetadata,
  isEntryClass,
  isHandler,
} from "./utils/entrypoint-detection.util";

const SCHEDULE_TIMEOUT_OPTIONS = "SCHEDULE_TIMEOUT_OPTIONS";
const NEST_METHOD_METADATA = "method";
const NEST_ROUTE_ARGS_METADATA = "__routeArguments__";

const UNSAFE_HTTP_METHODS = new Set<string | number>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Runs once at bootstrap (`onModuleInit` of a global module, before any
 * request). It builds every entrypoint's pipeline up front, so misconfiguration
 * fails the boot instead of the first request, and it warns about decorators
 * that will have no effect.
 */
@Injectable()
export class ResilienceExplorer implements OnModuleInit {
  private readonly logger = new Logger("ResilienceModule");

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly planner: EntrypointPlanner,
  ) {}

  onModuleInit(): void {
    const copies = this.discovery
      .getProviders()
      .filter(
        (wrapper) =>
          wrapper.token === ResilienceInterceptor &&
          wrapper.metatype === ResilienceInterceptor,
      ).length;
    if (copies > 1) {
      throw new Error(
        `ResilienceModule is registered ${copies} times (forRoot() or forRootAsync() in more than one module). ` +
          `Each registration adds an app-wide interceptor, so every handler would run under ${copies} pipelines, ` +
          `with retries multiplied and breakers split. Register it once, in the root module: it is global.`,
      );
    }

    const entrypoints: Entrypoint[] = [];
    const signalUsers: Array<{ handler: Function; name: string }> = [];
    const seen = new Set<Type>();

    const visit = (wrapper: InstanceWrapper, isController: boolean) => {
      const cls = classOf(wrapper);
      if (!cls || seen.has(cls)) {
        return;
      }
      seen.add(cls);
      const proto = cls.prototype as Record<string, unknown>;
      const methods = this.scanner.getAllMethodNames(proto);
      const entryClass = isController || isEntryClass(cls);

      if (entryClass) {
        for (const method of methods) {
          const handler = proto[method];
          if (!isHandler(handler)) {
            continue;
          }
          if (usesSignal(cls, method)) {
            signalUsers.push({ handler, name: `${cls.name}.${method}` });
          }
          const scheduled = MetadataRegistry.get<{ timeout?: unknown }>(
            SCHEDULE_TIMEOUT_OPTIONS,
            handler,
          );
          if (scheduled) {
            this.logger.warn(
              `${cls.name}.${method}() has @nestjs/schedule's @Timeout(${scheduled.timeout ?? ""}), which calls it ` +
                `once after startup. For a time budget on each call, import Timeout from @bunest/resilience.`,
            );
          }
        }
      }

      const decorated = methods.filter((m) => hasResilienceMetadata(proto[m]));
      if (decorated.length === 0 && !hasResilienceMetadata(cls)) {
        return;
      }

      const isStatic =
        typeof (wrapper as { isDependencyTreeStatic?: unknown })
          .isDependencyTreeStatic === "function"
          ? (
              wrapper as unknown as { isDependencyTreeStatic(): boolean }
            ).isDependencyTreeStatic()
          : wrapper.isDependencyTreeStatic !== false;

      if (!entryClass) {
        const classDecorated = hasResilienceMetadata(cls);
        const fallbackTargets = collectFallbackTargetMethods(cls);
        for (const method of methods) {
          const fn = proto[method];
          if (typeof fn !== "function") {
            continue;
          }
          const methodDecorated = decorated.includes(method);
          if (
            methodDecorated ||
            (classDecorated && !fallbackTargets.has(method))
          ) {
            entrypoints.push({
              cls,
              handler: fn,
              isStatic,
              isService: true,
            });
          }
        }
        return;
      }

      for (const method of methods) {
        const handler = proto[method];
        if (isHandler(handler)) {
          entrypoints.push({ cls, handler, isStatic });
        } else if (
          decorated.includes(method) &&
          typeof handler === "function"
        ) {
          entrypoints.push({ cls, handler, isStatic, isService: true });
        }
      }
    };

    this.discovery.getControllers().forEach((wrapper) => visit(wrapper, true));
    this.discovery.getProviders().forEach((wrapper) => visit(wrapper, false));

    const { planned, warnings } = this.planner.prepare(entrypoints);
    for (const warning of warnings) {
      this.logger.warn(warning);
    }

    const withPlan = new Set(planned.map(({ handler }) => handler));
    for (const { handler, name } of signalUsers) {
      if (withPlan.has(handler)) {
        continue;
      }
      this.logger.warn(
        `@Signal() on ${name}() is always undefined: the handler has no resilience ` +
          `decorators. Add @Timeout() or @Resilience() to give it an attempt signal.`,
      );
    }

    for (const { handler, plan, isService } of planned) {
      if (isService || !plan.hasRetry || !plan.retryOnMethod) {
        continue;
      }
      if (plan.requestStream) {
        this.logger.warn(
          `@Retry() on ${plan.source}() is inactive: the handler reads a gRPC request stream, ` +
            `which a second attempt couldn't read again.`,
        );
        continue;
      }
      if (plan.idempotent) {
        continue;
      }
      const httpMethod =
        MetadataRegistry.get<string | number>(
          METADATA_KEYS.ROUTE_METHOD,
          handler,
        ) ?? MetadataRegistry.get<string | number>(NEST_METHOD_METADATA, handler);
      const unsafe =
        (httpMethod !== undefined && UNSAFE_HTTP_METHODS.has(httpMethod)) ||
        MetadataRegistry.get("graphql:resolver_type", handler) === "Mutation";
      if (unsafe) {
        this.logger.warn(
          `@Retry() on ${plan.source}() is inactive: it only re-runs safe operations ` +
            `(GET, HEAD, OPTIONS, GraphQL queries). If the handler is safe to repeat, use @Retry({ idempotent: true }).`,
        );
      }
    }
  }
}

function classOf(wrapper: InstanceWrapper): Type | undefined {
  const { metatype, instance } = wrapper;
  if (typeof metatype === "function" && metatype.prototype) {
    return metatype as Type;
  }
  const ctor =
    instance && typeof instance === "object"
      ? (instance.constructor as Type | undefined)
      : undefined;
  return ctor && ctor !== Object ? ctor : undefined;
}

function usesSignal(cls: Type, method: string): boolean {
  const bunestParams = MetadataRegistry.getRouteParameters(cls, method);
  if (
    bunestParams.some(
      (p) => p.source === "custom" && p.factory === signalOfAttempt,
    )
  ) {
    return true;
  }
  const args = MetadataRegistry.get<Record<string, { factory?: unknown }>>(
    NEST_ROUTE_ARGS_METADATA,
    cls,
    method,
  );
  return (
    !!args && Object.values(args).some((arg) => arg.factory === signalOfAttempt)
  );
}
