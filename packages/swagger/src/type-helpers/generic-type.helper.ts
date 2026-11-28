import { HttpStatus, MetadataRegistry, type Type } from "@bunest/core";
import { SWAGGER_METADATA_KEYS } from "../constants";
import { ApiResponse } from "../decorators/api.decorators";
import type {
  ApiPropertyMetadata,
  ApiResponseCommonMetadata,
  ApiSchemaOptions,
} from "../interfaces/openapi.interface";
import { getPluginModelMetadata } from "../plugin-metadata-store";

export const SWAGGER_GENERIC_TYPE_META = Symbol.for(
  "bunest:swagger:generic_type_meta",
);

export const SWAGGER_UNION_TYPE_META = Symbol.for(
  "bunest:swagger:union_type_meta",
);

const STANDARD_SCHEMA_DTO_KEY = Symbol.for("bunest:standard-schema-dto");
const STANDARD_SCHEMA_DTO_METADATA_KEY = "bunest:standard-schema-dto";

export type GenericBindingValue =
  | Type<any>
  | Function
  | readonly [Type<any> | Function]
  | (() => Type<any> | Function | readonly [Type<any> | Function]);

type UnwrapGenericBinding<B> = B extends readonly [infer Item]
  ? Item extends Type<infer V>
    ? V[]
    : unknown[]
  : B extends () => readonly [infer Item]
    ? Item extends Type<infer V>
      ? V[]
      : unknown[]
    : B extends Type<infer V>
      ? V
      : B extends () => Type<infer V>
        ? V
        : unknown;

export type GenericTypeResult<
  TWrapper,
  TBindings extends Record<string, GenericBindingValue>,
> = Omit<TWrapper, keyof TBindings> & {
  [K in keyof TBindings]: UnwrapGenericBinding<TBindings[K]>;
};

export interface GenericTypeOptions {
  readonly name?: string;
  readonly description?: string;
}

export interface SwaggerGenericTypeMeta {
  readonly wrapper: Type<unknown> | Function;
  readonly bindings: Readonly<Record<string, GenericBindingValue>>;
  readonly name: string;
  readonly description?: string;
}

export type UnionVariantInput =
  | Type<any>
  | Function
  | (() => Type<any> | Function);

type UnionVariantInstance<T> = T extends Type<infer V>
  ? V
  : T extends () => Type<infer V>
    ? V
    : unknown;

export interface UnionDiscriminatorOptions {
  readonly propertyName: string;
  readonly mapping?: Readonly<Record<string, UnionVariantInput | string>>;
}

export interface UnionTypeOptions {
  readonly name?: string;
  readonly description?: string;
  readonly discriminator?: UnionDiscriminatorOptions;
}

export interface SwaggerUnionTypeMeta {
  readonly variants: readonly UnionVariantInput[];
  readonly name: string;
  readonly description?: string;
  readonly discriminator?: UnionDiscriminatorOptions;
}

export interface ApiGenericResponseOptions {
  readonly wrapper: Type<any> | Function;
  readonly item: GenericBindingValue;
  readonly isArray?: boolean;
  /**
   * Property name on `wrapper` to bind to `item` (or `[item]` when `isArray: true`).
   * Auto-detects `"data"` or `"items"` on `wrapper` when omitted, defaulting to `"data"`.
   */
  readonly property?: string;
  readonly status?: ApiResponseCommonMetadata["status"];
  readonly description?: string;
  readonly name?: string;
  readonly nullable?: boolean;
  readonly contentType?: string;
  readonly headers?: ApiResponseCommonMetadata["headers"];
  readonly links?: ApiResponseCommonMetadata["links"];
  readonly summary?: string;
}

function isLazyBindingThunk(
  value: unknown,
): value is () => Type<any> | Function | readonly [Type<any> | Function] {
  if (typeof value !== "function") {
    return false;
  }
  if (value.prototype === undefined) {
    return true;
  }
  const src = Function.prototype.toString.call(value).trimStart();
  if (src.startsWith("class ") || src.startsWith("class{")) {
    return false;
  }
  return value.length === 0 && !/^[A-Z]/.test(value.name);
}

function getModelDisplayName(target: unknown): string {
  if (Array.isArray(target)) {
    return `${getModelDisplayName(target[0])}Array`;
  }
  if (isLazyBindingThunk(target)) {
    try {
      return getModelDisplayName(target());
    } catch {
      return "Item";
    }
  }
  if (typeof target === "function") {
    const schemaMeta = MetadataRegistry.getOwn<ApiSchemaOptions>(
      SWAGGER_METADATA_KEYS.API_SCHEMA,
      target,
    );
    return schemaMeta?.name || target.name || "Model";
  }
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  return "Item";
}

function deriveGenericSchemaName(
  wrapper: Type<unknown> | Function,
  bindings: Record<string, GenericBindingValue>,
  explicitName?: string,
): string {
  if (explicitName && explicitName.trim().length > 0) {
    return explicitName.trim();
  }
  const wrapperName = getModelDisplayName(wrapper);
  const bindingValues = Object.values(bindings);
  if (bindingValues.length === 0) {
    return wrapperName;
  }
  const suffix = bindingValues.map((b) => getModelDisplayName(b)).join("And");
  return `${wrapperName}Of${suffix}`;
}

function deriveUnionSchemaName(
  variants: readonly UnionVariantInput[],
  explicitName?: string,
): string {
  if (explicitName && explicitName.trim().length > 0) {
    return explicitName.trim();
  }
  return variants.map((v) => getModelDisplayName(v)).join("Or");
}

function collectWrapperPropertyKeys(wrapper: Function): Set<string> {
  const keys = new Set<string>();
  for (const ctor of MetadataRegistry.getPrototypeChain(wrapper)) {
    const ownProps = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      ctor,
    );
    if (ownProps) {
      for (const prop of ownProps) {
        if (prop?.propertyKey) keys.add(prop.propertyKey);
      }
    }
    const pluginProps = getPluginModelMetadata(ctor);
    if (pluginProps) {
      for (const prop of pluginProps) {
        if (prop?.propertyKey) keys.add(prop.propertyKey);
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(ctor, "_OPENAPI_METADATA_FACTORY") &&
      typeof (ctor as { _OPENAPI_METADATA_FACTORY?: unknown })
        ._OPENAPI_METADATA_FACTORY === "function"
    ) {
      const factoryResult = (
        ctor as unknown as {
          _OPENAPI_METADATA_FACTORY: () => Record<string, unknown>;
        }
      )._OPENAPI_METADATA_FACTORY();
      if (factoryResult && typeof factoryResult === "object") {
        for (const k of Object.keys(factoryResult)) keys.add(k);
      }
    }
  }

  // Also inspect Standard Schema DTO properties if `wrapper` was created via `createSchemaDto`
  const rawStd =
    (wrapper as unknown as Record<PropertyKey, unknown>)[
      STANDARD_SCHEMA_DTO_KEY
    ] ?? MetadataRegistry.get<unknown>(STANDARD_SCHEMA_DTO_METADATA_KEY, wrapper);
  if (rawStd && typeof rawStd === "object") {
    const std = (rawStd as Record<string, unknown>)["~standard"] as
      | {
          jsonSchema?: {
            input?: (opts: { target: string }) => Record<string, unknown>;
            output?: (opts: { target: string }) => Record<string, unknown>;
          };
        }
      | undefined;
    const fn = std?.jsonSchema?.output ?? std?.jsonSchema?.input;
    if (typeof fn === "function") {
      try {
        const json = fn({ target: "draft-2020-12" });
        if (json && typeof json.properties === "object" && json.properties) {
          for (const k of Object.keys(json.properties)) keys.add(k);
        }
      } catch {
        // Ignore if schema cannot emit JSON Schema eagerly
      }
    }
  }

  return keys;
}

function inferGenericTargetProperty(
  wrapper: Function,
  isArray?: boolean,
): string {
  const keys = collectWrapperPropertyKeys(wrapper);
  if (keys.has("data")) {
    return "data";
  }
  if (keys.has("items")) {
    return "items";
  }
  if (isArray && keys.has("results")) {
    return "results";
  }
  return "data";
}

/**
 * Returns the `SwaggerUnionTypeMeta` attached to `target` (or its prototype chain), if any.
 */
export function getUnionTypeMeta(
  target: Function,
): SwaggerUnionTypeMeta | undefined {
  for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
    if (Object.prototype.hasOwnProperty.call(ctor, SWAGGER_UNION_TYPE_META)) {
      return (ctor as unknown as Record<symbol, SwaggerUnionTypeMeta>)[
        SWAGGER_UNION_TYPE_META
      ];
    }
  }
  return undefined;
}

/**
 * Collects all `SwaggerGenericTypeMeta` descriptors along `target`'s prototype chain
 * (base to derived).
 */
export function getGenericTypeMetas(target: Function): SwaggerGenericTypeMeta[] {
  const metas: SwaggerGenericTypeMeta[] = [];
  for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
    if (Object.prototype.hasOwnProperty.call(ctor, SWAGGER_GENERIC_TYPE_META)) {
      const meta = (ctor as unknown as Record<symbol, SwaggerGenericTypeMeta>)[
        SWAGGER_GENERIC_TYPE_META
      ];
      if (meta) metas.push(meta);
    }
  }
  return metas;
}

/**
 * Creates a named runtime DTO subclass combining `WrapperDto`'s OpenAPI metadata
 * with concrete substituted item or array types for generic properties, eliminating
 * manual `@ApiExtraModels()` + `getSchemaPath()` boilerplate.
 *
 * @example
 * ```ts
 * class UserPageDto extends GenericType(PaginatedResponse, { items: [UserDto] }) {}
 * // or inline:
 * @ApiOkResponse({ type: GenericType(ApiResponse, { data: UserDto }) })
 * ```
 */
export function GenericType<
  TWrapper,
  TBindings extends Record<string, GenericBindingValue>,
>(
  WrapperDto: Type<TWrapper>,
  bindings: TBindings,
  opts?: GenericTypeOptions,
): Type<GenericTypeResult<TWrapper, TBindings>> {
  if (typeof WrapperDto !== "function") {
    throw new TypeError(
      "GenericType() requires a wrapper DTO class constructor as its first argument.",
    );
  }
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TypeError(
      "GenericType() requires a bindings object mapping property names to DTO types.",
    );
  }

  const schemaName = deriveGenericSchemaName(WrapperDto, bindings, opts?.name);
  const frozenBindings: Readonly<Record<string, GenericBindingValue>> = {
    ...bindings,
  };

  class GenericDto extends (WrapperDto as unknown as Type<object>) {}

  Object.defineProperty(GenericDto, "name", {
    value: schemaName,
    configurable: true,
  });

  const meta: SwaggerGenericTypeMeta = {
    wrapper: WrapperDto,
    bindings: frozenBindings,
    name: schemaName,
    ...(opts?.description !== undefined
      ? { description: opts.description }
      : {}),
  };

  Object.defineProperty(GenericDto, SWAGGER_GENERIC_TYPE_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });

  if (opts?.name !== undefined || opts?.description !== undefined) {
    MetadataRegistry.define<ApiSchemaOptions>(
      SWAGGER_METADATA_KEYS.API_SCHEMA,
      {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.description !== undefined
          ? { description: opts.description }
          : {}),
      },
      GenericDto,
    );
  }

  return GenericDto as unknown as Type<GenericTypeResult<TWrapper, TBindings>>;
}

/**
 * Creates a named runtime DTO class representing an OpenAPI `oneOf` discriminated
 * or undiscriminated union of variant DTO classes. All referenced variant schemas
 * are automatically registered in `components.schemas` by `SchemaExplorer`.
 *
 * @example
 * ```ts
 * class PetDto extends UnionType([DogDto, CatDto], {
 *   name: "Pet",
 *   discriminator: {
 *     propertyName: "kind",
 *     mapping: { dog: DogDto, cat: CatDto },
 *   },
 * }) {}
 * ```
 */
export function UnionType<const TVariants extends readonly UnionVariantInput[]>(
  variants: TVariants,
  opts?: UnionTypeOptions,
): Type<UnionVariantInstance<TVariants[number]>> {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new TypeError(
      "UnionType() requires a non-empty array of variant DTO classes.",
    );
  }

  const schemaName = deriveUnionSchemaName(variants, opts?.name);

  class UnionDto {
    constructor(data?: Record<string, unknown>) {
      if (data && typeof data === "object") {
        for (const key of Object.keys(data)) {
          if (
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype"
          ) {
            continue;
          }
          (this as Record<string, unknown>)[key] = data[key];
        }
      }
    }
  }

  Object.defineProperty(UnionDto, "name", {
    value: schemaName,
    configurable: true,
  });

  let discriminator: SwaggerUnionTypeMeta["discriminator"];
  if (opts?.discriminator) {
    discriminator = {
      propertyName: opts.discriminator.propertyName,
      ...(opts.discriminator.mapping !== undefined
        ? { mapping: { ...opts.discriminator.mapping } }
        : {}),
    };
  }
  const meta: SwaggerUnionTypeMeta = {
    variants: [...variants],
    name: schemaName,
    ...(opts?.description !== undefined
      ? { description: opts.description }
      : {}),
    ...(discriminator !== undefined ? { discriminator } : {}),
  };

  Object.defineProperty(UnionDto, SWAGGER_UNION_TYPE_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });

  if (opts?.name !== undefined || opts?.description !== undefined) {
    MetadataRegistry.define<ApiSchemaOptions>(
      SWAGGER_METADATA_KEYS.API_SCHEMA,
      {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.description !== undefined
          ? { description: opts.description }
          : {}),
      },
      UnionDto,
    );
  }

  return UnionDto as unknown as Type<UnionVariantInstance<TVariants[number]>>;
}

/**
 * One-line controller/method decorator replacing manual `@ApiExtraModels()` +
 * `allOf`/`getSchemaPath()` boilerplate for generic response wrappers such as
 * `ApiResponse<T>` or `PaginatedResponse<T>`.
 *
 * @example
 * ```ts
 * @Get()
 * @ApiGenericResponse({ wrapper: PaginatedResponse, item: UserDto, isArray: true })
 * listUsers() { ... }
 * ```
 */
export function ApiGenericResponse(
  options: ApiGenericResponseOptions,
): ClassDecorator & MethodDecorator {
  const propName =
    options.property ??
    inferGenericTargetProperty(options.wrapper, options.isArray);

  let binding: GenericBindingValue;
  if (options.isArray && !Array.isArray(options.item)) {
    if (isLazyBindingThunk(options.item)) {
      const thunk = options.item;
      binding = () => {
        const resolved = thunk();
        return Array.isArray(resolved) ? resolved : [resolved];
      };
    } else {
      binding = [options.item as Type<any> | Function];
    }
  } else {
    binding = options.item;
  }

  const BoundGenericDto = GenericType(
    options.wrapper as Type<unknown>,
    { [propName]: binding },
    options.name !== undefined ? { name: options.name } : undefined,
  );

  const defaultDescription =
    options.status === HttpStatus.CREATED ? "Created" : "OK";

  return ApiResponse({
    ...(options.status !== undefined ? { status: options.status } : {}),
    description: options.description ?? defaultDescription,
    type: BoundGenericDto,
    ...(options.nullable !== undefined ? { nullable: options.nullable } : {}),
    ...(options.contentType !== undefined
      ? { contentType: options.contentType }
      : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.links !== undefined ? { links: options.links } : {}),
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
  });
}
