import { Inject, Injectable, Optional } from "../decorators/core.decorators";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import type {
  BunestInterceptor,
  CallHandler,
  ExecutionContext,
} from "../interfaces/pipeline.interface";
import type { TransformerPackageLike } from "../interfaces/validation.interface";
import { Reflector } from "../metadata/reflector";
import { loadDefaultTransformerPackage } from "../pipes/validation-http.util";
import {
  CLASS_SERIALIZER_OPTIONS,
  type ClassSerializerContextOptions,
} from "./serialize-options.decorator";

export interface ClassSerializerInterceptorOptions
  extends ClassSerializerContextOptions {
  /**
   * Optional custom `class-transformer`-compatible package override.
   */
  transformerPackage?: TransformerPackageLike;
}

function isReflectorLike(value: unknown): value is Reflector {
  return (
    value instanceof Reflector ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { get?: unknown }).get === "function")
  );
}

function isPassthroughValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true;
  }

  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (value instanceof Date || value instanceof RegExp) {
    return true;
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
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
 * Interceptor that serializes handler return values using `class-transformer`'s
 * `instanceToPlain()`, respecting `@Exclude()`, `@Expose()`, `@Transform()`,
 * groups, and class/method `@SerializeOptions()`, while passing through native
 * Web/Bun `Response`, `ReadableStream`, `Blob`/`BunFile`, `Uint8Array`,
 * `AsyncIterable`, and primitive values untouched.
 */
@Injectable()
export class ClassSerializerInterceptor implements BunestInterceptor {
  protected readonly reflector: Reflector;
  protected readonly defaultOptions: ClassSerializerInterceptorOptions;
  private resolvedTransformerPkg?: TransformerPackageLike;

  constructor();
  constructor(options: ClassSerializerInterceptorOptions);
  constructor(
    reflector: Reflector,
    defaultOptions?: ClassSerializerInterceptorOptions,
  );
  constructor(
    @Optional()
    @Inject(Reflector)
    reflectorOrOptions?: Reflector | ClassSerializerInterceptorOptions,
    @Optional()
    @Inject(CLASS_SERIALIZER_OPTIONS)
    defaultOptions?: ClassSerializerInterceptorOptions,
  ) {
    if (isReflectorLike(reflectorOrOptions)) {
      this.reflector = reflectorOrOptions;
      this.defaultOptions = defaultOptions ?? {};
    } else {
      this.reflector = new Reflector();
      this.defaultOptions = reflectorOrOptions ?? defaultOptions ?? {};
    }
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const contextOptions = this.getContextOptions(context);
    const { transformerPackage: _ignoredPkg, ...defaultContextOpts } =
      this.defaultOptions;
    const mergedOptions: ClassSerializerContextOptions = {
      ...defaultContextOpts,
      ...contextOptions,
    };

    const response = await next.handle();
    return this.serialize(response, mergedOptions);
  }

  serialize(
    response: unknown,
    options: ClassSerializerContextOptions = {},
  ): unknown {
    if (isPassthroughValue(response)) {
      return response;
    }

    if (Array.isArray(response)) {
      return response.map((item) => this.serializeSingle(item, options));
    }

    return this.serializeSingle(response, options);
  }

  /**
   * NestJS-compatible public hook transforming a single value/instance to a plain object.
   */
  transformToPlain(
    plainOrClass: unknown,
    options: ClassSerializerContextOptions = {},
  ): unknown {
    return this.serializeSingle(plainOrClass, options);
  }

  private getTransformerPackage(): TransformerPackageLike {
    if (this.defaultOptions.transformerPackage) {
      return this.defaultOptions.transformerPackage;
    }
    this.resolvedTransformerPkg ??= loadDefaultTransformerPackage();
    return this.resolvedTransformerPkg;
  }

  private serializeSingle(
    value: unknown,
    options: ClassSerializerContextOptions,
  ): unknown {
    if (isPassthroughValue(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.serializeSingle(item, options));
    }

    const transformer = this.getTransformerPackage();
    const toPlainFn =
      transformer.instanceToPlain ?? transformer.classToPlain;
    if (typeof toPlainFn !== "function") {
      throw new Error(
        'Configured transformerPackage is missing "instanceToPlain()" / "classToPlain()".',
      );
    }

    const { type, ...transformOptions } = options;

    if (type) {
      const instance =
        value instanceof type
          ? value
          : typeof transformer.plainToInstance === "function"
            ? transformer.plainToInstance(type, value, transformOptions)
            : value;
      return toPlainFn(instance, transformOptions);
    }

    return toPlainFn(value, transformOptions);
  }

  protected getContextOptions(
    context: ExecutionContext,
  ): ClassSerializerContextOptions | undefined {
    const controllerClass = context.getClass();
    const handler = context.getHandler();

    const classOptions = controllerClass
      ? this.reflector.get<ClassSerializerContextOptions>(
          CLASS_SERIALIZER_OPTIONS,
          controllerClass,
        )
      : undefined;
    const handlerOptions = handler
      ? this.reflector.get<ClassSerializerContextOptions>(
          CLASS_SERIALIZER_OPTIONS,
          handler,
        )
      : undefined;

    if (!classOptions && !handlerOptions) {
      return undefined;
    }

    return {
      ...classOptions,
      ...handlerOptions,
    };
  }
}

DecoratorRegistry.markInternal(ClassSerializerInterceptor);
