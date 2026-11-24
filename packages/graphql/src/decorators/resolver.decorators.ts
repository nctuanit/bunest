import {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  MetadataRegistry,
  type PipeLike,
  Scope,
} from "@bunest/core";
import { GRAPHQL_METADATA_KEYS } from "../constants";
import type {
  ArgsOptions,
  GqlParamMetadata,
  OperationOptions,
  ResolveFieldMetadata,
  ResolveFieldOptions,
  ResolverMetadata,
  ResolverOperationMetadata,
  ResolverOptions,
  ReturnTypeFunc,
  SubscriptionOptions,
} from "../interfaces/graphql.interface";
import { TypeMetadataStorage } from "../schema/type-metadata.storage";

function isPipeLike(value: unknown): value is PipeLike {
  if (typeof value === "object" && value !== null) {
    return typeof (value as { transform?: unknown }).transform === "function";
  }
  if (typeof value === "function") {
    return (
      typeof (value as { prototype?: { transform?: unknown } }).prototype
        ?.transform === "function"
    );
  }
  return false;
}

/**
 * Marks a class as a GraphQL resolver (and implicitly `@Injectable()` singleton).
 * Optionally binds the resolver to a parent `@ObjectType()` class, thunk, or SDL type name.
 */
export function Resolver(
  of?: string | Function | (() => Function),
  options: ResolverOptions = {},
): ClassDecorator {
  return (target: Function) => {
    const normalizedOf =
      typeof of === "string"
        ? (() => {
            const nameHolder = { [of]: class {} };
            return nameHolder[of]!;
          })()
        : of;
    const meta: ResolverMetadata = {
      of: normalizedOf,
      isAbstract: options.isAbstract,
    };
    MetadataRegistry.define(GRAPHQL_METADATA_KEYS.RESOLVER, meta, target);
    TypeMetadataStorage.addResolverMetadata({
      target,
      typeFn: normalizedOf
        ? () => (typeof normalizedOf === "function" ? normalizedOf : undefined)
        : undefined,
      isAbstract: options.isAbstract,
    });
    if (!MetadataRegistry.hasOwn(METADATA_KEYS.INJECTABLE, target)) {
      MetadataRegistry.define(
        METADATA_KEYS.INJECTABLE,
        { scope: Scope.SINGLETON },
        target,
      );
    }
  };
}

function createOperationDecorator(
  kind: "query" | "mutation" | "subscription",
  metadataKey: symbol,
) {
  return (
    returnTypeFunc: ReturnTypeFunc,
    options: OperationOptions & SubscriptionOptions = {},
  ): MethodDecorator => {
    return (
      target: object,
      propertyKey: string | symbol,
      descriptor: PropertyDescriptor,
    ) => {
      const existing =
        MetadataRegistry.getOwn<readonly ResolverOperationMetadata[]>(
          metadataKey,
          target.constructor,
        ) ?? [];

      const entry: ResolverOperationMetadata = {
        kind,
        handlerKey: propertyKey,
        name: options.name ?? String(propertyKey),
        returnTypeFn: returnTypeFunc,
        description: options.description,
        nullable: options.nullable,
        defaultValue: options.defaultValue,
        deprecationReason: options.deprecationReason,
        complexity: options.complexity,
        filter: options.filter,
        resolve: options.resolve,
      };

      const filtered = existing.filter((op) => op.handlerKey !== propertyKey);
      MetadataRegistry.define(
        metadataKey,
        [...filtered, entry],
        target.constructor,
      );

      const stored = {
        target: target.constructor,
        methodName: String(propertyKey),
        schemaName: entry.name,
        typeFn: returnTypeFunc,
        description: entry.description,
        deprecationReason: entry.deprecationReason,
        options: {
          nullable: entry.nullable,
          defaultValue: entry.defaultValue,
        },
      };
      if (kind === "query") {
        TypeMetadataStorage.addQueryMetadata(stored);
      } else if (kind === "mutation") {
        TypeMetadataStorage.addMutationMetadata(stored);
      } else {
        TypeMetadataStorage.addSubscriptionMetadata(stored);
      }

      return descriptor;
    };
  };
}

export const Query = createOperationDecorator(
  "query",
  GRAPHQL_METADATA_KEYS.QUERIES,
);

export const Mutation = createOperationDecorator(
  "mutation",
  GRAPHQL_METADATA_KEYS.MUTATIONS,
);

export const Subscription = createOperationDecorator(
  "subscription",
  GRAPHQL_METADATA_KEYS.SUBSCRIPTIONS,
);

/**
 * Declares a field resolver method on a `@Resolver(() => ParentType)` class.
 */
export function ResolveField(): MethodDecorator;
export function ResolveField(
  returnTypeFunc: ReturnTypeFunc,
  options?: ResolveFieldOptions,
): MethodDecorator;
export function ResolveField(
  propertyName: string,
  returnTypeFunc?: ReturnTypeFunc,
  options?: ResolveFieldOptions,
): MethodDecorator;
export function ResolveField(
  nameOrReturnType?: string | ReturnTypeFunc,
  returnTypeOrOptions?: ReturnTypeFunc | ResolveFieldOptions,
  maybeOptions?: ResolveFieldOptions,
): MethodDecorator {
  let explicitName: string | undefined;
  let returnTypeFn: ReturnTypeFunc | undefined;
  let options: ResolveFieldOptions = {};

  if (typeof nameOrReturnType === "string") {
    explicitName = nameOrReturnType;
    if (typeof returnTypeOrOptions === "function") {
      returnTypeFn = returnTypeOrOptions;
      options = maybeOptions ?? {};
    } else if (returnTypeOrOptions) {
      options = returnTypeOrOptions;
    }
  } else if (typeof nameOrReturnType === "function") {
    returnTypeFn = nameOrReturnType;
    options = (returnTypeOrOptions as ResolveFieldOptions | undefined) ?? {};
  }

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const existing =
      MetadataRegistry.getOwn<readonly ResolveFieldMetadata[]>(
        GRAPHQL_METADATA_KEYS.RESOLVE_FIELDS,
        target.constructor,
      ) ?? [];

    const entry: ResolveFieldMetadata = {
      handlerKey: propertyKey,
      name: explicitName ?? options.name ?? String(propertyKey),
      returnTypeFn,
      description: options.description,
      nullable: options.nullable,
      defaultValue: options.defaultValue,
      deprecationReason: options.deprecationReason,
      complexity: options.complexity,
      middleware: options.middleware,
    };

    const filtered = existing.filter((rf) => rf.handlerKey !== propertyKey);
    MetadataRegistry.define(
      GRAPHQL_METADATA_KEYS.RESOLVE_FIELDS,
      [...filtered, entry],
      target.constructor,
    );

    TypeMetadataStorage.addResolverPropertyMetadata({
      target: target.constructor,
      methodName: String(propertyKey),
      schemaName: entry.name,
      kind: "external",
      typeFn: returnTypeFn,
      description: entry.description,
      deprecationReason: entry.deprecationReason,
      options: {
        nullable: entry.nullable,
        defaultValue: entry.defaultValue,
      },
      complexity: entry.complexity,
      middleware: entry.middleware,
    });

    return descriptor;
  };
}

/**
 * Deprecated NestJS alias of `@ResolveField()`.
 */
export function ResolveProperty(
  typeFunc?: ReturnTypeFunc,
  options?: ResolveFieldOptions,
): MethodDecorator;
export function ResolveProperty(
  propertyName?: string,
  typeFunc?: ReturnTypeFunc,
  options?: ResolveFieldOptions,
): MethodDecorator;
export function ResolveProperty(
  nameOrReturnType?: string | ReturnTypeFunc,
  returnTypeOrOptions?: ReturnTypeFunc | ResolveFieldOptions,
  maybeOptions?: ResolveFieldOptions,
): MethodDecorator {
  if (typeof nameOrReturnType === "string") {
    return ResolveField(
      nameOrReturnType,
      returnTypeOrOptions as ReturnTypeFunc | undefined,
      maybeOptions,
    );
  }
  if (typeof nameOrReturnType === "function") {
    return ResolveField(
      nameOrReturnType,
      returnTypeOrOptions as ResolveFieldOptions | undefined,
    );
  }
  return ResolveField();
}

function registerGqlParam(
  target: object,
  propertyKey: string | symbol | undefined,
  entry: GqlParamMetadata,
): void {
  if (propertyKey === undefined) {
    throw new Error(
      `GraphQL parameter decorator (@${entry.source}) can only be used on resolver methods, not constructor parameters.`,
    );
  }

  const existing =
    MetadataRegistry.getOwn<readonly GqlParamMetadata[]>(
      GRAPHQL_METADATA_KEYS.PARAMS,
      target,
      propertyKey,
    ) ?? [];

  const duplicate = existing.find((item) => item.index === entry.index);
  if (duplicate) {
    throw new Error(
      `Duplicate GraphQL parameter decorator on ${target.constructor?.name ?? "Resolver"}.${String(propertyKey)} at index ${entry.index}.`,
    );
  }

  const next = [...existing, entry].sort((a, b) => a.index - b.index);
  MetadataRegistry.define(
    GRAPHQL_METADATA_KEYS.PARAMS,
    next,
    target,
    propertyKey,
  );

  if (entry.source === "args") {
    TypeMetadataStorage.addMethodParamMetadata({
      target: target.constructor,
      methodName: String(propertyKey),
      index: entry.index,
      name: entry.key,
      typeFn: entry.typeFn,
      options: {
        nullable: entry.nullable,
        defaultValue: entry.defaultValue,
        deprecationReason: entry.deprecationReason,
      },
    });
  }
}

/**
 * Extracts GraphQL field arguments (either a named argument, whole args object,
 * or `@ArgsType()` DTO) and runs any attached pipes (`ValidationPipe`, `ParseIntPipe`, etc.).
 */
export function Args(): ParameterDecorator;
export function Args(...pipes: PipeLike[]): ParameterDecorator;
export function Args(
  property: string,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function Args(
  property: string,
  options: ArgsOptions,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function Args(
  options: ArgsOptions,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function Args(
  propertyOrOptionsOrPipe?: string | ArgsOptions | PipeLike,
  optionsOrPipe?: ArgsOptions | PipeLike,
  ...restPipes: PipeLike[]
): ParameterDecorator {
  let key: string | undefined;
  let opts: ArgsOptions = {};
  let pipes: PipeLike[] = [];

  if (typeof propertyOrOptionsOrPipe === "string") {
    key = propertyOrOptionsOrPipe;
    if (optionsOrPipe !== undefined && !isPipeLike(optionsOrPipe)) {
      opts = optionsOrPipe as ArgsOptions;
      pipes = [...restPipes];
    } else if (optionsOrPipe !== undefined) {
      pipes = [optionsOrPipe as PipeLike, ...restPipes];
    }
  } else if (
    propertyOrOptionsOrPipe !== undefined &&
    isPipeLike(propertyOrOptionsOrPipe)
  ) {
    pipes = [
      propertyOrOptionsOrPipe,
      ...(optionsOrPipe !== undefined ? [optionsOrPipe as PipeLike] : []),
      ...restPipes,
    ];
  } else if (
    propertyOrOptionsOrPipe !== undefined &&
    typeof propertyOrOptionsOrPipe === "object"
  ) {
    opts = propertyOrOptionsOrPipe as ArgsOptions;
    key = opts.name;
    pipes = [
      ...(optionsOrPipe !== undefined ? [optionsOrPipe as PipeLike] : []),
      ...restPipes,
    ];
  }

  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerGqlParam(target, propertyKey, {
      index: parameterIndex,
      source: "args",
      key,
      typeFn: opts.type,
      description: opts.description,
      nullable: opts.nullable,
      defaultValue: opts.defaultValue,
      deprecationReason: opts.deprecationReason,
      pipes: pipes.length > 0 ? pipes : undefined,
    });
  };
}

/**
 * Injects the parent/root object into a `@ResolveField()` or root resolver parameter.
 */
export function Parent(): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerGqlParam(target, propertyKey, {
      index: parameterIndex,
      source: "parent",
    });
  };
}

export const Root = Parent;

/**
 * Injects the GraphQL request context (or a specific property key) into a resolver parameter.
 */
export function Context(property?: string): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerGqlParam(target, propertyKey, {
      index: parameterIndex,
      source: "context",
      key: property,
    });
  };
}

/**
 * Injects the `GraphQLResolveInfo` AST info object into a resolver parameter.
 */
export function Info(): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerGqlParam(target, propertyKey, {
      index: parameterIndex,
      source: "info",
    });
  };
}

export function getResolverOperations(
  resolverClass: Function,
  metadataKey: symbol,
): ResolverOperationMetadata[] {
  const byHandler = new Map<string | symbol, ResolverOperationMetadata>();
  for (const ctor of MetadataRegistry.getPrototypeChain(resolverClass)) {
    const own = MetadataRegistry.getOwn<readonly ResolverOperationMetadata[]>(
      metadataKey,
      ctor,
    );
    if (!own) continue;
    for (let i = 0; i < own.length; i++) {
      const op = own[i];
      if (op) {
        byHandler.set(op.handlerKey, op);
      }
    }
  }
  return [...byHandler.values()];
}

export function getResolverFields(
  resolverClass: Function,
): ResolveFieldMetadata[] {
  const byHandler = new Map<string | symbol, ResolveFieldMetadata>();
  for (const ctor of MetadataRegistry.getPrototypeChain(resolverClass)) {
    const own = MetadataRegistry.getOwn<readonly ResolveFieldMetadata[]>(
      GRAPHQL_METADATA_KEYS.RESOLVE_FIELDS,
      ctor,
    );
    if (!own) continue;
    for (let i = 0; i < own.length; i++) {
      const rf = own[i];
      if (rf) {
        byHandler.set(rf.handlerKey, rf);
      }
    }
  }
  return [...byHandler.values()];
}

export function getResolverMethodParams(
  resolverClass: Function,
  handlerKey: string | symbol,
): GqlParamMetadata[] {
  let proto: object | null = (resolverClass.prototype as object | null) ?? null;
  let definingProto: object | null = null;

  while (proto && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, handlerKey)) {
      definingProto = proto;
      break;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  if (!definingProto) {
    return [];
  }

  const rawParams =
    MetadataRegistry.getOwn<readonly GqlParamMetadata[]>(
      GRAPHQL_METADATA_KEYS.PARAMS,
      definingProto,
      handlerKey,
    ) ?? [];

  const paramTypes = MetadataRegistry.getOwn<Function[]>(
    DESIGN_METADATA_KEYS.PARAMTYPES,
    definingProto,
    handlerKey,
  );

  return rawParams
    .map((p) => ({
      ...p,
      metatype: p.metatype ?? paramTypes?.[p.index],
    }))
    .sort((a, b) => a.index - b.index);
}
