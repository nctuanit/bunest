import {
  BaseSchema,
  applyMetaToJsonSchema,
  describeType,
} from "./base";
import type {
  JsonSchemaContext,
  SchemaMeta,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./types";

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUrlString(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 0 && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isMultipleOfFloat(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step === 0) {
    return false;
  }
  if (Number.isInteger(value) && Number.isInteger(step)) {
    return value % step === 0;
  }
  // Scale by decimal places so e.g. 0.3 % 0.1 === 0 without IEEE-754 drift
  const stepStr = String(Math.abs(step));
  const valStr = String(Math.abs(value));
  const stepDec = stepStr.includes(".") ? stepStr.length - stepStr.indexOf(".") - 1 : 0;
  const valDec = valStr.includes(".") ? valStr.length - valStr.indexOf(".") - 1 : 0;
  const maxDec = Math.max(stepDec, valDec);
  if (maxDec <= 10) {
    const scale = 10 ** maxDec;
    return Math.round(value * scale) % Math.round(step * scale) === 0;
  }
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

type StringStep =
  | { readonly kind: "trim" }
  | { readonly kind: "min"; readonly value: number; readonly message?: string }
  | { readonly kind: "max"; readonly value: number; readonly message?: string }
  | {
      readonly kind: "length";
      readonly value: number;
      readonly message?: string;
    }
  | { readonly kind: "email"; readonly message?: string }
  | { readonly kind: "url"; readonly message?: string }
  | { readonly kind: "uuid"; readonly message?: string }
  | {
      readonly kind: "regex";
      readonly pattern: RegExp;
      readonly message?: string;
    };

export class StringSchema extends BaseSchema<string, string> {
  private readonly steps: readonly StringStep[];
  private readonly coerce: boolean;

  constructor(
    steps: readonly StringStep[] = [],
    coerce = false,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this.steps = steps;
    this.coerce = coerce;
  }

  private _addStep(step: StringStep): StringSchema {
    return new StringSchema([...this.steps, step], this.coerce, this._meta);
  }

  min(length: number, message?: string): StringSchema {
    return this._addStep({ kind: "min", value: length, message });
  }

  max(length: number, message?: string): StringSchema {
    return this._addStep({ kind: "max", value: length, message });
  }

  length(length: number, message?: string): StringSchema {
    return this._addStep({ kind: "length", value: length, message });
  }

  nonempty(message?: string): StringSchema {
    return this._addStep({
      kind: "min",
      value: 1,
      message: message ?? "String must not be empty",
    });
  }

  email(message?: string): StringSchema {
    return this._addStep({ kind: "email", message });
  }

  url(message?: string): StringSchema {
    return this._addStep({ kind: "url", message });
  }

  uuid(message?: string): StringSchema {
    return this._addStep({ kind: "uuid", message });
  }

  regex(pattern: RegExp, message?: string): StringSchema {
    const safePattern =
      pattern.global || pattern.sticky
        ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
        : pattern;
    return this._addStep({ kind: "regex", pattern: safePattern, message });
  }

  trim(): StringSchema {
    return this._addStep({ kind: "trim" });
  }

  _parse(value: unknown): StandardSchemaV1Result<string> {
    let str: string;
    if (typeof value === "string") {
      str = value;
    } else if (
      this.coerce &&
      value !== null &&
      value !== undefined &&
      (typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint")
    ) {
      str = String(value);
    } else {
      return {
        issues: [{ message: `Expected string, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = [];
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      switch (step.kind) {
        case "trim":
          str = str.trim();
          break;
        case "min":
          if (str.length < step.value) {
            issues.push({
              message:
                step.message ??
                `String must contain at least ${step.value} character(s)`,
            });
          }
          break;
        case "max":
          if (str.length > step.value) {
            issues.push({
              message:
                step.message ??
                `String must contain at most ${step.value} character(s)`,
            });
          }
          break;
        case "length":
          if (str.length !== step.value) {
            issues.push({
              message:
                step.message ??
                `String must contain exactly ${step.value} character(s)`,
            });
          }
          break;
        case "email":
          if (str.length > 254 || !EMAIL_RE.test(str)) {
            issues.push({ message: step.message ?? "Invalid email address" });
          }
          break;
        case "url":
          if (!isValidUrlString(str)) {
            issues.push({ message: step.message ?? "Invalid URL" });
          }
          break;
        case "uuid":
          if (str.length !== 36 || !UUID_RE.test(str)) {
            issues.push({ message: step.message ?? "Invalid UUID" });
          }
          break;
        case "regex":
          if (!step.pattern.test(str)) {
            issues.push({
              message:
                step.message ??
                `String does not match pattern ${step.pattern.source}`,
            });
          }
          break;
      }
    }

    if (issues.length > 0) {
      return { issues };
    }
    return { value: str };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const out: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      switch (step.kind) {
        case "min":
          out.minLength =
            typeof out.minLength === "number"
              ? Math.max(out.minLength, step.value)
              : step.value;
          break;
        case "max":
          out.maxLength =
            typeof out.maxLength === "number"
              ? Math.min(out.maxLength, step.value)
              : step.value;
          break;
        case "length":
          out.minLength =
            typeof out.minLength === "number"
              ? Math.max(out.minLength, step.value)
              : step.value;
          out.maxLength =
            typeof out.maxLength === "number"
              ? Math.min(out.maxLength, step.value)
              : step.value;
          break;
        case "email":
          out.format = "email";
          break;
        case "url":
          out.format = "uri";
          break;
        case "uuid":
          out.format = "uuid";
          break;
        case "regex":
          out.pattern = step.pattern.source;
          break;
        case "trim":
          break;
      }
    }
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new StringSchema(this.steps, this.coerce, meta) as this;
  }
}

type NumberCheck =
  | { readonly kind: "min"; readonly value: number; readonly message?: string }
  | { readonly kind: "max"; readonly value: number; readonly message?: string }
  | { readonly kind: "int"; readonly message?: string }
  | { readonly kind: "positive"; readonly message?: string }
  | { readonly kind: "negative"; readonly message?: string }
  | { readonly kind: "finite"; readonly message?: string }
  | {
      readonly kind: "multipleOf";
      readonly value: number;
      readonly message?: string;
    };

export class NumberSchema extends BaseSchema<number, number> {
  private readonly checks: readonly NumberCheck[];
  private readonly coerce: boolean;

  constructor(
    checks: readonly NumberCheck[] = [],
    coerce = false,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this.checks = checks;
    this.coerce = coerce;
  }

  private _addCheck(check: NumberCheck): NumberSchema {
    return new NumberSchema([...this.checks, check], this.coerce, this._meta);
  }

  min(value: number, message?: string): NumberSchema {
    return this._addCheck({ kind: "min", value, message });
  }

  max(value: number, message?: string): NumberSchema {
    return this._addCheck({ kind: "max", value, message });
  }

  int(message?: string): NumberSchema {
    return this._addCheck({ kind: "int", message });
  }

  positive(message?: string): NumberSchema {
    return this._addCheck({ kind: "positive", message });
  }

  negative(message?: string): NumberSchema {
    return this._addCheck({ kind: "negative", message });
  }

  finite(message?: string): NumberSchema {
    return this._addCheck({ kind: "finite", message });
  }

  multipleOf(step: number, message?: string): NumberSchema {
    return this._addCheck({ kind: "multipleOf", value: step, message });
  }

  _parse(value: unknown): StandardSchemaV1Result<number> {
    let num: number;
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        return { issues: [{ message: "Expected number, received NaN" }] };
      }
      num = value;
    } else if (this.coerce) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          return {
            issues: [{ message: "Expected numeric value, received empty string" }],
          };
        }
        const parsed = Number(trimmed);
        if (Number.isNaN(parsed)) {
          return {
            issues: [{ message: `Cannot coerce "${value}" to number` }],
          };
        }
        num = parsed;
      } else if (typeof value === "boolean") {
        num = value ? 1 : 0;
      } else {
        return {
          issues: [{ message: `Expected number, received ${describeType(value)}` }],
        };
      }
    } else {
      return {
        issues: [{ message: `Expected number, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = [];
    for (let i = 0; i < this.checks.length; i++) {
      const check = this.checks[i]!;
      switch (check.kind) {
        case "min":
          if (num < check.value) {
            issues.push({
              message:
                check.message ??
                `Number must be greater than or equal to ${check.value}`,
            });
          }
          break;
        case "max":
          if (num > check.value) {
            issues.push({
              message:
                check.message ??
                `Number must be less than or equal to ${check.value}`,
            });
          }
          break;
        case "int":
          if (!Number.isInteger(num)) {
            issues.push({ message: check.message ?? "Expected integer" });
          }
          break;
        case "positive":
          if (!(num > 0)) {
            issues.push({
              message: check.message ?? "Number must be greater than 0",
            });
          }
          break;
        case "negative":
          if (!(num < 0)) {
            issues.push({
              message: check.message ?? "Number must be less than 0",
            });
          }
          break;
        case "finite":
          if (!Number.isFinite(num)) {
            issues.push({
              message: check.message ?? "Number must be finite",
            });
          }
          break;
        case "multipleOf":
          if (!isMultipleOfFloat(num, check.value)) {
            issues.push({
              message:
                check.message ?? `Number must be a multiple of ${check.value}`,
            });
          }
          break;
      }
    }

    if (issues.length > 0) {
      return { issues };
    }
    return { value: num };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const isInt = this.checks.some((c) => c.kind === "int");
    const out: Record<string, unknown> = {
      type: isInt ? "integer" : "number",
    };

    for (let i = 0; i < this.checks.length; i++) {
      const check = this.checks[i]!;
      switch (check.kind) {
        case "min":
          out.minimum =
            typeof out.minimum === "number"
              ? Math.max(out.minimum, check.value)
              : check.value;
          break;
        case "max":
          out.maximum =
            typeof out.maximum === "number"
              ? Math.min(out.maximum, check.value)
              : check.value;
          break;
        case "positive":
          if (ctx.target === "openapi-3.0") {
            if (typeof out.minimum !== "number" || out.minimum <= 0) {
              out.minimum = 0;
              out.exclusiveMinimum = true;
            }
          } else {
            out.exclusiveMinimum =
              typeof out.exclusiveMinimum === "number"
                ? Math.max(out.exclusiveMinimum, 0)
                : 0;
          }
          break;
        case "negative":
          if (ctx.target === "openapi-3.0") {
            if (typeof out.maximum !== "number" || out.maximum >= 0) {
              out.maximum = 0;
              out.exclusiveMaximum = true;
            }
          } else {
            out.exclusiveMaximum =
              typeof out.exclusiveMaximum === "number"
                ? Math.min(out.exclusiveMaximum, 0)
                : 0;
          }
          break;
        case "multipleOf":
          if (check.value !== 0) {
            out.multipleOf = Math.abs(check.value);
          }
          break;
        case "int":
        case "finite":
          break;
      }
    }

    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new NumberSchema(this.checks, this.coerce, meta) as this;
  }
}

export class BooleanSchema extends BaseSchema<boolean, boolean> {
  private readonly coerce: boolean;

  constructor(coerce = false, meta?: SchemaMeta) {
    super(meta);
    this.coerce = coerce;
  }

  _parse(value: unknown): StandardSchemaV1Result<boolean> {
    if (typeof value === "boolean") {
      return { value };
    }
    if (this.coerce) {
      if (typeof value === "string") {
        const norm = value.trim().toLowerCase();
        if (norm === "true" || norm === "1" || norm === "yes" || norm === "on") {
          return { value: true };
        }
        if (norm === "false" || norm === "0" || norm === "no" || norm === "off") {
          return { value: false };
        }
        return {
          issues: [{ message: `Cannot coerce "${value}" to boolean` }],
        };
      }
      if (value === 1) return { value: true };
      if (value === 0) return { value: false };
    }
    return {
      issues: [{ message: `Expected boolean, received ${describeType(value)}` }],
    };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    return applyMetaToJsonSchema({ type: "boolean" }, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new BooleanSchema(this.coerce, meta) as this;
  }
}

type DateCheck =
  | { readonly kind: "min"; readonly value: Date; readonly message?: string }
  | { readonly kind: "max"; readonly value: Date; readonly message?: string };

export class DateSchema extends BaseSchema<Date, Date> {
  private readonly checks: readonly DateCheck[];
  private readonly coerce: boolean;

  constructor(
    checks: readonly DateCheck[] = [],
    coerce = false,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this.checks = checks;
    this.coerce = coerce;
  }

  min(date: Date, message?: string): DateSchema {
    return new DateSchema(
      [...this.checks, { kind: "min", value: date, message }],
      this.coerce,
      this._meta,
    );
  }

  max(date: Date, message?: string): DateSchema {
    return new DateSchema(
      [...this.checks, { kind: "max", value: date, message }],
      this.coerce,
      this._meta,
    );
  }

  _parse(value: unknown): StandardSchemaV1Result<Date> {
    let date: Date;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        return { issues: [{ message: "Invalid Date" }] };
      }
      date = value;
    } else if (this.coerce) {
      if (
        (typeof value === "string" && value.trim().length > 0) ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          return { issues: [{ message: "Invalid Date" }] };
        }
        date = parsed;
      } else {
        return {
          issues: [{ message: `Expected Date, received ${describeType(value)}` }],
        };
      }
    } else {
      return {
        issues: [{ message: `Expected Date, received ${describeType(value)}` }],
      };
    }

    const issues: StandardSchemaV1Issue[] = [];
    const ts = date.getTime();
    for (let i = 0; i < this.checks.length; i++) {
      const check = this.checks[i]!;
      if (check.kind === "min" && ts < check.value.getTime()) {
        issues.push({
          message:
            check.message ??
            `Date must be on or after ${check.value.toISOString()}`,
        });
      } else if (check.kind === "max" && ts > check.value.getTime()) {
        issues.push({
          message:
            check.message ??
            `Date must be on or before ${check.value.toISOString()}`,
        });
      }
    }

    if (issues.length > 0) {
      return { issues };
    }
    return { value: date };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    return applyMetaToJsonSchema(
      { type: "string", format: "date-time" },
      this._meta,
      ctx.target,
    );
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new DateSchema(this.checks, this.coerce, meta) as this;
  }
}

export type LiteralPrimitive = string | number | boolean | null;

export class LiteralSchema<T extends LiteralPrimitive> extends BaseSchema<T, T> {
  override readonly _literalValues: readonly [T];

  constructor(
    readonly literalValue: T,
    meta?: SchemaMeta,
  ) {
    super(meta);
    this._literalValues = [literalValue];
  }

  _parse(value: unknown): StandardSchemaV1Result<T> {
    if (value === this.literalValue) {
      return { value: value as T };
    }
    return {
      issues: [
        {
          message: `Expected literal ${JSON.stringify(this.literalValue)}, received ${JSON.stringify(value)}`,
        },
      ],
    };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const val = this.literalValue;
    if (ctx.target === "openapi-3.0") {
      if (val === null) {
        return applyMetaToJsonSchema(
          { nullable: true, enum: [null] },
          this._meta,
          ctx.target,
        );
      }
      const type = Number.isInteger(val) ? "integer" : typeof val;
      return applyMetaToJsonSchema(
        { type, enum: [val] },
        this._meta,
        ctx.target,
      );
    }

    if (val === null) {
      return applyMetaToJsonSchema(
        { type: "null", const: null },
        this._meta,
        ctx.target,
      );
    }
    return applyMetaToJsonSchema({ const: val }, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new LiteralSchema(this.literalValue, meta) as this;
  }
}

export type EnumLikeObject = Record<string, string | number>;

export function extractEnumValues(
  input: readonly (string | number)[] | EnumLikeObject,
): Array<string | number> {
  if (Array.isArray(input)) {
    return [...input];
  }
  const values: Array<string | number> = [];
  const record = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    // Skip TypeScript numeric enum reverse-mapping entries (`Enum[Enum.A] = "A"`)
    if (typeof record[String(v)] === "number" && !Number.isNaN(Number(k))) {
      continue;
    }
    if (typeof v === "string" || typeof v === "number") {
      values.push(v);
    }
  }
  return values;
}

export class EnumSchema<T extends string | number> extends BaseSchema<T, T> {
  override readonly _literalValues: readonly T[];
  private readonly valueSet: ReadonlySet<unknown>;

  constructor(
    readonly values: readonly T[],
    meta?: SchemaMeta,
  ) {
    super(meta);
    this._literalValues = [...values];
    this.valueSet = new Set<unknown>(values);
  }

  _parse(value: unknown): StandardSchemaV1Result<T> {
    if (this.valueSet.has(value)) {
      return { value: value as T };
    }
    const allowed = this.values.map((v) => JSON.stringify(v)).join(" | ");
    return {
      issues: [
        {
          message: `Invalid enum value. Expected ${allowed}, received ${JSON.stringify(value)}`,
        },
      ],
    };
  }

  _toJsonSchema(ctx: JsonSchemaContext): Record<string, unknown> {
    const out: Record<string, unknown> = { enum: [...this.values] };
    if (this.values.length > 0) {
      if (this.values.every((v) => typeof v === "string")) {
        out.type = "string";
      } else if (this.values.every((v) => typeof v === "number")) {
        out.type = this.values.every((v) => Number.isInteger(v))
          ? "integer"
          : "number";
      }
    }
    return applyMetaToJsonSchema(out, this._meta, ctx.target);
  }

  protected _cloneWithMeta(meta: SchemaMeta): this {
    return new EnumSchema(this.values, meta) as this;
  }
}
