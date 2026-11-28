import {
  APP_GUARD,
  Injectable,
  Logger,
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  type OnModuleInit,
  type Type,
} from "@bunest/core";
import {
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
  ModulesContainer,
  type InstanceWrapper,
} from "@bunest/core";
import { cond } from "@bunest/core/common";
import {
  AUTHENTICATION_GUARD,
  AUTHORIZATION_GUARD,
  POLICY_METADATA,
} from "../authorization.constants";
import { MissingPolicyError } from "../errors/missing-policy.error";
import { routeChecks } from "../utils/route-checks.util";
import type { CanRequirement } from "../interfaces/can-requirement.interface";

const isPolicy = (value: unknown): value is Type<unknown> =>
  typeof value === "function" && !!MetadataRegistry.get(POLICY_METADATA, value);

/**
 * The ability `name` of a policy instance (or of the object that replaces it
 * in a test), or `undefined` when it has none. `before`, `constructor` and
 * the methods every object inherits (`toString`, `hasOwnProperty`) are not
 * abilities, whatever a cast or an ability name taken from input says.
 */
export function findAbility(
  instance: object,
  name: string,
): Function | undefined {
  if (name === "before" || name === "constructor") {
    return undefined;
  }
  const method = (instance as Record<string, unknown>)[name];
  if (
    typeof method !== "function" ||
    method === (Object.prototype as Record<string, unknown>)[name]
  ) {
    return undefined;
  }
  return method;
}

const guardClass = (guard: unknown): Function | undefined =>
  typeof guard === "function"
    ? guard
    : (guard as { constructor?: Function } | undefined)?.constructor;

const isAuthorizationGuard = (guard: unknown): boolean =>
  !!(guardClass(guard) as Record<PropertyKey, unknown> | undefined)?.[
    AUTHORIZATION_GUARD
  ];

const isAuthenticationGuard = (guard: unknown): boolean =>
  (guardClass(guard) as Record<PropertyKey, unknown> | undefined)?.[
    AUTHENTICATION_GUARD
  ] === true;

const AUTHENTICATION_NAME = /auth(?!or|z)|jwt|api-?key/i;

const looksLikeAuthentication = (guard: unknown): boolean =>
  !isAuthorizationGuard(guard) &&
  !isAuthenticationGuard(guard) &&
  AUTHENTICATION_NAME.test(guardClass(guard)?.name ?? "");

const list = (wheres: string[]): string =>
  wheres.length > 3
    ? `${wheres.slice(0, 3).join(", ")} and ${wheres.length - 3} more`
    : wheres.join(", ");

interface GlobalGuardEntry {
  guard: unknown;
  module: string;
  requestScoped: boolean;
}

function orderFix(
  type: Function,
  global: GlobalGuardEntry | undefined,
  authorizationIsGlobal: boolean,
): string {
  if (global?.requestScoped) {
    return (
      "Bunest runs request-scoped global guards after the singleton ones, whatever the import order: make " +
      `${type.name} a singleton (a guard reads the request from its ExecutionContext), or set globalGuard: false ` +
      `and write @UseGuards(${type.name}, AuthorizationGuard).`
    );
  }
  if (global) {
    return `Global guards run in module import order: import ${global.module} before AuthorizationModule.`;
  }
  return authorizationIsGlobal
    ? `Global guards run before @UseGuards(): set globalGuard: false and write @UseGuards(${type.name}, AuthorizationGuard).`
    : `@UseGuards() runs guards in the order listed: write @UseGuards(${type.name}, AuthorizationGuard).`;
}

function misorderMessages(
  misordered: Map<Function, Map<string, string[]>>,
  known: boolean,
): string[] {
  return [...misordered].flatMap(([type, fixes]) =>
    [...fixes].map(([fix, wheres]) => {
      const outcome = known
        ? `@Can() on ${list(wheres)} would see every caller as a guest.`
        : `if ${type.name} authenticates, @Can() on ${list(wheres)} sees every caller as a guest.`;
      return `AuthorizationGuard runs before ${type.name}, so ${outcome} ${fix}`;
    }),
  );
}

const MESSAGE_PATTERN = "microservices:pattern";
const GRAPHQL_FIELD_RESOLVER = "graphql:resolve_property";
const GRAPHQL_REFERENCE_RESOLVER = "graphql:resolve_reference";
const GRAPHQL_MODULE_OPTIONS = "GqlModuleOptions";

const HANDLER_METADATA: readonly (string | symbol)[] = [
  METADATA_KEYS.ROUTE_METHOD,
  "method",
  MESSAGE_PATTERN,
  "websockets:message_mapping",
  "graphql:resolver_type",
  GRAPHQL_FIELD_RESOLVER,
  GRAPHQL_REFERENCE_RESOLVER,
  "nestjs:mcp:primitive",
];

const routesOf = (method: Function): (string | symbol)[] =>
  HANDLER_METADATA.filter(
    (key) => MetadataRegistry.get(key, method) !== undefined,
  );

function readGuardsMetadata(target: object): unknown[] {
  const bunestGuards =
    MetadataRegistry.get<unknown[]>(METADATA_KEYS.GUARDS, target) ?? [];
  const legacyGuards = MetadataRegistry.get<unknown[]>("__guards__", target) ?? [];
  if (legacyGuards.length === 0) {
    return bunestGuards;
  }
  if (bunestGuards.length === 0) {
    return legacyGuards;
  }
  return [...bunestGuards, ...legacyGuards];
}

interface CanTarget {
  where: string;
  requirements: Array<CanRequirement & { declaredOn: string }>;
  guards: unknown[];
  fieldResolver: boolean;
  referenceResolver: boolean;
  messageHandler: boolean;
  open: boolean;
}

/**
 * Finds every `@Policy()` provider in the application, wherever it is
 * registered, and checks at startup that each `@Can()` can work.
 */
@Injectable()
export class PolicyRegistry implements OnModuleInit {
  private readonly logger = new Logger("Authorization");
  private policies?: Map<Type<unknown>, unknown>;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly modules: ModulesContainer,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    this.load();
    this.verifyCanUsage();
  }

  get<P>(policy: Type<P>): P {
    const instance =
      this.load().get(policy) ??
      (isPolicy(policy) ? this.load(true).get(policy) : undefined);
    if (instance) {
      return instance as P;
    }
    throw new MissingPolicyError(this.whyMissing(policy));
  }

  private load(refresh = false): Map<Type<unknown>, unknown> {
    if (this.policies && !refresh) {
      return this.policies;
    }
    const policies = new Map<Type<unknown>, unknown>();
    for (const wrapper of this.discovery.getProviders()) {
      const key = [wrapper.token, wrapper.metatype].find(isPolicy);
      if (!key || policies.has(key)) {
        continue;
      }
      const isStatic =
        typeof wrapper.isDependencyTreeStatic === "function"
          ? (wrapper.isDependencyTreeStatic as () => boolean)()
          : wrapper.isDependencyTreeStatic !== false;
      const isTransient = wrapper.scope === Scope.TRANSIENT;
      if (!isStatic || isTransient) {
        const why = cond(
          [
            [isTransient, "is transient"],
            [wrapper.scope === Scope.REQUEST, "is request-scoped"],
          ],
          "depends on a request-scoped provider",
        );
        throw new Error(
          `${key.name} ${why}. Policies must be singletons: pass what varies per request to the ability as an argument.`,
        );
      }
      if (wrapper.instance !== undefined) {
        policies.set(key, wrapper.instance);
      }
    }
    this.policies = policies;
    return policies;
  }

  private whyMissing(policy: Type<unknown>): string {
    const name = policy.name;
    return isPolicy(policy)
      ? `${name} is not registered. Add it to the providers of a module, or to AuthorizationModule.forRoot({ policies }).`
      : `${name} is not a policy. Decorate it with @Policy() and register it as a provider.`;
  }

  private verifyCanUsage(): void {
    const targets = this.collectCanTargets();
    if (targets.length === 0) {
      return;
    }
    const policies = this.load();
    const globals = this.globalGuards();
    const globalGuards = globals.map(({ guard }) => guard);
    const guardsFieldResolvers = this.graphqlGuardsFieldResolvers();
    const missing = new Set<string>();
    const unguardedFields: string[] = [];
    const unenforced: string[] = [];
    const undeclared: string[] = [];
    const undeclaredIfInherited: string[] = [];
    const httpApp = !!this.adapterHost?.httpAdapter;
    const misordered = new Map<Function, Map<string, string[]>>();
    const suspected = new Map<Function, Map<string, string[]>>();

    for (const {
      where,
      requirements,
      guards,
      fieldResolver,
      referenceResolver,
      messageHandler,
      open,
    } of targets) {
      if (requirements.length === 0) {
        const guarded = [...globalGuards, ...guards].some(isAuthorizationGuard);
        if (
          !open &&
          guarded &&
          (!fieldResolver || guardsFieldResolvers === true)
        ) {
          const onlyGlobal =
            httpApp && messageHandler && !guards.some(isAuthorizationGuard);
          (onlyGlobal ? undeclaredIfInherited : undeclared).push(where);
        }
        continue;
      }

      for (const { policy, ability, declaredOn } of requirements) {
        const instance = policies.get(policy);
        const at = `@Can(${policy.name}, '${ability}') on ${declaredOn}`;
        if (!instance) {
          missing.add(`${at}: ${this.whyMissing(policy)}`);
        } else if (!findAbility(instance as object, ability)) {
          missing.add(`${at}: ${policy.name} has no ability '${ability}'.`);
        }
      }

      if (fieldResolver && guardsFieldResolvers === false) {
        const kind = referenceResolver ? "reference" : "field";
        for (const { policy, ability, declaredOn } of requirements) {
          if (declaredOn === where) {
            unguardedFields.push(
              `@Can(${policy.name}, '${ability}') on ${where} is not enforced: GraphQL runs guards on ${kind} ` +
                `resolvers only with fieldResolverEnhancers: ['guards'] in the GraphQLModule options.`,
            );
          } else if (referenceResolver) {
            unguardedFields.push(
              `@Can(${policy.name}, '${ability}') on ${declaredOn} is not enforced on ${where}: GraphQL runs guards ` +
                `on reference resolvers only with fieldResolverEnhancers: ['guards'] in the GraphQLModule options. ` +
                `Where anyone may resolve the entity, add @Can.Anyone() to ${where}.`,
            );
          }
        }
        continue;
      }

      const chain = [...globalGuards, ...guards];
      const authz = chain.findIndex(isAuthorizationGuard);
      if (authz === -1) {
        unenforced.push(where);
        continue;
      }

      const authenticated = chain.slice(0, authz).some(isAuthenticationGuard);
      for (let index = authz + 1; index < chain.length; index++) {
        const guard = chain[index];
        let found: Map<Function, Map<string, string[]>> | undefined;
        if (isAuthenticationGuard(guard)) {
          found = authenticated ? undefined : misordered;
        } else if (looksLikeAuthentication(guard)) {
          found = suspected;
        }
        if (!found) {
          continue;
        }
        const type = guardClass(guard);
        if (!type) continue;
        const fix = orderFix(type, globals[index], authz < globals.length);
        const fixes = found.get(type) ?? new Map<string, string[]>();
        fixes.set(fix, [...(fixes.get(fix) ?? []), where]);
        found.set(type, fixes);
      }
    }

    if (missing.size > 0) {
      throw new MissingPolicyError([...missing].join("\n"));
    }
    if (unguardedFields.length > 0) {
      throw new Error(unguardedFields.join("\n"));
    }
    if (misordered.size > 0) {
      throw new Error(misorderMessages(misordered, true).join("\n"));
    }
    if (unenforced.length > 0) {
      this.logger.error(
        `@Can() is not enforced on ${list(unenforced)}: AuthorizationModule has globalGuard: false, ` +
          `and these handlers have no @UseGuards(AuthorizationGuard).`,
      );
    }
    for (const message of misorderMessages(suspected, false)) {
      this.logger.error(message);
    }
    if (undeclared.length > 0) {
      this.logger.error(
        `AuthorizationGuard denies every call to ${undeclared.join(", ")}: ` +
          `${undeclared.length === 1 ? "it declares" : "they declare"} no check. Add @Can(), or @Can.Anyone() ` +
          `where anyone may call the handler (a @Public() route from @bunest/authentication needs neither).`,
      );
    }
    if (undeclaredIfInherited.length > 0) {
      const one = undeclaredIfInherited.length === 1;
      this.logger.warn(
        `In a microservice connected with inheritAppConfig: true, AuthorizationGuard denies every call to ` +
          `${undeclaredIfInherited.join(", ")}: ${one ? "it declares" : "they declare"} no check. Without that ` +
          `option, Bunest runs none of the app's global guards on ${one ? "it" : "them"}. Add @Can(), or ` +
          `@Can.Anyone() where anyone may call the handler.`,
      );
    }
  }

  private collectCanTargets(): CanTarget[] {
    const targets: CanTarget[] = [];
    const seen = new Set<Function>();
    for (const wrapper of [
      ...this.discovery.getControllers(),
      ...this.discovery.getProviders(),
    ]) {
      const type = classOf(wrapper);
      if (!type || seen.has(type)) {
        continue;
      }
      seen.add(type);
      const classGuards = readGuardsMetadata(type);
      for (const key of this.metadataScanner.getAllMethodNames(
        type.prototype as object,
      )) {
        const method = (type.prototype as Record<string, unknown>)[key];
        if (typeof method !== "function") continue;
        const { onClass, onMethod, open } = routeChecks(type, method);
        const routes = routesOf(method);
        const covered =
          onClass.length > 0 && MetadataRegistry.getOwnKeys(method).length > 0;
        if (onMethod.length === 0 && !covered && routes.length === 0) {
          continue;
        }
        const fromClass = covered ? onClass : [];
        const where = `${type.name}.${key}`;
        targets.push({
          where,
          requirements: [
            ...fromClass.map((requirement) => ({
              ...requirement,
              declaredOn: type.name,
            })),
            ...onMethod.map((requirement) => ({
              ...requirement,
              declaredOn: where,
            })),
          ],
          guards: [...classGuards, ...readGuardsMetadata(method)],
          fieldResolver:
            MetadataRegistry.get(GRAPHQL_FIELD_RESOLVER, method) === true ||
            MetadataRegistry.get(GRAPHQL_REFERENCE_RESOLVER, method) === true,
          referenceResolver:
            MetadataRegistry.get(GRAPHQL_REFERENCE_RESOLVER, method) === true,
          messageHandler: routes.length === 1 && routes[0] === MESSAGE_PATTERN,
          open,
        });
      }
    }
    return targets;
  }

  private graphqlGuardsFieldResolvers(): boolean | undefined {
    const options = this.discovery
      .getProviders()
      .find((wrapper) => wrapper.token === GRAPHQL_MODULE_OPTIONS)?.instance as
      { fieldResolverEnhancers?: string[] } | undefined;
    if (!options) {
      return undefined;
    }
    return options.fieldResolverEnhancers?.includes("guards") ?? false;
  }

  private globalGuards(): GlobalGuardEntry[] {
    const singletons: GlobalGuardEntry[] = [];
    const requestScoped: GlobalGuardEntry[] = [];

    for (const moduleNode of this.modules.values()) {
      const moduleName = moduleNode.metatype.name;
      const entries = moduleNode.multiProviders?.get(APP_GUARD) ?? [];
      for (const provider of entries) {
        let guard: unknown;
        if (provider.useExisting !== undefined) {
          const found = this.discovery.getProviderByToken(provider.useExisting);
          guard = found?.instance ?? provider.useExisting;
        } else if (provider.useClass !== undefined) {
          const found = this.discovery.getProviderByToken(provider.useClass);
          guard = found?.instance ?? provider.useClass;
        } else if (provider.useValue !== undefined) {
          guard = provider.useValue;
        }
        if (!guard) continue;
        const isReq =
          provider.scope === Scope.REQUEST ||
          provider.scope === Scope.TRANSIENT;
        if (isReq) {
          requestScoped.push({
            guard,
            module: moduleName,
            requestScoped: true,
          });
        } else {
          singletons.push({ guard, module: moduleName, requestScoped: false });
        }
      }
    }

    return [...singletons, ...requestScoped];
  }
}

function classOf(wrapper: InstanceWrapper): Function | undefined {
  const { metatype } = wrapper;
  if (typeof metatype !== "function" || !metatype.prototype) {
    return undefined;
  }
  return metatype;
}
