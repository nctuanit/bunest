import {
  Injectable,
  MetadataRegistry,
  PartialType as BasePartialType,
  PickType as BasePickType,
  OmitType as BaseOmitType,
  IntersectionType as BaseIntersectionType,
  registerMappedTypeMetadataHook,
  type Type,
} from "@bunest/core";
import { GraphQLEnumType } from "../engine";
import { GRAPHQL_METADATA_KEYS } from "../constants";
import type {
  ArgsTypeOptions,
  CreateUnionTypeOptions,
  EnumTypeOptions,
  FieldMetadata,
  FieldMiddleware,
  FieldOptions,
  GqlTypeReference,
  InputTypeMetadata,
  InputTypeOptions,
  InterfaceImplementsInput,
  InterfaceTypeMetadata,
  InterfaceTypeOptions,
  ObjectTypeMetadata,
  ObjectTypeOptions,
  PropertyMetadata,
  ReturnTypeFunc,
  ReturnTypeFuncValue,
  ScalarMetadata,
  UnionTypeRef,
} from "../interfaces/graphql.interface";
import { TypeMetadataStorage } from "../schema/type-metadata.storage";
import { UnableToFindFieldsError } from "../schema/unable-to-find-fields.error";

const enumRegistry = new Map<object, { readonly enumType: GraphQLEnumType }>();
const objectTypesWithImplements = new Set<Function>();

export function resolveImplementedInterfaces(
  input: InterfaceImplementsInput | undefined,
): Function[] {
  if (!input) return [];
  const raw =
    typeof input === "function" &&
    !MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, input)
      ? (input as () => Function | readonly Function[])()
      : input;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Function => typeof item === "function");
  }
  return typeof raw === "function" ? [raw] : [];
}

/**
 * Returns all `@ObjectType()` classes declared with `implements` referencing `iface`.
 */
export function getInterfaceImplementors(iface: Function): Function[] {
  const matched: Function[] = [];
  for (const cls of objectTypesWithImplements) {
    const meta = MetadataRegistry.get<ObjectTypeMetadata>(
      GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
      cls,
    );
    if (!meta?.implements) continue;
    const ifaces = resolveImplementedInterfaces(meta.implements);
    if (ifaces.includes(iface)) {
      matched.push(cls);
    }
  }
  return matched;
}

/**
 * Registers a TypeScript enum object for use in GraphQL code-first schemas.
 */
export function registerEnumType<T extends Record<string, string | number>>(
  enumRef: T,
  options: EnumTypeOptions,
): GraphQLEnumType {
  const existing = enumRegistry.get(enumRef);
  if (existing) {
    return existing.enumType;
  }

  const values: Record<
    string,
    {
      value: string | number;
      description?: string;
      deprecationReason?: string;
    }
  > = {};
  for (const [key, val] of Object.entries(enumRef)) {
    // Skip TypeScript numeric enum reverse mappings
    if (
      typeof enumRef[val as keyof T] === "number" &&
      !Number.isNaN(Number(key))
    ) {
      continue;
    }
    const extra = options.valuesMap?.[key];
    values[key] = {
      value: val,
      ...(extra?.description !== undefined
        ? { description: extra.description }
        : {}),
      ...(extra?.deprecationReason !== undefined
        ? { deprecationReason: extra.deprecationReason }
        : {}),
    };
  }

  const enumType = new GraphQLEnumType({
    name: options.name,
    description: options.description,
    values,
  });

  enumRegistry.set(enumRef, { enumType });
  TypeMetadataStorage.addEnumMetadata({
    ref: enumRef,
    name: options.name,
    description: options.description,
    valuesMap: options.valuesMap,
    registerIn: options.registerIn,
    directives: options.directives,
  });
  return enumType;
}

export function getRegisteredEnumType(
  enumRef: unknown,
): GraphQLEnumType | undefined {
  if (typeof enumRef !== "object" || enumRef === null) {
    return undefined;
  }
  return enumRegistry.get(enumRef)?.enumType;
}

/**
 * Marks a class as a GraphQL Interface Type (`interface Node { ... }`).
 */
export function InterfaceType(options?: InterfaceTypeOptions): ClassDecorator;
export function InterfaceType(
  name: string,
  options?: InterfaceTypeOptions,
): ClassDecorator;
export function InterfaceType(
  nameOrOptions?: string | InterfaceTypeOptions,
  maybeOptions?: InterfaceTypeOptions,
): ClassDecorator {
  return (target: Function) => {
    const opts: InterfaceTypeOptions =
      typeof nameOrOptions === "string"
        ? { ...(maybeOptions ?? {}), name: nameOrOptions }
        : (nameOrOptions ?? {});
    const meta: InterfaceTypeMetadata = {
      name: opts.name ?? target.name,
      description: opts.description,
      isAbstract: opts.isAbstract,
      implements: opts.implements,
      resolveType: opts.resolveType,
      registerIn: opts.registerIn,
    };
    MetadataRegistry.define(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, meta, target);
    TypeMetadataStorage.addInterfaceMetadata({
      target,
      name: meta.name,
      description: meta.description,
      isAbstract: meta.isAbstract,
      interfaces: meta.implements,
      resolveType: meta.resolveType,
      registerIn: meta.registerIn,
    });
  };
}

/**
 * Creates a code-first GraphQL Union Type reference usable in `@Query()`,
 * `@Field()`, and `@ResolveField()` return type thunks.
 */
export function createUnionType<T extends readonly Type<unknown>[]>(
  options: CreateUnionTypeOptions<T>,
): UnionTypeRef<T> {
  const ref = Object.freeze({
    __bunestGraphQLUnion: true as const,
    name: options.name,
    description: options.description,
    types: options.types,
    resolveType: options.resolveType,
    registerIn: options.registerIn,
    directives: options.directives,
  });
  TypeMetadataStorage.addUnionMetadata({
    id: Symbol(options.name),
    name: options.name,
    typesFn: options.types,
    description: options.description,
    resolveType: options.resolveType,
    registerIn: options.registerIn,
    directives: options.directives,
  });
  return ref;
}

export function isUnionTypeRef(value: unknown): value is UnionTypeRef<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<UnionTypeRef>).__bunestGraphQLUnion === true
  );
}

/**
 * Marks a class as a GraphQL Object Type (`type Foo { ... }`).
 */
export function ObjectType(): ClassDecorator;
export function ObjectType(options: ObjectTypeOptions): ClassDecorator;
export function ObjectType(
  name: string,
  options?: ObjectTypeOptions,
): ClassDecorator;
export function ObjectType(
  nameOrOptions?: string | ObjectTypeOptions,
  maybeOptions?: ObjectTypeOptions,
): ClassDecorator {
  return (target: Function) => {
    const opts: ObjectTypeOptions =
      typeof nameOrOptions === "string"
        ? { ...(maybeOptions ?? {}), name: nameOrOptions }
        : (nameOrOptions ?? {});
    const meta: ObjectTypeMetadata = {
      name: opts.name ?? target.name,
      description: opts.description,
      isAbstract: opts.isAbstract,
      implements: opts.implements,
      inheritDescription: opts.inheritDescription,
      registerIn: opts.registerIn,
    };
    MetadataRegistry.define(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, meta, target);
    if (opts.implements !== undefined) {
      objectTypesWithImplements.add(target);
    }
    TypeMetadataStorage.addObjectTypeMetadata({
      target,
      name: meta.name,
      description: meta.description,
      isAbstract: meta.isAbstract,
      inheritDescription: meta.inheritDescription,
      interfaces: meta.implements,
      registerIn: meta.registerIn,
    });
  };
}

/**
 * Marks a class as a GraphQL Input Object Type (`input FooInput { ... }`).
 */
export function InputType(): ClassDecorator;
export function InputType(options: InputTypeOptions): ClassDecorator;
export function InputType(
  name: string,
  options?: InputTypeOptions,
): ClassDecorator;
export function InputType(
  nameOrOptions?: string | InputTypeOptions,
  maybeOptions?: InputTypeOptions,
): ClassDecorator {
  return (target: Function) => {
    const opts: InputTypeOptions =
      typeof nameOrOptions === "string"
        ? { ...(maybeOptions ?? {}), name: nameOrOptions }
        : (nameOrOptions ?? {});
    const meta: InputTypeMetadata = {
      name: opts.name ?? target.name,
      description: opts.description,
      isAbstract: opts.isAbstract,
      isOneOf: opts.isOneOf,
      registerIn: opts.registerIn,
    };
    MetadataRegistry.define(GRAPHQL_METADATA_KEYS.INPUT_TYPE, meta, target);
    TypeMetadataStorage.addInputTypeMetadata({
      target,
      name: meta.name,
      description: meta.description,
      isAbstract: meta.isAbstract,
      isOneOf: meta.isOneOf,
      registerIn: meta.registerIn,
    });
  };
}

/**
 * Marks a class as a GraphQL arguments container whose `@Field()` properties
 * expand directly into GraphQL field arguments via `@Args()`.
 */
export function ArgsType(): ClassDecorator;
export function ArgsType(options: ArgsTypeOptions): ClassDecorator;
export function ArgsType(
  name: string,
  options?: ArgsTypeOptions,
): ClassDecorator;
export function ArgsType(
  nameOrOptions?: string | ArgsTypeOptions,
  maybeOptions?: ArgsTypeOptions,
): ClassDecorator {
  return (target: Function) => {
    const name =
      typeof nameOrOptions === "string" ? nameOrOptions : target.name;
    const opts: ArgsTypeOptions =
      typeof nameOrOptions === "string"
        ? (maybeOptions ?? {})
        : (nameOrOptions ?? {});
    MetadataRegistry.define<boolean>(
      GRAPHQL_METADATA_KEYS.ARGS_TYPE,
      true,
      target,
    );
    TypeMetadataStorage.addArgsMetadata({
      target,
      name,
      registerIn: opts.registerIn,
    });
  };
}

/**
 * Programmatic helper registering GraphQL field metadata onto a class prototype
 * (matching `@nestjs/graphql` `addFieldMetadata`).
 */
export function addFieldMetadata<
  T extends ReturnTypeFuncValue = ReturnTypeFuncValue,
>(
  typeOrOptions: ReturnTypeFunc<T> | FieldOptions | undefined,
  fieldOptions: FieldOptions | undefined,
  prototype: object,
  propertyKey?: string | symbol,
  _descriptor?: TypedPropertyDescriptor<unknown>,
  _loadEagerly?: boolean,
): void {
  if (propertyKey === undefined) {
    return;
  }
  const typeFn =
    typeof typeOrOptions === "function"
      ? (typeOrOptions as ReturnTypeFunc)
      : undefined;
  const options: FieldOptions =
    typeof typeOrOptions === "function"
      ? (fieldOptions ?? {})
      : (typeOrOptions ?? fieldOptions ?? {});

  const key = String(propertyKey);
  const ctor = prototype.constructor;
  const designType = MetadataRegistry.getType(prototype, propertyKey);

  const existing =
    MetadataRegistry.getOwn<readonly FieldMetadata[]>(
      GRAPHQL_METADATA_KEYS.FIELDS,
      ctor,
    ) ?? [];

  const entry: FieldMetadata = {
    ...options,
    propertyKey: key,
    name: options.name ?? key,
    typeFn,
    designType,
  };

  const filtered = existing.filter((f) => f.propertyKey !== key);
  MetadataRegistry.define<FieldMetadata[]>(
    GRAPHQL_METADATA_KEYS.FIELDS,
    [...filtered, entry],
    ctor,
  );

  TypeMetadataStorage.addClassFieldMetadata({
    schemaName: entry.name ?? key,
    name: key,
    typeFn: () =>
      (typeFn ? typeFn() : (designType ?? String)) as GqlTypeReference,
    target: ctor,
    options: {
      nullable: entry.nullable,
      defaultValue: entry.defaultValue,
    },
    description: entry.description,
    deprecationReason: entry.deprecationReason,
    complexity: entry.complexity,
    middleware: entry.middleware,
  });
}

/**
 * Declares a GraphQL field on an `@ObjectType()`, `@InterfaceType()`,
 * `@InputType()`, or `@ArgsType()` class.
 * Copy-on-write on `target.constructor`: subclasses never mutate parent metadata.
 */
export function Field(): PropertyDecorator & MethodDecorator;
export function Field(
  options: FieldOptions,
): PropertyDecorator & MethodDecorator;
export function Field(
  returnTypeFunc: ReturnTypeFunc,
  options?: FieldOptions,
): PropertyDecorator & MethodDecorator;
export function Field(
  returnTypeOrOptions?: ReturnTypeFunc | FieldOptions,
  maybeOptions?: FieldOptions,
): PropertyDecorator & MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    addFieldMetadata(
      returnTypeOrOptions,
      maybeOptions,
      target,
      propertyKey,
      descriptor,
    );
  };
}

/**
 * Applies field middleware to a `@Field()` property or `@ResolveField()` method
 * (matching `@nestjs/graphql@14` `@UseFieldMiddleware(...)`).
 *
 * When stacked, lower decorators run first (matching `@UseGuards()`), and
 * subclasses extend inherited middleware without mutating parent classes.
 */
export function UseFieldMiddleware(
  ...middleware: FieldMiddleware[]
): PropertyDecorator & MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    _descriptor?: PropertyDescriptor,
  ): void => {
    const existing =
      MetadataRegistry.getOwn<readonly FieldMiddleware[]>(
        GRAPHQL_METADATA_KEYS.FIELD_MIDDLEWARE,
        target,
        propertyKey,
      ) ?? [];
    // Lower decorator executes first in JS/TS decorator evaluation order,
    // so appending `middleware` after `existing` ensures lower runs first!
    MetadataRegistry.define<FieldMiddleware[]>(
      GRAPHQL_METADATA_KEYS.FIELD_MIDDLEWARE,
      [...existing, ...middleware],
      target,
      propertyKey,
    );
  };
}

/**
 * Returns inherited + own `@UseFieldMiddleware()` functions applied to a member
 * (base class middleware first, then derived class).
 */
export function getUseFieldMiddleware(
  target: object | undefined,
  propertyKey: string | symbol,
): FieldMiddleware[] {
  if (!target) {
    return [];
  }
  const chain: object[] = [];
  let proto: object | null =
    typeof target === "function"
      ? ((target as Function).prototype as object | null)
      : target;
  while (proto && proto !== Object.prototype) {
    chain.unshift(proto);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  const out: FieldMiddleware[] = [];
  for (const p of chain) {
    const own = MetadataRegistry.getOwn<readonly FieldMiddleware[]>(
      GRAPHQL_METADATA_KEYS.FIELD_MIDDLEWARE,
      p,
      propertyKey,
    );
    if (own && own.length > 0) {
      out.push(...own);
    }
  }
  return out;
}

/**
 * Returns `true` if `@UseFieldMiddleware()` was applied directly on `target`.
 */
export function hasOwnUseFieldMiddleware(
  target: object | undefined,
  propertyKey: string | symbol,
): boolean {
  if (!target) {
    return false;
  }
  const proto =
    typeof target === "function"
      ? ((target as Function).prototype as object | undefined)
      : target;
  if (!proto) return false;
  const own = MetadataRegistry.getOwn<readonly FieldMiddleware[]>(
    GRAPHQL_METADATA_KEYS.FIELD_MIDDLEWARE,
    proto,
    propertyKey,
  );
  return Array.isArray(own) && own.length > 0;
}

/**
 * Marks a provider class as a custom GraphQL Scalar implementation (`CustomScalar`),
 * matching NestJS `@Scalar()`.
 */
export function Scalar(
  name: string,
  typeFunc?: ReturnTypeFunc,
): ClassDecorator {
  return (target: Function) => {
    Injectable()(target);
    const meta: ScalarMetadata = { name, typeFunc };
    MetadataRegistry.define(GRAPHQL_METADATA_KEYS.SCALAR, meta, target);
  };
}

/**
 * Attaches a GraphQL SDL directive (e.g. `@Directive('@key(fields: "id")')`) to a
 * class, field, or resolver method (matching NestJS `@Directive()`).
 */
export function Directive(
  sdl: string,
): ClassDecorator & PropertyDecorator & MethodDecorator {
  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (descriptor && descriptor.value !== undefined) {
      MetadataRegistry.appendOwnArray<string>(
        GRAPHQL_METADATA_KEYS.DIRECTIVES,
        [sdl],
        descriptor.value,
      );
      TypeMetadataStorage.addDirectivePropertyMetadata({
        target: target.constructor,
        fieldName: propertyKey !== undefined ? String(propertyKey) : undefined,
        sdl,
      });
      return;
    }
    if (propertyKey !== undefined) {
      MetadataRegistry.appendOwnArray<string>(
        GRAPHQL_METADATA_KEYS.DIRECTIVES,
        [sdl],
        target.constructor,
        propertyKey,
      );
      TypeMetadataStorage.addDirectivePropertyMetadata({
        target: target.constructor,
        fieldName: String(propertyKey),
        sdl,
      });
      return;
    }
    MetadataRegistry.appendOwnArray<string>(
      GRAPHQL_METADATA_KEYS.DIRECTIVES,
      [sdl],
      target,
    );
    TypeMetadataStorage.addDirectiveMetadata({
      target: target as Function,
      sdl,
    });
  };
}

/**
 * Hides a property from generated GraphQL types (matching NestJS `@HideField()`).
 */
export function HideField(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    const key = String(propertyKey);
    const existing =
      MetadataRegistry.getOwn<readonly string[]>(
        GRAPHQL_METADATA_KEYS.HIDDEN_FIELDS,
        target.constructor,
      ) ?? [];
    if (!existing.includes(key)) {
      MetadataRegistry.define(
        GRAPHQL_METADATA_KEYS.HIDDEN_FIELDS,
        [...existing, key],
        target.constructor,
      );
    }
  };
}

/**
 * Attaches GraphQL `extensions` metadata to a type, field, or resolver method
 * (matching NestJS `@Extensions()`).
 */
export function Extensions(
  value: Record<string, unknown>,
): ClassDecorator & PropertyDecorator & MethodDecorator {
  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (descriptor && descriptor.value !== undefined) {
      const existing =
        MetadataRegistry.getOwn<Record<string, unknown>>(
          GRAPHQL_METADATA_KEYS.EXTENSIONS,
          descriptor.value,
        ) ?? {};
      MetadataRegistry.define(
        GRAPHQL_METADATA_KEYS.EXTENSIONS,
        { ...existing, ...value },
        descriptor.value,
      );
      TypeMetadataStorage.addExtensionsPropertyMetadata({
        target: target.constructor,
        fieldName: propertyKey !== undefined ? String(propertyKey) : undefined,
        value,
      });
      return;
    }
    if (propertyKey !== undefined) {
      const existing =
        MetadataRegistry.getOwn<Record<string, unknown>>(
          GRAPHQL_METADATA_KEYS.EXTENSIONS,
          target.constructor,
          propertyKey,
        ) ?? {};
      MetadataRegistry.define(
        GRAPHQL_METADATA_KEYS.EXTENSIONS,
        { ...existing, ...value },
        target.constructor,
        propertyKey,
      );
      TypeMetadataStorage.addExtensionsPropertyMetadata({
        target: target.constructor,
        fieldName: String(propertyKey),
        value,
      });
      return;
    }
    const existing =
      MetadataRegistry.getOwn<Record<string, unknown>>(
        GRAPHQL_METADATA_KEYS.EXTENSIONS,
        target,
      ) ?? {};
    MetadataRegistry.define(
      GRAPHQL_METADATA_KEYS.EXTENSIONS,
      { ...existing, ...value },
      target,
    );
    TypeMetadataStorage.addExtensionsMetadata({
      target: target as Function,
      value,
    });
  };
}

/**
 * Marks a `@Resolver()` method as an Apollo Federation `__resolveReference`
 * entity resolver (matching NestJS `@ResolveReference()`).
 */
export function ResolveReference(): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<string | symbol>(
      GRAPHQL_METADATA_KEYS.RESOLVE_REFERENCE,
      propertyKey,
      target.constructor,
    );
    return descriptor;
  };
}

/**
 * Reads `@Directive()` annotations on a class or field.
 */
export function getGraphQLDirectives(
  target: object,
  propertyKey?: string | symbol,
): string[] {
  if (propertyKey !== undefined) {
    return [
      ...(MetadataRegistry.get<readonly string[]>(
        GRAPHQL_METADATA_KEYS.DIRECTIVES,
        target,
        propertyKey,
      ) ?? []),
    ];
  }
  return [
    ...(MetadataRegistry.get<readonly string[]>(
      GRAPHQL_METADATA_KEYS.DIRECTIVES,
      target,
    ) ?? []),
  ];
}

/**
 * Reads `@Extensions()` metadata on a class, method, or field.
 */
export function getGraphQLExtensions(
  target: object,
  propertyKey?: string | symbol,
): Record<string, unknown> | undefined {
  if (propertyKey !== undefined) {
    return MetadataRegistry.get<Record<string, unknown>>(
      GRAPHQL_METADATA_KEYS.EXTENSIONS,
      target,
      propertyKey,
    );
  }
  return MetadataRegistry.get<Record<string, unknown>>(
    GRAPHQL_METADATA_KEYS.EXTENSIONS,
    target,
  );
}

/**
 * Inheritance-safe reader collecting `@Field()` metadata from base -> derived class,
 * excluding any properties marked with `@HideField()`.
 */
export function getGraphQLFields(target: Function): FieldMetadata[] {
  const byProp = new Map<string, FieldMetadata>();
  const hidden = new Set<string>();
  for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
    const own = MetadataRegistry.getOwn<readonly FieldMetadata[]>(
      GRAPHQL_METADATA_KEYS.FIELDS,
      ctor,
    );
    if (own) {
      for (let i = 0; i < own.length; i++) {
        const f = own[i];
        if (f) {
          byProp.set(f.propertyKey, f);
        }
      }
    }
    const ownHidden = MetadataRegistry.getOwn<readonly string[]>(
      GRAPHQL_METADATA_KEYS.HIDDEN_FIELDS,
      ctor,
    );
    if (ownHidden) {
      for (const h of ownHidden) {
        hidden.add(h);
      }
    }
  }
  return [...byProp.values()].filter((f) => !hidden.has(f.propertyKey));
}

type GqlDecoratorFactory =
  typeof ArgsType | typeof InterfaceType | typeof ObjectType | typeof InputType;

/**
 * Returns the compiled `PropertyMetadata[]` and matching GraphQL class decorator
 * factory (`ObjectType`, `InputType`, `InterfaceType`, or `ArgsType`) for a class.
 * Throws `UnableToFindFieldsError` if `objType` is not a GraphQL type.
 */
export function getFieldsAndDecoratorForType<T>(
  objType: Type<T>,
  options?: {
    overrideFields?: boolean;
    decorator?: GqlDecoratorFactory;
  },
): {
  fields: PropertyMetadata[];
  decoratorFactory: GqlDecoratorFactory;
} {
  let decoratorFactory: GqlDecoratorFactory | undefined;

  if (options?.decorator) {
    if (
      options.decorator === ObjectType &&
      MetadataRegistry.has(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, objType)
    ) {
      decoratorFactory = ObjectType;
    } else if (
      options.decorator === InputType &&
      MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INPUT_TYPE, objType)
    ) {
      decoratorFactory = InputType;
    } else if (
      options.decorator === InterfaceType &&
      MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, objType)
    ) {
      decoratorFactory = InterfaceType;
    } else if (
      options.decorator === ArgsType &&
      MetadataRegistry.has(GRAPHQL_METADATA_KEYS.ARGS_TYPE, objType)
    ) {
      decoratorFactory = ArgsType;
    }
  }

  if (!decoratorFactory) {
    if (MetadataRegistry.has(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, objType)) {
      decoratorFactory = ObjectType;
    } else if (
      MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INPUT_TYPE, objType)
    ) {
      decoratorFactory = InputType;
    } else if (
      MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, objType)
    ) {
      decoratorFactory = InterfaceType;
    } else if (MetadataRegistry.has(GRAPHQL_METADATA_KEYS.ARGS_TYPE, objType)) {
      decoratorFactory = ArgsType;
    }
  }

  const rawFields = getGraphQLFields(objType);
  if (!decoratorFactory) {
    throw new UnableToFindFieldsError(objType?.name ?? String(objType));
  }

  const fields: PropertyMetadata[] = rawFields.map((f) => ({
    schemaName: f.name ?? f.propertyKey,
    name: f.propertyKey,
    typeFn: () =>
      (f.typeFn ? f.typeFn() : (f.designType ?? String)) as GqlTypeReference,
    target: objType,
    options: {
      nullable: f.nullable,
      defaultValue: f.defaultValue,
    },
    description: f.description,
    deprecationReason: f.deprecationReason,
    directives: getGraphQLDirectives(objType, f.propertyKey),
    extensions: getGraphQLExtensions(objType, f.propertyKey),
    complexity: f.complexity,
    middleware: [
      ...(f.middleware ?? []),
      ...getUseFieldMiddleware(objType, f.propertyKey),
    ],
  }));

  return { fields, decoratorFactory };
}

// Register GraphQL `@Field()` metadata cloning hook with `@bunest/core` Mapped Types
registerMappedTypeMetadataHook((ctx) => {
  const existing =
    MetadataRegistry.getOwn<readonly FieldMetadata[]>(
      GRAPHQL_METADATA_KEYS.FIELDS,
      ctx.target,
    ) ?? [];
  const byProp = new Map<string, FieldMetadata>();
  for (const field of existing) {
    byProp.set(field.propertyKey, field);
  }
  const makeAllOptional = ctx.operation === "partial";
  for (const field of getGraphQLFields(ctx.source)) {
    if (ctx.propertyFilter && !ctx.propertyFilter(field.propertyKey)) {
      continue;
    }
    byProp.set(field.propertyKey, {
      ...field,
      ...(makeAllOptional ? { nullable: true } : {}),
    });
  }
  if (byProp.size > 0) {
    MetadataRegistry.define(
      GRAPHQL_METADATA_KEYS.FIELDS,
      [...byProp.values()],
      ctx.target,
    );
  }
});

type GqlClassDecorator = ClassDecorator | GqlDecoratorFactory;

function applyGqlTargetDecorator<T extends Type<any>>(
  cls: T,
  decorator?: GqlClassDecorator,
): T {
  if (decorator) {
    // Support both `@InputType()` (ClassDecorator) and `InputType` (decorator factory!)
    if (
      decorator === ObjectType ||
      decorator === InputType ||
      decorator === InterfaceType ||
      decorator === ArgsType
    ) {
      (decorator as () => ClassDecorator)()(cls);
    } else {
      (decorator as ClassDecorator)(cls);
    }
  }
  return cls;
}

/**
 * GraphQL-aware `PartialType` supporting optional `decorator` parameter
 * (e.g. `PartialType(User, InputType)` matching `@nestjs/graphql`).
 */
export function PartialType<T>(
  classRef: Type<T>,
  decorator?: GqlClassDecorator,
) {
  const derived = BasePartialType(classRef);
  return applyGqlTargetDecorator(derived, decorator);
}

/**
 * GraphQL-aware `PickType` supporting optional `decorator` parameter.
 */
export function PickType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
  decorator?: GqlClassDecorator,
) {
  const derived = BasePickType(classRef, keys);
  return applyGqlTargetDecorator(derived, decorator);
}

/**
 * GraphQL-aware `OmitType` supporting optional `decorator` parameter.
 */
export function OmitType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
  decorator?: GqlClassDecorator,
) {
  const derived = BaseOmitType(classRef, keys);
  return applyGqlTargetDecorator(derived, decorator);
}

/**
 * GraphQL-aware `IntersectionType` supporting optional `decorator` parameter.
 */
export function IntersectionType<A, B>(
  classARef: Type<A>,
  classBRef: Type<B>,
  decorator?: GqlClassDecorator,
) {
  const derived = BaseIntersectionType(classARef, classBRef);
  return applyGqlTargetDecorator(derived, decorator);
}
