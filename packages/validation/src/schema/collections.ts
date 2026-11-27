import {
  BaseSchema,
  OptionalSchema,
  applyMetaToJsonSchema,
  describeType,
  isPromiseLike,
  prependIssuePath,
} from "./base";
import type {
  InferInput,
  InferOutput,
  JsonSchemaContext,
  Prettify,
  SchemaMeta,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1Result,
} from "./types";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return false;
  }
  return true;
}

type ArrayCheck =
  | { readonly kind: "min"; readonly value: number; readonly message?: string }
  | { readonly kind: "max"; readonly value: number; readonly message?: string }
  | {
      readonly kind: "length";
      readonly value: number;
      readonly message?: string;
    };

export class ArraySchema<
  TItem extends BaseSchema<any, any>,
  TOutput extends unknown[] = InferOutput<TItem>[],
> extends BaseSchema<InferInput<TItem>[], TOutput> {
  private readonly checks: readonly ArrayCheck[];

  constructor(
    readonly element: TItem,
    checks: readonly ArrayCheck[] = [],
    meta?: SchemaMeta,
  ) {
    super(meta);
    this.checks = checks;
  }

  private _addCheck<NextOutput extends unknown[] = TOutput>(
    check: ArrayCheck,
  ): ArraySchema<TItem, NextOutput> {
    return new ArraySchema<TItem, NextOutput>(
      this.element,
      [...this.checks, check],
      this._meta,
    );
  }

  min(length: number, message?: string): ArraySchema<TItem, TOutput> {
    return this._addCheck({ kind: "min", value: length, message });
  }

  max(length: number, message?: string): ArraySchema<TItem, TOutput> {
    return this._addCheck({ kind: "max", value: length, message });
  }

  length(length: number, message?: string): ArraySchema<TItem, TOutput> {
    return this._addCheck({ kind: "length", value: length, message });
  }

  nonempty(
    message?: string,
  ): ArraySchema<TItem, [InferOutput<TItem>, ...InferOutput<TItem>[]]> {
    return this._addCheck<[InferOutput<TItem>, ...InferOutput<TItem>[]]>({
      kind: "min",
      value: 1,
      message: message ?? "Array must not be empty",
    });
  }

  private _validateLength(arr: readonly unknown[]): StandardSchemaV1Issue[] {
    const issues: StandardSchemaV1Issue[] = [];
    for (let i = 0; i < this.checks.length; i++) {
      const check = this.checks[i]!;
      if (check.kind === "min" && arr.length < check.value) {
        issues.push({
          message:
            check.message ??
            `Array must contain at least ${check.value} element(s)`,
        });
      } else if (check.kind === "max" && arr.length > check.value) {
        issues.push({
          message:
            check.message ??
            `Array must contain at most ${check.value} element(s)`,
        });
      } else if (check.kind === "length" && arr.length !== check.value) {
        issues.push({
          message:
            check.message ??
            `Array must contain exactly ${check.value} element(s)`,
        });
      }
    }
    return issues;
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<TOutput>
    | Promise<StandardSchemaV1Result<TOutput>> {
    if (!Array.isArray(value)) {
      return {
        issues: [{ message: `Expected array, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = this._validateLength(value);
    const out: unknown[] = new Array(value.length);
    let asyncEntries: Array<{
      index: number;
      promise: PromiseLike<StandardSchemaV1Result<unknown>>;
    }> | null = null;

    for (let i = 0; i < value.length; i++) {
      const res = this.element._parse(value[i], options);
      if (isPromiseLike(res)) {
        asyncEntries ??= [];
        asyncEntries.push({ index: i, promise: res });
      } else if (res.issues) {
        issues.push(...prependIssuePath(res.issues, i));
      } else {
        out[i] = res.value;
      }
    }

    if (asyncEntries) {
      return Promise.all(
        asyncEntries.map((entry) =>
          Promise.resolve(entry.promise).then((res) => ({
            index: entry.index,
            res,
          })),
        ),
      ).then((settled) => {
        for (const item of settled) {
          if (item.res.issues) {
            issues.push(...prependIssuePath(item.res.issues, item.index));
          } else {
            out[item.index] = item.res.value;
          }
        }
        return issues.length > 0 ? { issues } : { value: out as TOutput };
      });
    }

    return issues.length > 0 ? { issues } : { value: out as TOutput };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const out: Record<string, unknown> = {
      type: "array",
      items: this.element._toJsonSchema(ctx),
    };
    for (let i = 0; i < this.checks.length; i++) {
      const check = this.checks[i]!;
      if (check.kind === "min") {
        out.minItems =
          typeof out.minItems === "number"
            ? Math.max(out.minItems, check.value)
            : check.value;
      } else if (check.kind === "max") {
        out.maxItems =
          typeof out.maxItems === "number"
            ? Math.min(out.maxItems, check.value)
            : check.value;
      } else if (check.kind === "length") {
        out.minItems =
          typeof out.minItems === "number"
            ? Math.max(out.minItems, check.value)
            : check.value;
        out.maxItems =
          typeof out.maxItems === "number"
            ? Math.min(out.maxItems, check.value)
            : check.value;
      }
    }
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new ArraySchema<TItem, TOutput>(
      this.element,
      this.checks,
      meta,
    ) as this;
  }
}

export type TupleItems = readonly [
  BaseSchema<any, any>,
  ...BaseSchema<any, any>[],
];

type TupleInput<
  TItems extends readonly BaseSchema<any, any>[],
  TRest extends BaseSchema<any, any> | undefined,
> = TRest extends BaseSchema<any, any>
  ? [
      ...{ [K in keyof TItems]: InferInput<TItems[K]> },
      ...InferInput<TRest>[],
    ]
  : { [K in keyof TItems]: InferInput<TItems[K]> };

type TupleOutput<
  TItems extends readonly BaseSchema<any, any>[],
  TRest extends BaseSchema<any, any> | undefined,
> = TRest extends BaseSchema<any, any>
  ? [
      ...{ [K in keyof TItems]: InferOutput<TItems[K]> },
      ...InferOutput<TRest>[],
    ]
  : { [K in keyof TItems]: InferOutput<TItems[K]> };

export class TupleSchema<
  TItems extends readonly BaseSchema<any, any>[],
  TRest extends BaseSchema<any, any> | undefined = undefined,
> extends BaseSchema<TupleInput<TItems, TRest>, TupleOutput<TItems, TRest>> {
  constructor(
    readonly items: TItems,
    readonly restSchema?: TRest,
    meta?: SchemaMeta,
  ) {
    super(meta);
  }

  rest<NewRest extends BaseSchema<any, any>>(
    schema: NewRest,
  ): TupleSchema<TItems, NewRest> {
    return new TupleSchema(this.items, schema, this._meta);
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<TupleOutput<TItems, TRest>>
    | Promise<StandardSchemaV1Result<TupleOutput<TItems, TRest>>> {
    if (!Array.isArray(value)) {
      return {
        issues: [{ message: `Expected tuple array, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = [];
    if (value.length < this.items.length) {
      issues.push({
        message: `Tuple must contain at least ${this.items.length} element(s), received ${value.length}`,
      });
    } else if (!this.restSchema && value.length > this.items.length) {
      issues.push({
        message: `Tuple must contain at most ${this.items.length} element(s), received ${value.length}`,
      });
    }

    const out: unknown[] = new Array(value.length);
    let asyncEntries: Array<{
      index: number;
      promise: PromiseLike<StandardSchemaV1Result<unknown>>;
    }> | null = null;

    const fixedCount = Math.min(value.length, this.items.length);
    for (let i = 0; i < fixedCount; i++) {
      const res = this.items[i]!._parse(value[i], options);
      if (isPromiseLike(res)) {
        asyncEntries ??= [];
        asyncEntries.push({ index: i, promise: res });
      } else if (res.issues) {
        issues.push(...prependIssuePath(res.issues, i));
      } else {
        out[i] = res.value;
      }
    }

    if (this.restSchema) {
      for (let i = this.items.length; i < value.length; i++) {
        const res = this.restSchema._parse(value[i], options);
        if (isPromiseLike(res)) {
          asyncEntries ??= [];
          asyncEntries.push({ index: i, promise: res });
        } else if (res.issues) {
          issues.push(...prependIssuePath(res.issues, i));
        } else {
          out[i] = res.value;
        }
      }
    }

    if (asyncEntries) {
      return Promise.all(
        asyncEntries.map((entry) =>
          Promise.resolve(entry.promise).then((res) => ({
            index: entry.index,
            res,
          })),
        ),
      ).then((settled) => {
        for (const item of settled) {
          if (item.res.issues) {
            issues.push(...prependIssuePath(item.res.issues, item.index));
          } else {
            out[item.index] = item.res.value;
          }
        }
        return issues.length > 0
          ? { issues }
          : { value: out as TupleOutput<TItems, TRest> };
      });
    }

    return issues.length > 0
      ? { issues }
      : { value: out as TupleOutput<TItems, TRest> };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const itemSchemas = this.items.map((item) => item._toJsonSchema(ctx));
    const restJson = this.restSchema
      ? this.restSchema._toJsonSchema(ctx)
      : undefined;

    if (ctx.target === "draft-2020-12") {
      const out: Record<string, unknown> = {
        type: "array",
        prefixItems: itemSchemas,
        minItems: this.items.length,
        ...(restJson !== undefined
          ? { items: restJson }
          : { items: false, maxItems: this.items.length }),
      };
      return applyMetaToJsonSchema(out, this._meta, ctx.target);
    }

    if (ctx.target === "draft-07") {
      const out: Record<string, unknown> = {
        type: "array",
        items: itemSchemas,
        minItems: this.items.length,
        ...(restJson !== undefined
          ? { additionalItems: restJson }
          : { additionalItems: false, maxItems: this.items.length }),
      };
      return applyMetaToJsonSchema(out, this._meta, ctx.target);
    }

    // openapi-3.0 does not support prefixItems or tuple items array
    const allSchemas = restJson ? [...itemSchemas, restJson] : itemSchemas;
    const out: Record<string, unknown> = {
      type: "array",
      minItems: this.items.length,
      ...(restJson === undefined ? { maxItems: this.items.length } : {}),
      items:
        allSchemas.length === 0
          ? {}
          : allSchemas.length === 1
            ? allSchemas[0]
            : { anyOf: allSchemas },
    };
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new TupleSchema(this.items, this.restSchema, meta) as this;
  }
}

export class RecordSchema<
  TKey extends BaseSchema<string, string>,
  TValue extends BaseSchema<any, any>,
> extends BaseSchema<
  Record<InferInput<TKey>, InferInput<TValue>>,
  Record<InferOutput<TKey>, InferOutput<TValue>>
> {
  constructor(
    readonly valueSchema: TValue,
    readonly keySchema?: TKey,
    meta?: SchemaMeta,
  ) {
    super(meta);
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<Record<InferOutput<TKey>, InferOutput<TValue>>>
    | Promise<
        StandardSchemaV1Result<Record<InferOutput<TKey>, InferOutput<TValue>>>
      > {
    if (!isPlainRecord(value)) {
      return {
        issues: [{ message: `Expected object, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = [];
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    let asyncEntries: Array<{
      key: string;
      keyPromise?: PromiseLike<StandardSchemaV1Result<string>>;
      valPromise?: PromiseLike<StandardSchemaV1Result<unknown>>;
      syncKey?: string;
      syncVal?: unknown;
    }> | null = null;

    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (FORBIDDEN_KEYS.has(k)) {
        issues.push({ message: `Forbidden property key "${k}"`, path: [k] });
        continue;
      }

      let outKey = k;
      let keyPromise: PromiseLike<StandardSchemaV1Result<string>> | undefined;
      if (this.keySchema) {
        const kRes = this.keySchema._parse(k, options);
        if (isPromiseLike(kRes)) {
          keyPromise = kRes;
        } else if (kRes.issues) {
          issues.push(...prependIssuePath(kRes.issues, k));
          continue;
        } else {
          outKey = kRes.value;
        }
      }

      const vRes = this.valueSchema._parse(value[k], options);
      if (keyPromise || isPromiseLike(vRes)) {
        asyncEntries ??= [];
        asyncEntries.push({
          key: k,
          keyPromise,
          valPromise: isPromiseLike(vRes) ? vRes : undefined,
          syncKey: outKey,
          syncVal: !isPromiseLike(vRes) && !vRes.issues ? vRes.value : undefined,
        });
        if (!isPromiseLike(vRes) && vRes.issues) {
          issues.push(...prependIssuePath(vRes.issues, k));
        }
      } else if (vRes.issues) {
        issues.push(...prependIssuePath(vRes.issues, k));
      } else {
        out[outKey] = vRes.value;
      }
    }

    if (asyncEntries) {
      return Promise.all(
        asyncEntries.map(async (entry) => {
          let finalKey = entry.syncKey ?? entry.key;
          let keyFailed = false;
          if (entry.keyPromise) {
            const kRes = await entry.keyPromise;
            if (kRes.issues) {
              issues.push(...prependIssuePath(kRes.issues, entry.key));
              keyFailed = true;
            } else {
              finalKey = kRes.value;
            }
          }
          if (entry.valPromise) {
            const vRes = await entry.valPromise;
            if (vRes.issues) {
              issues.push(...prependIssuePath(vRes.issues, entry.key));
            } else if (!keyFailed) {
              out[finalKey] = vRes.value;
            }
          } else if (!keyFailed && entry.syncVal !== undefined) {
            out[finalKey] = entry.syncVal;
          }
        }),
      ).then(() =>
        issues.length > 0
          ? { issues }
          : { value: out as Record<InferOutput<TKey>, InferOutput<TValue>> },
      );
    }

    return issues.length > 0
      ? { issues }
      : { value: out as Record<InferOutput<TKey>, InferOutput<TValue>> };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const out: Record<string, unknown> = {
      type: "object",
      additionalProperties: this.valueSchema._toJsonSchema(ctx),
    };
    if (this.keySchema && ctx.target !== "openapi-3.0") {
      out.propertyNames = this.keySchema._toJsonSchema(ctx);
    }
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new RecordSchema(this.valueSchema, this.keySchema, meta) as this;
  }
}

export type ObjectShape = Record<string, BaseSchema<any, any>>;

type OptionalInputKeys<TShape extends ObjectShape> = {
  [K in keyof TShape]: undefined extends InferInput<TShape[K]> ? K : never;
}[keyof TShape];

type RequiredInputKeys<TShape extends ObjectShape> = Exclude<
  keyof TShape,
  OptionalInputKeys<TShape>
>;

type OptionalOutputKeys<TShape extends ObjectShape> = {
  [K in keyof TShape]: undefined extends InferOutput<TShape[K]> ? K : never;
}[keyof TShape];

type RequiredOutputKeys<TShape extends ObjectShape> = Exclude<
  keyof TShape,
  OptionalOutputKeys<TShape>
>;

export type ObjectShapeInput<TShape extends ObjectShape> = Prettify<
  { [K in RequiredInputKeys<TShape>]: InferInput<TShape[K]> } & {
    [K in OptionalInputKeys<TShape>]?: InferInput<TShape[K]>;
  }
>;

export type ObjectShapeOutput<TShape extends ObjectShape> = Prettify<
  { [K in RequiredOutputKeys<TShape>]: InferOutput<TShape[K]> } & {
    [K in OptionalOutputKeys<TShape>]?: InferOutput<TShape[K]>;
  }
>;

export type UnknownKeysPolicy = "strip" | "passthrough" | "strict";

type KeyMask<TShape extends ObjectShape, K extends keyof TShape> =
  | readonly K[]
  | { readonly [P in K]?: true };

function normalizeKeysSelection<TShape extends ObjectShape>(
  shape: TShape,
  keysOrMask: readonly (keyof TShape)[] | Record<string, true | undefined>,
): Set<string> {
  if (Array.isArray(keysOrMask)) {
    return new Set(keysOrMask.map(String));
  }
  const set = new Set<string>();
  for (const [k, enabled] of Object.entries(keysOrMask)) {
    if (enabled === true && Object.prototype.hasOwnProperty.call(shape, k)) {
      set.add(k);
    }
  }
  return set;
}

export class ObjectSchema<TShape extends ObjectShape> extends BaseSchema<
  ObjectShapeInput<TShape>,
  ObjectShapeOutput<TShape>
> {
  private readonly shapeKeys: readonly string[];

  constructor(
    readonly shape: TShape,
    readonly unknownKeys: UnknownKeysPolicy = "strip",
    meta?: SchemaMeta,
  ) {
    super(meta);
    this.shapeKeys = Object.keys(shape);
  }

  partial(): ObjectSchema<{ [K in keyof TShape]: OptionalSchema<TShape[K]> }> {
    const nextShape: Record<string, BaseSchema<any, any>> = {};
    for (const key of this.shapeKeys) {
      const field = this.shape[key]!;
      nextShape[key] =
        field instanceof OptionalSchema ? field : new OptionalSchema(field);
    }
    return new ObjectSchema(
      nextShape as unknown as { [K in keyof TShape]: OptionalSchema<TShape[K]> },
      this.unknownKeys,
      this._meta,
    );
  }

  pick<K extends keyof TShape>(
    keys: readonly K[],
  ): ObjectSchema<Pick<TShape, K>>;
  pick<TMask extends { readonly [P in keyof TShape]?: true }>(
    mask: TMask,
  ): ObjectSchema<Pick<TShape, Extract<keyof TShape, keyof TMask>>>;
  pick(keysOrMask: KeyMask<TShape, keyof TShape>): ObjectSchema<any> {
    const selected = normalizeKeysSelection(
      this.shape,
      keysOrMask as readonly (keyof TShape)[] | Record<string, true | undefined>,
    );
    const nextShape: Record<string, BaseSchema<any, any>> = {};
    for (const key of this.shapeKeys) {
      if (selected.has(key)) {
        nextShape[key] = this.shape[key]!;
      }
    }
    return new ObjectSchema(nextShape, this.unknownKeys, this._meta);
  }

  omit<K extends keyof TShape>(
    keys: readonly K[],
  ): ObjectSchema<Omit<TShape, K>>;
  omit<TMask extends { readonly [P in keyof TShape]?: true }>(
    mask: TMask,
  ): ObjectSchema<Omit<TShape, Extract<keyof TShape, keyof TMask>>>;
  omit(keysOrMask: KeyMask<TShape, keyof TShape>): ObjectSchema<any> {
    const omitted = normalizeKeysSelection(
      this.shape,
      keysOrMask as readonly (keyof TShape)[] | Record<string, true | undefined>,
    );
    const nextShape: Record<string, BaseSchema<any, any>> = {};
    for (const key of this.shapeKeys) {
      if (!omitted.has(key)) {
        nextShape[key] = this.shape[key]!;
      }
    }
    return new ObjectSchema(nextShape, this.unknownKeys, this._meta);
  }

  extend<TExtra extends ObjectShape>(
    extraShape: TExtra,
  ): ObjectSchema<Omit<TShape, keyof TExtra> & TExtra> {
    return new ObjectSchema(
      { ...this.shape, ...extraShape } as Omit<TShape, keyof TExtra> & TExtra,
      this.unknownKeys,
      this._meta,
    );
  }

  passthrough(): ObjectSchema<TShape> {
    return new ObjectSchema(this.shape, "passthrough", this._meta);
  }

  strict(): ObjectSchema<TShape> {
    return new ObjectSchema(this.shape, "strict", this._meta);
  }

  strip(): ObjectSchema<TShape> {
    return new ObjectSchema(this.shape, "strip", this._meta);
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<ObjectShapeOutput<TShape>>
    | Promise<StandardSchemaV1Result<ObjectShapeOutput<TShape>>> {
    if (!isPlainRecord(value)) {
      return {
        issues: [{ message: `Expected object, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = [];
    const out: Record<string, unknown> = {};
    let asyncEntries: Array<{
      key: string;
      promise: PromiseLike<StandardSchemaV1Result<unknown>>;
    }> | null = null;

    // 1. Validate declared shape properties
    for (let i = 0; i < this.shapeKeys.length; i++) {
      const key = this.shapeKeys[i]!;
      const fieldSchema = this.shape[key]!;
      const hasKey = Object.prototype.hasOwnProperty.call(value, key);
      const rawVal = hasKey ? value[key] : undefined;
      const res = fieldSchema._parse(rawVal, options);

      if (isPromiseLike(res)) {
        asyncEntries ??= [];
        asyncEntries.push({ key, promise: res });
      } else if (res.issues) {
        issues.push(...prependIssuePath(res.issues, key));
      } else if (res.value !== undefined || hasKey) {
        if (res.value !== undefined) {
          out[key] = res.value;
        }
      }
    }

    // 2. Handle unknown keys according to policy (strip / passthrough / strict)
    if (this.unknownKeys !== "strip") {
      const inputKeys = Object.keys(value);
      for (let i = 0; i < inputKeys.length; i++) {
        const key = inputKeys[i]!;
        if (Object.prototype.hasOwnProperty.call(this.shape, key)) {
          continue;
        }
        if (FORBIDDEN_KEYS.has(key)) {
          issues.push({
            message: `Forbidden property key "${key}"`,
            path: [key],
          });
          continue;
        }
        if (this.unknownKeys === "strict") {
          issues.push({
            message: `Unrecognized key "${key}"`,
            path: [key],
          });
        } else {
          out[key] = value[key];
        }
      }
    }

    if (asyncEntries) {
      return Promise.all(
        asyncEntries.map((entry) =>
          Promise.resolve(entry.promise).then((res) => ({
            key: entry.key,
            res,
          })),
        ),
      ).then((settled) => {
        for (const item of settled) {
          if (item.res.issues) {
            issues.push(...prependIssuePath(item.res.issues, item.key));
          } else if (item.res.value !== undefined) {
            out[item.key] = item.res.value;
          }
        }
        return issues.length > 0
          ? { issues }
          : { value: out as ObjectShapeOutput<TShape> };
      });
    }

    return issues.length > 0
      ? { issues }
      : { value: out as ObjectShapeOutput<TShape> };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (let i = 0; i < this.shapeKeys.length; i++) {
      const key = this.shapeKeys[i]!;
      const fieldSchema = this.shape[key]!;
      properties[key] = fieldSchema._toJsonSchema(ctx);
      const isOptional =
        ctx.io === "input"
          ? fieldSchema._isOptionalInInput
          : fieldSchema._isOptionalInOutput;
      if (!isOptional) {
        required.push(key);
      }
    }

    const out: Record<string, unknown> = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(this.unknownKeys === "strict"
        ? { additionalProperties: false }
        : this.unknownKeys === "passthrough"
          ? { additionalProperties: true }
          : {}),
    };

    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new ObjectSchema(this.shape, this.unknownKeys, meta) as this;
  }
}

export type UnionOptions = readonly [
  BaseSchema<any, any>,
  BaseSchema<any, any>,
  ...BaseSchema<any, any>[],
];

export class UnionSchema<TOptions extends UnionOptions> extends BaseSchema<
  InferInput<TOptions[number]>,
  InferOutput<TOptions[number]>
> {
  constructor(
    readonly options: TOptions,
    meta?: SchemaMeta,
  ) {
    super(meta);
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<InferOutput<TOptions[number]>>
    | Promise<StandardSchemaV1Result<InferOutput<TOptions[number]>>> {
    let hasAsync = false;
    const syncResults: Array<
      | StandardSchemaV1Result<unknown>
      | PromiseLike<StandardSchemaV1Result<unknown>>
    > = [];

    for (let i = 0; i < this.options.length; i++) {
      const res = this.options[i]!._parse(value, options);
      if (isPromiseLike(res)) {
        hasAsync = true;
        syncResults.push(res);
      } else if (!res.issues) {
        if (!hasAsync) {
          return res as StandardSchemaV1Result<InferOutput<TOptions[number]>>;
        }
        syncResults.push(res);
      } else {
        syncResults.push(res);
      }
    }

    if (hasAsync) {
      return Promise.all(syncResults.map((r) => Promise.resolve(r))).then(
        (resolved) => {
          for (const res of resolved) {
            if (!res.issues) {
              return res as StandardSchemaV1Result<
                InferOutput<TOptions[number]>
              >;
            }
          }
          return {
            issues: [{ message: "Invalid input: did not match any union variant" }],
          };
        },
      );
    }

    return {
      issues: [{ message: "Invalid input: did not match any union variant" }],
    };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const out: Record<string, unknown> = {
      anyOf: this.options.map((opt) => opt._toJsonSchema(ctx)),
    };
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new UnionSchema(this.options, meta) as this;
  }
}

export type DiscriminatedUnionOption<TDiscriminator extends string> =
  BaseSchema<any, any> & {
    readonly shape: Record<TDiscriminator, BaseSchema<any, any>> & ObjectShape;
  };

export class DiscriminatedUnionSchema<
  TDiscriminator extends string,
  TOptions extends readonly [
    DiscriminatedUnionOption<TDiscriminator>,
    ...DiscriminatedUnionOption<TDiscriminator>[],
  ],
> extends BaseSchema<
  InferInput<TOptions[number]>,
  InferOutput<TOptions[number]>
> {
  private readonly optionMap: Map<unknown, DiscriminatedUnionOption<TDiscriminator>>;
  private readonly expectedValues: unknown[];

  constructor(
    readonly discriminator: TDiscriminator,
    readonly options: TOptions,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this.optionMap = new Map();
    this.expectedValues = [];

    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const discField = opt.shape[discriminator];
      if (!discField || !discField._literalValues || discField._literalValues.length === 0) {
        throw new Error(
          `s.discriminatedUnion("${discriminator}"): option at index ${i} must define "${discriminator}" as s.literal(...) or s.enum(...).`,
        );
      }
      for (const lit of discField._literalValues) {
        if (this.optionMap.has(lit)) {
          throw new Error(
            `s.discriminatedUnion("${discriminator}"): duplicate discriminator value ${JSON.stringify(lit)}.`,
          );
        }
        this.optionMap.set(lit, opt);
        this.expectedValues.push(lit);
      }
    }
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<InferOutput<TOptions[number]>>
    | Promise<StandardSchemaV1Result<InferOutput<TOptions[number]>>> {
    if (!isPlainRecord(value)) {
      return {
        issues: [{ message: `Expected object, received ${describeType(value)}` }],
      };
    }

    const discVal = value[this.discriminator];
    const matched = this.optionMap.get(discVal);
    if (!matched) {
      const expected = this.expectedValues
        .map((v) => JSON.stringify(v))
        .join(" | ");
      return {
        issues: [
          {
            message: `Invalid discriminator value. Expected ${expected}, received ${JSON.stringify(discVal)}`,
            path: [this.discriminator],
          },
        ],
      };
    }

    return matched._parse(value, options) as
      | StandardSchemaV1Result<InferOutput<TOptions[number]>>
      | Promise<StandardSchemaV1Result<InferOutput<TOptions[number]>>>;
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const out: Record<string, unknown> = {
      oneOf: this.options.map((opt) => opt._toJsonSchema(ctx)),
      discriminator: { propertyName: this.discriminator },
    };
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new DiscriminatedUnionSchema(
      this.discriminator,
      this.options,
      meta,
    ) as this;
  }
}
