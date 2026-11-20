import {
  HttpException,
  MetadataRegistry,
  isStandardSchema,
  type StandardSchemaV1,
  type Type,
} from "@bunest/common";
import {
  ValidationPipe,
  formatStandardSchemaIssues,
  type ValidationPipeOptions,
} from "@bunest/validation";
import { getMetadataStorage } from "class-validator";
import {
  ConfigValidationError,
  type ConfigValidatorFn,
} from "./interfaces/config.interface";

const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "off"]);

function isClassConstructor(fn: Function): fn is Type<object> {
  const source = Function.prototype.toString.call(fn).trimStart();
  if (source.startsWith("class ") || source.startsWith("class{")) {
    return true;
  }
  try {
    return (
      getMetadataStorage().getTargetValidationMetadatas(fn, "", false, false)
        .length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Coerces string environment variables to expected primitive types declared on the DTO
 * (`Boolean`, `Number`, `Date`) strictly — avoiding JavaScript's `Boolean("false") === true`
 * and `Number("") === 0` footguns in `class-transformer`'s `enableImplicitConversion`.
 */
function coerceEnvStringsForDto(
  rawConfig: Record<string, unknown>,
  dtoClass: Type<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...rawConfig };
  const booleanProps = new Set<string>();
  const numberProps = new Set<string>();
  const dateProps = new Set<string>();

  try {
    const metas = getMetadataStorage().getTargetValidationMetadatas(
      dtoClass,
      "",
      false,
      false,
    );
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (!meta || !meta.propertyName) continue;
      const prop = meta.propertyName;
      const ruleName = (meta.name ?? meta.type ?? "").toLowerCase();

      if (ruleName === "isboolean") {
        booleanProps.add(prop);
      } else if (
        ruleName === "isint" ||
        ruleName === "isnumber" ||
        ruleName === "ispositive" ||
        ruleName === "isnegative" ||
        ruleName === "min" ||
        ruleName === "max"
      ) {
        numberProps.add(prop);
      } else if (ruleName === "isdate") {
        dateProps.add(prop);
      }

      const designType = MetadataRegistry.getType(dtoClass.prototype, prop);
      if (designType === Boolean) {
        booleanProps.add(prop);
      } else if (designType === Number) {
        numberProps.add(prop);
      } else if (designType === Date) {
        dateProps.add(prop);
      }
    }
  } catch {
    // Fallback if metadata storage unavailable
  }

  for (const key of Object.keys(result)) {
    const raw = result[key];
    if (typeof raw !== "string") {
      continue;
    }

    const designType = MetadataRegistry.getType(dtoClass.prototype, key);

    if (booleanProps.has(key) || designType === Boolean) {
      const normalized = raw.trim().toLowerCase();
      if (TRUE_BOOLEAN_STRINGS.has(normalized)) {
        result[key] = true;
      } else if (FALSE_BOOLEAN_STRINGS.has(normalized)) {
        result[key] = false;
      }
      // Leave unrecognized boolean strings (e.g. "maybe", "") untouched so @IsBoolean() rejects them!
      continue;
    }

    if (numberProps.has(key) || designType === Number) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          result[key] = parsed;
        }
      }
      // Leave empty or non-numeric strings untouched so @IsInt() / @IsNumber() rejects them!
      continue;
    }

    if (dateProps.has(key) || designType === Date) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
          result[key] = parsed;
        }
      }
    }
  }

  return result;
}

function formatHttpValidationFailure(
  err: HttpException,
  dtoName: string,
): ConfigValidationError {
  const json = err.toJSON();
  const details = Array.isArray(json.details) ? json.details : undefined;

  if (details && details.length > 0) {
    const lines = details.map((d: { field?: string; messages?: string[] }) => {
      const field = d.field ?? "<root>";
      const msgs = Array.isArray(d.messages) ? d.messages.join(", ") : "";
      return `  - ${field}: ${msgs}`;
    });
    return new ConfigValidationError(
      `Configuration validation failed for ${dtoName}:\n${lines.join("\n")}`,
      { details, cause: err },
    );
  }

  const msg = Array.isArray(json.message)
    ? json.message.join("; ")
    : String(json.message);
  return new ConfigValidationError(
    `Configuration validation failed for ${dtoName}: ${msg}`,
    { cause: err },
  );
}

/**
 * Validates raw environment configuration using either a DTO class
 * (`ValidationPipe` with `class-validator` + `class-transformer`) or
 * a custom `validate(config)` callback. Throws `ConfigValidationError` on failure.
 */
export async function validateConfiguration<T extends object>(
  rawConfig: Record<string, unknown>,
  options: {
    validate?: ConfigValidatorFn<T> | Type<T>;
    validationClass?: Type<T>;
    validationSchema?: StandardSchemaV1<Record<string, unknown>, T>;
    validationOptions?: ValidationPipeOptions;
    skipProcessEnv?: boolean;
    fileValues?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const baseForMerge = options.skipProcessEnv
    ? (options.fileValues ?? {})
    : rawConfig;

  if (options.validationSchema && isStandardSchema(options.validationSchema)) {
    const result = await options.validationSchema["~standard"].validate({
      ...rawConfig,
    });
    if (result.issues) {
      const details = formatStandardSchemaIssues(result.issues, "<env>");
      const lines = details.map(
        (d) => `  - ${d.field}: ${d.messages.join(", ")}`,
      );
      throw new ConfigValidationError(
        `Configuration Standard Schema validation failed:\n${lines.join("\n")}`,
        { details },
      );
    }
    if (result.value && typeof result.value === "object") {
      return { ...baseForMerge, ...(result.value as Record<string, unknown>) };
    }
    return baseForMerge;
  }

  const dtoClass =
    options.validationClass ??
    (options.validate && isClassConstructor(options.validate)
      ? options.validate
      : undefined);

  if (dtoClass) {
    const coercedInput = coerceEnvStringsForDto(rawConfig, dtoClass);
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: false,
      forbidNonWhitelisted: false,
      ...options.validationOptions,
      transformOptions: {
        enableImplicitConversion: false,
        ...options.validationOptions?.transformOptions,
      },
    });

    try {
      const validated = await pipe.transform(coercedInput, {
        type: "body",
        metatype: dtoClass,
      });

      if (validated && typeof validated === "object") {
        // Merge validated/coerced DTO properties over base config so both coerced DTO keys
        // and any additional env vars remain accessible unless whitelist stripped them.
        const keepRaw = options.validationOptions?.whitelist !== true;
        return keepRaw
          ? { ...baseForMerge, ...(validated as Record<string, unknown>) }
          : { ...(validated as Record<string, unknown>) };
      }
      return baseForMerge;
    } catch (err) {
      if (err instanceof HttpException) {
        throw formatHttpValidationFailure(err, dtoClass.name || "ConfigDto");
      }
      throw new ConfigValidationError(
        `Configuration validation failed for ${dtoClass.name || "ConfigDto"}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  if (typeof options.validate === "function") {
    const fn = options.validate as ConfigValidatorFn<T>;
    try {
      const result = await fn({ ...rawConfig });
      if (result && typeof result === "object") {
        return { ...(result as Record<string, unknown>) };
      }
      return baseForMerge;
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        throw err;
      }
      throw new ConfigValidationError(
        `Configuration validation failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return baseForMerge;
}
