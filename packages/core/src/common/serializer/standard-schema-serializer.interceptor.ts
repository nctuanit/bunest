import { Inject, Injectable, Optional } from "../decorators/core.decorators";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { HttpStatus } from "../enums/scope.enum";
import { StreamableFile } from "../http/streamable-file";
import type { PlainLiteralObject } from "../interfaces/http.interface";
import type {
  BunestInterceptor,
  CallHandler,
  ExecutionContext,
} from "../interfaces/pipeline.interface";
import {
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Options,
} from "../interfaces/standard-schema.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";
import { Reflector } from "../metadata/reflector";
import { formatStandardSchemaIssues } from "../pipes/standard-schema-validation.pipe";
import { createValidationHttpException } from "../pipes/validation-http.util";
import {
  CLASS_SERIALIZER_OPTIONS,
  type StandardSchemaSerializerContextOptions,
  type StandardSchemaSerializerOptions,
} from "./serialize-options.decorator";

export const STANDARD_SCHEMA_SERIALIZER_METADATA = Symbol.for(
  "bunest:validation:standard_schema_serializer",
);

export type {
  StandardSchemaSerializerContextOptions,
  StandardSchemaSerializerOptions,
};

export interface StandardSchemaSerializerMetadata {
  readonly schema: StandardSchemaV1<any, any>;
  readonly options?: StandardSchemaSerializerOptions & {
    validateOptions?: StandardSchemaV1Options;
  };
}

export interface StandardSchemaSerializerInterceptorOptions extends StandardSchemaSerializerOptions {
  /**
   * Optional default Standard Schema applied when no `@SerializeOptions({ schema })`
   * or `@UseStandardSchema()` decorator is present on the route handler or controller.
   */
  schema?: StandardSchemaV1<any, any>;
  /**
   * Default options forwarded to `schema["~standard"].validate()`.
   * Can be overridden per-handler via `@SerializeOptions({ validateOptions })`.
   */
  validateOptions?: StandardSchemaV1Options;
}

/**
 * Declares an outgoing Standard Schema v1 response validator/transformer on a
 * controller class or route handler method for `StandardSchemaSerializerInterceptor`.
 */
export function UseStandardSchema<TInput = unknown, TOutput = TInput>(
  schema: StandardSchemaV1<TInput, TOutput>,
  options?: StandardSchemaSerializerOptions & {
    validateOptions?: StandardSchemaV1Options;
  },
): ClassDecorator & MethodDecorator {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      "@UseStandardSchema() requires a valid Standard Schema v1 object (`~standard.version === 1`).",
    );
  }

  const meta: StandardSchemaSerializerMetadata = {
    schema,
    options: options ? { ...options } : undefined,
  };

  const decorator = (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (descriptor && descriptor.value !== undefined) {
      MetadataRegistry.define(
        STANDARD_SCHEMA_SERIALIZER_METADATA,
        meta,
        descriptor.value,
      );
      return descriptor;
    }
    MetadataRegistry.define(STANDARD_SCHEMA_SERIALIZER_METADATA, meta, target);
    return target;
  };

  return decorator as ClassDecorator & MethodDecorator;
}

function isReflectorLike(value: unknown): value is Reflector {
  return (
    value instanceof Reflector ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { get?: unknown }).get === "function")
  );
}

function isNativeResponsePassthrough(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  if (value instanceof StreamableFile) {
    return true;
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
  }
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return true;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return true;
  }
  if (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  ) {
    return true;
  }
  return false;
}

/**
 * Outgoing response serializer/validator interceptor backed by Standard Schema v1
 * reading BOTH `@UseStandardSchema(schema)` AND NestJS v12 `@SerializeOptions({ schema, validateOptions })`,
 * while passing native `Response`, `ReadableStream`, `Blob`/`BunFile`, `Uint8Array`,
 * `StreamableFile`, and `AsyncIterable` values through untouched.
 */
@Injectable()
export class StandardSchemaSerializerInterceptor implements BunestInterceptor {
  protected readonly reflector: Reflector;
  protected readonly defaultOptions: StandardSchemaSerializerInterceptorOptions;

  constructor();
  constructor(
    schema: StandardSchemaV1<any, any>,
    options?: StandardSchemaSerializerOptions & {
      validateOptions?: StandardSchemaV1Options;
    },
  );
  constructor(options: StandardSchemaSerializerInterceptorOptions);
  constructor(
    reflector: Reflector,
    defaultOptions?: StandardSchemaSerializerInterceptorOptions,
  );
  constructor(
    @Optional()
    @Inject(Reflector)
    firstArg?:
      | Reflector
      | StandardSchemaV1<any, any>
      | StandardSchemaSerializerInterceptorOptions,
    @Optional()
    secondArg?: StandardSchemaSerializerInterceptorOptions,
  ) {
    if (isStandardSchema(firstArg)) {
      this.reflector = new Reflector();
      this.defaultOptions = {
        ...(secondArg ?? {}),
        schema: firstArg,
      };
    } else if (isReflectorLike(firstArg)) {
      this.reflector = firstArg;
      this.defaultOptions = secondArg ?? {};
    } else {
      const opts = firstArg as
        StandardSchemaSerializerInterceptorOptions | undefined;
      this.reflector = new Reflector();
      this.defaultOptions = opts ?? secondArg ?? {};
    }
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const contextOptions = this.getContextOptions(context);
    const schema = contextOptions?.schema ?? this.defaultOptions.schema;
    const validateOptions =
      contextOptions?.validateOptions ?? this.defaultOptions.validateOptions;
    const errorOptions: StandardSchemaSerializerOptions = {
      errorHttpStatusCode:
        contextOptions?.errorHttpStatusCode ??
        this.defaultOptions.errorHttpStatusCode,
      disableErrorMessages:
        contextOptions?.disableErrorMessages ??
        this.defaultOptions.disableErrorMessages,
      exceptionFactory:
        contextOptions?.exceptionFactory ??
        this.defaultOptions.exceptionFactory,
    };

    const response = await next.handle();
    if (schema && context.getType?.() === "http") {
      if (
        typeof ReadableStream !== "undefined" &&
        response instanceof ReadableStream
      ) {
        const self = this;
        return response.pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              controller.enqueue(
                await self.serializeWithOptions(
                  chunk,
                  schema,
                  validateOptions,
                  errorOptions,
                ),
              );
            },
          }),
        );
      }
      if (
        response !== null &&
        typeof response === "object" &&
        !(response instanceof StreamableFile) &&
        !(typeof Response !== "undefined" && response instanceof Response) &&
        typeof (response as { [Symbol.asyncIterator]?: unknown })[
          Symbol.asyncIterator
        ] === "function"
      ) {
        const self = this;
        return (async function* () {
          for await (const chunk of response as AsyncIterable<unknown>) {
            yield await self.serializeWithOptions(
              chunk,
              schema,
              validateOptions,
              errorOptions,
            );
          }
        })();
      }
    }
    return this.serializeWithOptions(
      response,
      schema,
      validateOptions,
      errorOptions,
    );
  }

  /**
   * Serializes responses that are non-null objects and not native streams/binaries.
   */
  serialize(
    response: PlainLiteralObject | Array<PlainLiteralObject>,
    schema: StandardSchemaV1 | undefined,
    validateOptions?: StandardSchemaV1Options,
  ):
    | PlainLiteralObject
    | Array<PlainLiteralObject>
    | Promise<PlainLiteralObject | Array<PlainLiteralObject>> {
    return this.serializeWithOptions(
      response,
      schema,
      validateOptions,
      this.defaultOptions,
    ) as
      | PlainLiteralObject
      | Array<PlainLiteralObject>
      | Promise<PlainLiteralObject | Array<PlainLiteralObject>>;
  }

  /**
   * Validates and transforms a single plain object or class instance through `schema`.
   */
  async transformToPlain(
    plainOrClass: unknown,
    schema: StandardSchemaV1,
    validateOptions?: StandardSchemaV1Options,
  ): Promise<PlainLiteralObject> {
    return this.validateAndTransformSingle(
      plainOrClass,
      schema,
      validateOptions,
      this.defaultOptions,
    );
  }

  protected getContextOptions(
    context: ExecutionContext,
  ): StandardSchemaSerializerContextOptions | undefined {
    const handler = context.getHandler?.();
    const controllerClass = context.getClass?.();

    const handlerUseMeta = handler
      ? this.reflector.get<StandardSchemaSerializerMetadata>(
          STANDARD_SCHEMA_SERIALIZER_METADATA,
          handler,
        )
      : undefined;
    const classUseMeta = controllerClass
      ? this.reflector.get<StandardSchemaSerializerMetadata>(
          STANDARD_SCHEMA_SERIALIZER_METADATA,
          controllerClass,
        )
      : undefined;

    let handlerSerializeOpts: StandardSchemaSerializerContextOptions | undefined;
    let classSerializeOpts: StandardSchemaSerializerContextOptions | undefined;
    if (typeof this.reflector.getAll === "function") {
      const all = this.reflector.getAll<
        Array<StandardSchemaSerializerContextOptions | undefined>
      >(CLASS_SERIALIZER_OPTIONS, [handler, controllerClass]);
      if (Array.isArray(all)) {
        handlerSerializeOpts = all[0];
        classSerializeOpts = all[1];
      }
    } else {
      handlerSerializeOpts = handler
        ? this.reflector.get<StandardSchemaSerializerContextOptions>(
            CLASS_SERIALIZER_OPTIONS,
            handler,
          )
        : undefined;
      classSerializeOpts = controllerClass
        ? this.reflector.get<StandardSchemaSerializerContextOptions>(
            CLASS_SERIALIZER_OPTIONS,
            controllerClass,
          )
        : undefined;
    }

    const handlerMerged: StandardSchemaSerializerContextOptions | undefined =
      handlerUseMeta || handlerSerializeOpts
        ? {
            ...handlerSerializeOpts,
            ...(handlerUseMeta?.options ?? {}),
            schema: handlerUseMeta?.schema ?? handlerSerializeOpts?.schema,
            validateOptions:
              handlerUseMeta?.options?.validateOptions ??
              handlerSerializeOpts?.validateOptions,
          }
        : undefined;

    const classMerged: StandardSchemaSerializerContextOptions | undefined =
      classUseMeta || classSerializeOpts
        ? {
            ...classSerializeOpts,
            ...(classUseMeta?.options ?? {}),
            schema: classUseMeta?.schema ?? classSerializeOpts?.schema,
            validateOptions:
              classUseMeta?.options?.validateOptions ??
              classSerializeOpts?.validateOptions,
          }
        : undefined;

    if (!handlerMerged && !classMerged) {
      return undefined;
    }
    if (!handlerMerged || !classMerged) {
      return handlerMerged ?? classMerged;
    }

    // Merge key by key so a handler setting only `validateOptions` doesn't drop class `schema`
    return {
      schema: handlerMerged.schema ?? classMerged.schema,
      validateOptions:
        handlerMerged.validateOptions ?? classMerged.validateOptions,
      errorHttpStatusCode:
        handlerMerged.errorHttpStatusCode ?? classMerged.errorHttpStatusCode,
      disableErrorMessages:
        handlerMerged.disableErrorMessages ?? classMerged.disableErrorMessages,
      exceptionFactory:
        handlerMerged.exceptionFactory ?? classMerged.exceptionFactory,
    };
  }

  private serializeWithOptions(
    response: unknown,
    schema: StandardSchemaV1 | undefined,
    validateOptions: StandardSchemaV1Options | undefined,
    errorOptions: StandardSchemaSerializerOptions,
  ): unknown | Promise<unknown> {
    if (
      !schema ||
      response === null ||
      response === undefined ||
      typeof response !== "object" ||
      isNativeResponsePassthrough(response)
    ) {
      return response;
    }

    if (Array.isArray(response)) {
      return Promise.all(
        response.map((item) =>
          this.validateAndTransformSingle(
            item,
            schema,
            validateOptions,
            errorOptions,
          ),
        ),
      );
    }

    return this.validateAndTransformSingle(
      response,
      schema,
      validateOptions,
      errorOptions,
    );
  }

  private async validateAndTransformSingle(
    plainOrClass: unknown,
    schema: StandardSchemaV1,
    validateOptions: StandardSchemaV1Options | undefined,
    errorOptions: StandardSchemaSerializerOptions,
  ): Promise<PlainLiteralObject> {
    if (!plainOrClass) {
      return plainOrClass as PlainLiteralObject;
    }

    const result = await schema["~standard"].validate(
      plainOrClass,
      validateOptions,
    );
    if (result.issues) {
      const details = formatStandardSchemaIssues(result.issues, "response");
      if (errorOptions.exceptionFactory) {
        throw errorOptions.exceptionFactory(result.issues, details);
      }
      const err = createValidationHttpException(
        details,
        errorOptions.errorHttpStatusCode ?? HttpStatus.INTERNAL_SERVER_ERROR,
        errorOptions.disableErrorMessages ?? false,
      );
      if (!errorOptions.disableErrorMessages) {
        const issueSummary = result.issues
          .map((i) => i.message)
          .filter(Boolean)
          .join("; ");
        if (issueSummary) {
          err.message = `Serialization failed: ${issueSummary}`;
        }
      }
      throw err;
    }

    return result.value as PlainLiteralObject;
  }
}

DecoratorRegistry.markInternal(StandardSchemaSerializerInterceptor);
