import { isPromiseLike } from "@bunest/core/common";
import type {
  BunestSchema,
  BunestStandardProps,
  JsonSchemaContext,
  RefineOptions,
  SafeParseResult,
  SchemaMeta,
  StandardJsonSchemaOptions,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1Result,
} from "./types";

const JSON_SCHEMA_2020_12_URI =
  "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_DRAFT_07_URI = "http://json-schema.org/draft-07/schema#";

export { isPromiseLike };

export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
}

export function prependIssuePath(
  issues: readonly StandardSchemaV1Issue[],
  segment: PropertyKey,
): StandardSchemaV1Issue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path ? [segment, ...issue.path] : [segment],
  }));
}

export function normalizeTarget(
  options: StandardJsonSchemaOptions,
): "draft-2020-12" | "draft-07" | "openapi-3.0" {
  const target: string | undefined = options?.target;
  if (
    target === "draft-2020-12" ||
    target === "draft-07" ||
    target === "openapi-3.0"
  ) {
    return target;
  }
  throw new Error(
    `Unsupported JSON Schema target "${String(target)}". Supported targets: "draft-2020-12", "draft-07", "openapi-3.0".`,
  );
}

export function applyMetaToJsonSchema(
  schema: Record<string, unknown>,
  meta: SchemaMeta | undefined,
  target: "draft-2020-12" | "draft-07" | "openapi-3.0",
): Record<string, unknown> {
  if (!meta) return schema;
  const out: Record<string, unknown> = { ...schema };
  for (const [key, val] of Object.entries(meta)) {
    if (val === undefined) continue;
    if (key === "id") {
      if (target === "draft-2020-12" || target === "draft-07") {
        out.$id = val;
      }
      continue;
    }
    if (key === "examples") {
      if (target === "openapi-3.0") {
        if (Array.isArray(val) && val.length > 0 && out.example === undefined) {
          out.example = val[0];
        }
      } else {
        out.examples = Array.isArray(val) ? [...val] : val;
      }
      continue;
    }
    if (key === "example") {
      if (target === "openapi-3.0") {
        out.example = val;
      } else {
        out.example = val;
        if (out.examples === undefined) {
          out.examples = [val];
        }
      }
      continue;
    }
    out[key] = val;
  }
  return out;
}

export function makeNullableJsonSchema(
  inner: Record<string, unknown>,
  target: "draft-2020-12" | "draft-07" | "openapi-3.0",
): Record<string, unknown> {
  if (target === "openapi-3.0") {
    const out: Record<string, unknown> = { ...inner, nullable: true };
    if (Array.isArray(out.enum) && !out.enum.includes(null)) {
      out.enum = [...out.enum, null];
    }
    return out;
  }

  // draft-2020-12 / draft-07
  const hasCombinator =
    inner.anyOf !== undefined ||
    inner.oneOf !== undefined ||
    inner.allOf !== undefined ||
    inner.not !== undefined ||
    inner.$ref !== undefined;

  if (!hasCombinator && "const" in inner) {
    if (inner.const === null) {
      return { ...inner };
    }
    const { const: constVal, ...rest } = inner;
    const out: Record<string, unknown> = {
      ...rest,
      enum: [constVal, null],
    };
    if (typeof out.type === "string" && out.type !== "null") {
      out.type = [out.type, "null"];
    }
    return out;
  }

  if (!hasCombinator && Array.isArray(inner.enum)) {
    const out: Record<string, unknown> = {
      ...inner,
      enum: inner.enum.includes(null) ? [...inner.enum] : [...inner.enum, null],
    };
    if (typeof out.type === "string" && out.type !== "null") {
      out.type = [out.type, "null"];
    } else if (Array.isArray(out.type) && !out.type.includes("null")) {
      out.type = [...out.type, "null"];
    }
    return out;
  }

  if (!hasCombinator && typeof inner.type === "string") {
    if (inner.type === "null") {
      return { ...inner };
    }
    return { ...inner, type: [inner.type, "null"] };
  }

  if (!hasCombinator && Array.isArray(inner.type)) {
    return inner.type.includes("null")
      ? { ...inner }
      : { ...inner, type: [...inner.type, "null"] };
  }

  return { anyOf: [inner, { type: "null" }] };
}

export class SchemaValidationError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;

  constructor(issues: ReadonlyArray<StandardSchemaV1Issue>) {
    const summary = issues
      .map((issue) => {
        if (!issue.path || issue.path.length === 0) {
          return issue.message;
        }
        const path = issue.path
          .map((seg) =>
            typeof seg === "object" && seg !== null && "key" in seg
              ? String(seg.key)
              : String(seg),
          )
          .join(".");
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    super(summary || "Schema validation failed");
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

/**
 * Immutable abstract base class for all `@bunest/validation/schema` schemas.
 * Implements BOTH `StandardSchemaV1<Input, Output>` and `StandardJSONSchemaV1<Input, Output>`.
 */
export abstract class BaseSchema<Input = unknown, Output = Input>
  implements BunestSchema<Input, Output>
{
  readonly _meta: SchemaMeta | undefined;
  readonly _isOptionalInInput: boolean = false;
  readonly _isOptionalInOutput: boolean = false;
  readonly _literalValues?: ReadonlyArray<string | number | boolean | null>;

  readonly "~standard": BunestStandardProps<Input, Output>;

  constructor(meta?: SchemaMeta) {
    this._meta = meta;
    this["~standard"] = {
      version: 1,
      vendor: "bunest",
      validate: (value: unknown, options?: StandardSchemaV1Options) =>
        this._parse(value, options),
      jsonSchema: {
        input: (options: StandardJsonSchemaOptions) =>
          this._buildRootJsonSchema(options, "input"),
        output: (options: StandardJsonSchemaOptions) =>
          this._buildRootJsonSchema(options, "output"),
      },
    };
  }

  /**
   * Internal validation execution implemented by subclasses.
   * Returns synchronously when all checks are synchronous, or a Promise if async.
   */
  abstract _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<Output>
    | Promise<StandardSchemaV1Result<Output>>;

  /**
   * Internal JSON Schema node emitter implemented by subclasses.
   */
  abstract _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown>;

  /**
   * Returns a shallow immutable clone with updated metadata.
   */
  protected abstract _cloneWithMeta(meta: SchemaMeta): this;

  private _buildRootJsonSchema(
    options: StandardJsonSchemaOptions,
    io: "input" | "output",
  ): Record<string, unknown> {
    const target = normalizeTarget(options);
    const body = this._toJsonSchema({ target, io });
    if (target === "draft-2020-12") {
      return { $schema: JSON_SCHEMA_2020_12_URI, ...body };
    }
    if (target === "draft-07") {
      return { $schema: JSON_SCHEMA_DRAFT_07_URI, ...body };
    }
    return body;
  }

  /**
   * Convenience JSON Schema generator defaulting to JSON Schema 2020-12 input schema.
   */
  toJsonSchema(
    options: StandardJsonSchemaOptions = { target: "draft-2020-12" },
    io: "input" | "output" = "input",
  ): Record<string, unknown> {
    return this._buildRootJsonSchema(options, io);
  }

  /**
   * Synchronous or async parse that throws `SchemaValidationError` on failure.
   */
  parse(value: unknown): Output {
    const res = this._parse(value);
    if (isPromiseLike(res)) {
      throw new Error(
        "Async schema detected in synchronous parse(). Use parseAsync() or `~standard.validate()` instead.",
      );
    }
    if (res.issues) {
      throw new SchemaValidationError(res.issues);
    }
    return res.value;
  }

  /**
   * Async parse that throws `SchemaValidationError` on failure.
   */
  async parseAsync(value: unknown): Promise<Output> {
    const res = await this._parse(value);
    if (res.issues) {
      throw new SchemaValidationError(res.issues);
    }
    return res.value;
  }

  /**
   * Synchronous safe parse returning `{ success, data }` or `{ success: false, issues }`.
   */
  safeParse(value: unknown): SafeParseResult<Output> {
    const res = this._parse(value);
    if (isPromiseLike(res)) {
      throw new Error(
        "Async schema detected in synchronous safeParse(). Use safeParseAsync() or `~standard.validate()` instead.",
      );
    }
    if (res.issues) {
      return { success: false, issues: res.issues };
    }
    return { success: true, data: res.value };
  }

  /**
   * Async safe parse returning `{ success, data }` or `{ success: false, issues }`.
   */
  async safeParseAsync(value: unknown): Promise<SafeParseResult<Output>> {
    const res = await this._parse(value);
    if (res.issues) {
      return { success: false, issues: res.issues };
    }
    return { success: true, data: res.value };
  }

  describe(description: string): this {
    return this._cloneWithMeta({ ...(this._meta ?? {}), description });
  }

  meta(metadata: SchemaMeta): this {
    return this._cloneWithMeta({ ...(this._meta ?? {}), ...metadata });
  }

  optional(): OptionalSchema<BaseSchema<Input, Output>> {
    return new OptionalSchema<BaseSchema<Input, Output>>(this);
  }

  nullable(): NullableSchema<BaseSchema<Input, Output>> {
    return new NullableSchema<BaseSchema<Input, Output>>(this);
  }

  default(
    defaultValue: Output | (() => Output),
  ): DefaultSchema<BaseSchema<Input, Output>, Output> {
    return new DefaultSchema<BaseSchema<Input, Output>, Output>(
      this,
      defaultValue,
    );
  }

  refine(
    check: (value: Output) => boolean | Promise<boolean>,
    messageOrOptions?: RefineOptions,
  ): RefinedSchema<Input, Output> {
    return new RefinedSchema(this, check, messageOrOptions);
  }

  transform<NewOutput>(
    fn: (value: Output) => NewOutput | Promise<NewOutput>,
  ): TransformedSchema<Input, Output, NewOutput> {
    return new TransformedSchema(this, fn);
  }
}

export class OptionalSchema<
  TInner extends BaseSchema<any, any>,
> extends BaseSchema<
  NonNullable<TInner["~standard"]["types"]>["input"] | undefined,
  NonNullable<TInner["~standard"]["types"]>["output"] | undefined
> {
  override readonly _isOptionalInInput = true;
  override readonly _isOptionalInOutput = true;

  constructor(
    readonly inner: TInner,
    meta?: SchemaMeta,
  ) {
    super(meta);
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<
        NonNullable<TInner["~standard"]["types"]>["output"] | undefined
      >
    | Promise<
        StandardSchemaV1Result<
          NonNullable<TInner["~standard"]["types"]>["output"] | undefined
        >
      > {
    if (value === undefined) {
      return { value: undefined };
    }
    return this.inner._parse(value, options);
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    return applyMetaToJsonSchema(
      this.inner._toJsonSchema(ctx),
      this._meta,
      ctx.target,
    );
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new OptionalSchema(this.inner, meta) as this;
  }
}

export class NullableSchema<
  TInner extends BaseSchema<any, any>,
> extends BaseSchema<
  NonNullable<TInner["~standard"]["types"]>["input"] | null,
  NonNullable<TInner["~standard"]["types"]>["output"] | null
> {
  override readonly _isOptionalInInput: boolean;
  override readonly _isOptionalInOutput: boolean;

  constructor(
    readonly inner: TInner,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this._isOptionalInInput = inner._isOptionalInInput;
    this._isOptionalInOutput = inner._isOptionalInOutput;
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<
        NonNullable<TInner["~standard"]["types"]>["output"] | null
      >
    | Promise<
        StandardSchemaV1Result<
          NonNullable<TInner["~standard"]["types"]>["output"] | null
        >
      > {
    if (value === null) {
      return { value: null };
    }
    return this.inner._parse(value, options);
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const innerJson = this.inner._toJsonSchema(ctx);
    const nullableJson = makeNullableJsonSchema(innerJson, ctx.target);
    return applyMetaToJsonSchema(nullableJson, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new NullableSchema(this.inner, meta) as this;
  }
}

export class DefaultSchema<
  TInner extends BaseSchema<any, any>,
  TOutput = NonNullable<TInner["~standard"]["types"]>["output"],
> extends BaseSchema<
  NonNullable<TInner["~standard"]["types"]>["input"] | undefined,
  TOutput
> {
  override readonly _isOptionalInInput = true;
  override readonly _isOptionalInOutput = false;

  constructor(
    readonly inner: TInner,
    readonly defaultValue: TOutput | (() => TOutput),
    meta?: SchemaMeta,
  ) {
    super(meta);
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<TOutput>
    | Promise<StandardSchemaV1Result<TOutput>> {
    if (value === undefined) {
      const resolved =
        typeof this.defaultValue === "function"
          ? (this.defaultValue as () => TOutput)()
          : this.defaultValue;
      return { value: resolved };
    }
    return this.inner._parse(value, options) as
      | StandardSchemaV1Result<TOutput>
      | Promise<StandardSchemaV1Result<TOutput>>;
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const innerJson = this.inner._toJsonSchema(ctx);
    const withDefault: Record<string, unknown> =
      typeof this.defaultValue === "function"
        ? { ...innerJson }
        : { ...innerJson, default: this.defaultValue };
    return applyMetaToJsonSchema(withDefault, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new DefaultSchema(this.inner, this.defaultValue, meta) as this;
  }
}

export class RefinedSchema<Input, Output> extends BaseSchema<Input, Output> {
  override readonly _isOptionalInInput: boolean;
  override readonly _isOptionalInOutput: boolean;
  private readonly message: string;
  private readonly issuePath: ReadonlyArray<PropertyKey> | undefined;

  constructor(
    readonly inner: BaseSchema<Input, Output>,
    private readonly predicate: (value: Output) => boolean | Promise<boolean>,
    messageOrOptions?: RefineOptions,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this._isOptionalInInput = inner._isOptionalInInput;
    this._isOptionalInOutput = inner._isOptionalInOutput;
    if (typeof messageOrOptions === "string") {
      this.message = messageOrOptions;
      this.issuePath = undefined;
    } else {
      this.message = messageOrOptions?.message ?? "Invalid value";
      this.issuePath = messageOrOptions?.path;
    }
  }

  private _buildFailure(): StandardSchemaV1Result<Output> {
    return {
      issues: [
        {
          message: this.message,
          ...(this.issuePath ? { path: [...this.issuePath] } : {}),
        },
      ],
    };
  }

  private _checkValue(
    val: Output,
  ):
    | StandardSchemaV1Result<Output>
    | Promise<StandardSchemaV1Result<Output>> {
    const ok = this.predicate(val);
    if (isPromiseLike(ok)) {
      return Promise.resolve(ok).then((passed) =>
        passed ? { value: val } : this._buildFailure(),
      );
    }
    return ok ? { value: val } : this._buildFailure();
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<Output>
    | Promise<StandardSchemaV1Result<Output>> {
    const innerResult = this.inner._parse(value, options);
    if (isPromiseLike(innerResult)) {
      return Promise.resolve(innerResult).then((res) => {
        if (res.issues) return res;
        return this._checkValue(res.value);
      });
    }
    if (innerResult.issues) {
      return innerResult;
    }
    return this._checkValue(innerResult.value);
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    return applyMetaToJsonSchema(
      this.inner._toJsonSchema(ctx),
      this._meta,
      ctx.target,
    );
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new RefinedSchema(
      this.inner,
      this.predicate,
      { message: this.message, path: this.issuePath },
      meta,
    ) as this;
  }
}

export class TransformedSchema<
  Input,
  Intermediate,
  Output,
> extends BaseSchema<Input, Output> {
  override readonly _isOptionalInInput: boolean;
  override readonly _isOptionalInOutput = false;

  constructor(
    readonly inner: BaseSchema<Input, Intermediate>,
    private readonly transformer: (
      value: Intermediate,
    ) => Output | Promise<Output>,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this._isOptionalInInput = inner._isOptionalInInput;
  }

  private _applyTransform(
    val: Intermediate,
  ):
    | StandardSchemaV1Result<Output>
    | Promise<StandardSchemaV1Result<Output>> {
    try {
      const out = this.transformer(val);
      if (isPromiseLike(out)) {
        return Promise.resolve(out).then(
          (resolved) => ({ value: resolved }),
          (err) => ({
            issues: [
              {
                message:
                  err instanceof Error ? err.message : "Transform failed",
              },
            ],
          }),
        );
      }
      return { value: out };
    } catch (err) {
      return {
        issues: [
          {
            message: err instanceof Error ? err.message : "Transform failed",
          },
        ],
      };
    }
  }

  _parse(
    value: unknown,
    options?: StandardSchemaV1Options,
  ):
    | StandardSchemaV1Result<Output>
    | Promise<StandardSchemaV1Result<Output>> {
    const innerResult = this.inner._parse(value, options);
    if (isPromiseLike(innerResult)) {
      return Promise.resolve(innerResult).then((res) => {
        if (res.issues) return res;
        return this._applyTransform(res.value);
      });
    }
    if (innerResult.issues) {
      return innerResult;
    }
    return this._applyTransform(innerResult.value);
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    return applyMetaToJsonSchema(
      this.inner._toJsonSchema(ctx),
      this._meta,
      ctx.target,
    );
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new TransformedSchema(this.inner, this.transformer, meta) as this;
  }
}
