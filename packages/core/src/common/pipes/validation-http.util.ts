import { HttpStatus } from "../enums/scope.enum";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  InternalServerErrorException,
  MethodNotAllowedException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type HttpExceptionInput,
} from "../exceptions/built-in.exceptions";
import {
  HttpException,
  type HttpExceptionOptions,
  type ValidationErrorDetail,
  type ValidationErrorResponse,
} from "../exceptions/http.exception";
import type {
  TransformerPackage,
  ValidationError,
  ValidatorPackage,
} from "../interfaces/validation.interface";

type BuiltInHttpExceptionCtor = new (
  objectOrError?: HttpExceptionInput,
  descriptionOrOptions?: string | HttpExceptionOptions,
) => HttpException;

export const HTTP_STATUS_REASON_PHRASES: Readonly<Record<number, string>> = {
  [HttpStatus.CONTINUE]: "Continue",
  [HttpStatus.SWITCHING_PROTOCOLS]: "Switching Protocols",
  [HttpStatus.PROCESSING]: "Processing",
  [HttpStatus.EARLYHINTS]: "Early Hints",
  [HttpStatus.OK]: "OK",
  [HttpStatus.CREATED]: "Created",
  [HttpStatus.ACCEPTED]: "Accepted",
  [HttpStatus.NON_AUTHORITATIVE_INFORMATION]: "Non-Authoritative Information",
  [HttpStatus.NO_CONTENT]: "No Content",
  [HttpStatus.RESET_CONTENT]: "Reset Content",
  [HttpStatus.PARTIAL_CONTENT]: "Partial Content",
  [HttpStatus.AMBIGUOUS]: "Multiple Choices",
  [HttpStatus.MOVED_PERMANENTLY]: "Moved Permanently",
  [HttpStatus.FOUND]: "Found",
  [HttpStatus.SEE_OTHER]: "See Other",
  [HttpStatus.NOT_MODIFIED]: "Not Modified",
  [HttpStatus.TEMPORARY_REDIRECT]: "Temporary Redirect",
  [HttpStatus.PERMANENT_REDIRECT]: "Permanent Redirect",
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.PAYMENT_REQUIRED]: "Payment Required",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.METHOD_NOT_ALLOWED]: "Method Not Allowed",
  [HttpStatus.NOT_ACCEPTABLE]: "Not Acceptable",
  [HttpStatus.PROXY_AUTHENTICATION_REQUIRED]: "Proxy Authentication Required",
  [HttpStatus.REQUEST_TIMEOUT]: "Request Timeout",
  [HttpStatus.CONFLICT]: "Conflict",
  [HttpStatus.GONE]: "Gone",
  [HttpStatus.LENGTH_REQUIRED]: "Length Required",
  [HttpStatus.PRECONDITION_FAILED]: "Precondition Failed",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "Payload Too Large",
  [HttpStatus.URI_TOO_LONG]: "URI Too Long",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "Unsupported Media Type",
  [HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE]: "Range Not Satisfiable",
  [HttpStatus.EXPECTATION_FAILED]: "Expectation Failed",
  [HttpStatus.I_AM_A_TEAPOT]: "I'm a Teapot",
  [HttpStatus.MISDIRECTED]: "Misdirected Request",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "Unprocessable Entity",
  [HttpStatus.FAILED_DEPENDENCY]: "Failed Dependency",
  [HttpStatus.PRECONDITION_REQUIRED]: "Precondition Required",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  [HttpStatus.NOT_IMPLEMENTED]: "Not Implemented",
  [HttpStatus.BAD_GATEWAY]: "Bad Gateway",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
  [HttpStatus.GATEWAY_TIMEOUT]: "Gateway Timeout",
  [HttpStatus.HTTP_VERSION_NOT_SUPPORTED]: "HTTP Version Not Supported",
};

const HTTP_EXCEPTION_BY_STATUS: Readonly<
  Record<number, BuiltInHttpExceptionCtor>
> = {
  [HttpStatus.BAD_REQUEST]: BadRequestException,
  [HttpStatus.UNAUTHORIZED]: UnauthorizedException,
  [HttpStatus.FORBIDDEN]: ForbiddenException,
  [HttpStatus.NOT_FOUND]: NotFoundException,
  [HttpStatus.METHOD_NOT_ALLOWED]: MethodNotAllowedException,
  [HttpStatus.CONFLICT]: ConflictException,
  [HttpStatus.GONE]: GoneException,
  [HttpStatus.PAYLOAD_TOO_LARGE]: PayloadTooLargeException,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: UnsupportedMediaTypeException,
  [HttpStatus.UNPROCESSABLE_ENTITY]: UnprocessableEntityException,
  [HttpStatus.TOO_MANY_REQUESTS]: TooManyRequestsException,
  [HttpStatus.INTERNAL_SERVER_ERROR]: InternalServerErrorException,
  [HttpStatus.NOT_IMPLEMENTED]: NotImplementedException,
  [HttpStatus.BAD_GATEWAY]: BadGatewayException,
  [HttpStatus.SERVICE_UNAVAILABLE]: ServiceUnavailableException,
  [HttpStatus.GATEWAY_TIMEOUT]: GatewayTimeoutException,
};

export function getHttpReasonPhrase(statusCode: number): string {
  return HTTP_STATUS_REASON_PHRASES[statusCode] ?? "Http Exception";
}

export function createValidationHttpException(
  details: ValidationErrorDetail[],
  statusCode: number = HttpStatus.BAD_REQUEST,
  disableErrorMessages = false,
): HttpException {
  const error = getHttpReasonPhrase(statusCode);
  const ExceptionCtor = HTTP_EXCEPTION_BY_STATUS[statusCode];

  if (disableErrorMessages) {
    const body = {
      statusCode,
      error,
      message: error,
    };
    if (ExceptionCtor) {
      return new ExceptionCtor(body, error);
    }
    return new HttpException(body, statusCode, { description: error });
  }

  const body: ValidationErrorResponse = {
    statusCode,
    error,
    message: "Validation failed",
    details,
  };

  if (ExceptionCtor) {
    return new ExceptionCtor(body as unknown as Record<string, unknown>, error);
  }

  return new HttpException(
    body as unknown as Record<string, unknown>,
    statusCode,
    { description: error },
  );
}

export function createStatusHttpException(
  body: Record<string, unknown>,
  statusCode: number = HttpStatus.BAD_REQUEST,
): HttpException {
  const error = getHttpReasonPhrase(statusCode);
  const ExceptionCtor = HTTP_EXCEPTION_BY_STATUS[statusCode];
  if (ExceptionCtor) {
    return new ExceptionCtor(body, error);
  }
  return new HttpException(body, statusCode, { description: error });
}

const ARRAY_INDEX_REGEX = /^\d+$/;

function buildFieldPath(
  parentPath: string,
  property: string | undefined,
  parentIsDefinitelyNonArray: boolean,
): string {
  const prop = typeof property === "string" ? property : "";
  if (prop.length === 0) {
    return parentPath;
  }
  if (parentPath.length === 0) {
    return prop;
  }
  if (!parentIsDefinitelyNonArray && ARRAY_INDEX_REGEX.test(prop)) {
    return `${parentPath}[${prop}]`;
  }
  return `${parentPath}.${prop}`;
}

export function flattenValidationErrorDetails(
  errors: readonly ValidationError[],
  parentPath = "",
  parentIsDefinitelyNonArray = false,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (const error of errors) {
    const fieldPath = buildFieldPath(
      parentPath,
      error.property,
      parentIsDefinitelyNonArray,
    );

    if (error.constraints && Object.keys(error.constraints).length > 0) {
      const normalizedConstraints: Record<string, string> = {};
      for (const [constraintKey, message] of Object.entries(
        error.constraints,
      )) {
        normalizedConstraints[constraintKey] =
          typeof message === "string" ? message : String(message ?? "");
      }
      details.push({
        field: fieldPath,
        constraints: normalizedConstraints,
        messages: Object.values(normalizedConstraints),
      });
    }

    if (error.children && error.children.length > 0) {
      const childParentNonArray =
        error.value !== undefined && !Array.isArray(error.value);
      details.push(
        ...flattenValidationErrorDetails(
          error.children,
          fieldPath,
          childParentNonArray,
        ),
      );
    }
  }

  return details;
}

export const DANGEROUS_PROTOTYPE_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
] as const);

export type DangerousPrototypeKey = (typeof DANGEROUS_PROTOTYPE_KEYS)[number];

export interface DangerousKeyViolation {
  readonly path: string;
  readonly key: DangerousPrototypeKey;
  readonly segments: readonly (string | number)[];
}

function isNonTraversableObject(value: object): boolean {
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  ) {
    return true;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
    return true;
  }
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
  }
  if (typeof Request !== "undefined" && value instanceof Request) {
    return true;
  }

  return false;
}

function appendSegment(parentPath: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${parentPath}[${segment}]`;
  }
  return parentPath.length > 0 ? `${parentPath}.${segment}` : segment;
}

export function findDangerousKeys(value: unknown): DangerousKeyViolation[] {
  const violations: DangerousKeyViolation[] = [];
  const activeAncestors = new Set<object>();

  const walk = (
    current: unknown,
    currentPath: string,
    segments: readonly (string | number)[],
  ): void => {
    if (typeof current !== "object" || current === null) {
      return;
    }

    if (activeAncestors.has(current)) {
      return;
    }

    activeAncestors.add(current);
    try {
      for (const dangerousKey of DANGEROUS_PROTOTYPE_KEYS) {
        if (Object.hasOwn(current, dangerousKey)) {
          violations.push({
            path: appendSegment(currentPath, dangerousKey),
            key: dangerousKey,
            segments: [...segments, dangerousKey],
          });
        }
      }

      if (isNonTraversableObject(current)) {
        return;
      }

      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i += 1) {
          walk(current[i], appendSegment(currentPath, i), [...segments, i]);
        }
        return;
      }

      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype"
        ) {
          continue;
        }
        walk(record[key], appendSegment(currentPath, key), [...segments, key]);
      }
    } finally {
      activeAncestors.delete(current);
    }
  };

  walk(value, "", []);
  return violations;
}

export function buildDangerousKeyValidationErrors(
  violations: readonly DangerousKeyViolation[],
): ValidationError[] {
  return violations.map((violation) => {
    const leaf: ValidationError = {
      property: violation.key,
      children: [],
      constraints: {
        forbiddenKey: `property ${violation.key} is not allowed`,
      },
    };

    let current: ValidationError = leaf;
    for (let i = violation.segments.length - 2; i >= 0; i -= 1) {
      current = {
        property: String(violation.segments[i]),
        children: [current],
      };
    }

    return current;
  });
}

const NATIVE_VALIDATOR_ENGINE_SYMBOL = Symbol.for(
  "bunest:class-validator:engine",
);
const NATIVE_VALIDATOR_PACKAGE_SYMBOL = Symbol.for(
  "bunest:class-validator:package",
);
const NATIVE_VALIDATOR_STORAGE_SYMBOL = Symbol.for(
  "bunest:class-validator:storage",
);
const NATIVE_TRANSFORMER_ENGINE_SYMBOL = Symbol.for(
  "bunest:class-transformer:engine",
);
const NATIVE_TRANSFORMER_PACKAGE_SYMBOL = Symbol.for(
  "bunest:class-transformer:package",
);
const NATIVE_TRANSFORMER_STORAGE_SYMBOL = Symbol.for(
  "bunest:class-transformer:storage",
);

export interface ValidationMetadataLike {
  type: string;
  name?: string;
  target: Function | string;
  propertyName: string;
  constraints?: unknown[];
  constraintCls?: Function;
  validationTypeOptions?: unknown;
  groups?: string[];
  each?: boolean;
  context?: unknown;
  message?: unknown;
  always?: boolean;
}

export interface ValidationMetadataStorageLike {
  getTargetValidationMetadatas(
    targetConstructor: Function,
    targetSchema: string,
    always: boolean,
    strictGroups: boolean,
    groups?: string[],
  ): ValidationMetadataLike[];
  getTargetValidatorConstraints?(target: Function): Array<{
    name?: string;
    instance?: { defaultMessage?(va: any): string };
  }>;
  addValidationMetadata?(meta: ValidationMetadataLike): void;
  hasMetadataFor?(target: Function, targetSchema?: string): boolean;
  cloneClassMetadata?(
    source: Function,
    target: Function,
    propertyFilter?: (propertyName: string) => boolean,
  ): string[];
}

export interface NativeValidatorEngineLike extends ValidatorPackage {
  validateSync?: (object: object, options?: any) => ValidationError[];
  validateMaybeSync?: (
    object: object,
    options?: any,
  ) => ValidationError[] | Promise<ValidationError[]>;
  canValidateSynchronously?: (target: Function, options?: any) => boolean;
  getMetadataStorage?: () => ValidationMetadataStorageLike;
}

let cachedUpstreamValidatorPkg: ValidatorPackage | null | undefined;
let cachedUpstreamTransformerPkg: TransformerPackage | null | undefined;
let triedLoadingNativeValidator = false;
let triedLoadingNativeTransformer = false;

function tryLoadOptionalPackage<T>(
  segments: readonly string[],
  separator = "-",
): T | undefined {
  const pkgName = segments.join(separator);
  const bases = [import.meta.dir, process.cwd()];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    if (!base) continue;
    try {
      const resolved = Bun.resolveSync(pkgName, base);
      return require(resolved) as T;
    } catch {
      // Try next resolution root
    }
  }
  return undefined;
}

export function getNativeValidatorStorage():
  | ValidationMetadataStorageLike
  | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const storage = g[NATIVE_VALIDATOR_STORAGE_SYMBOL] as
    | Partial<ValidationMetadataStorageLike>
    | undefined;
  if (storage && typeof storage.getTargetValidationMetadatas === "function") {
    return storage as ValidationMetadataStorageLike;
  }
  return undefined;
}

export function getNativeTransformerStorage(): unknown {
  const g = globalThis as Record<PropertyKey, unknown>;
  return g[NATIVE_TRANSFORMER_STORAGE_SYMBOL];
}

export function getNativeValidatorEngine():
  | NativeValidatorEngineLike
  | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const existing = (g[NATIVE_VALIDATOR_ENGINE_SYMBOL] ??
    g[NATIVE_VALIDATOR_PACKAGE_SYMBOL]) as
    | NativeValidatorEngineLike
    | undefined;
  if (existing && typeof existing.validate === "function") {
    return existing;
  }
  if (!triedLoadingNativeValidator) {
    triedLoadingNativeValidator = true;
    const loaded = tryLoadOptionalPackage<NativeValidatorEngineLike>(
      ["@bunest/validation", "validator"],
      "/",
    );
    if (loaded && typeof loaded.validate === "function") {
      return (
        ((g[NATIVE_VALIDATOR_ENGINE_SYMBOL] ??
          g[NATIVE_VALIDATOR_PACKAGE_SYMBOL]) as
          | NativeValidatorEngineLike
          | undefined) ?? loaded
      );
    }
  }
  return (g[NATIVE_VALIDATOR_ENGINE_SYMBOL] ??
    g[NATIVE_VALIDATOR_PACKAGE_SYMBOL]) as
    | NativeValidatorEngineLike
    | undefined;
}

export function getNativeTransformerEngine(): TransformerPackage | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const existing = (g[NATIVE_TRANSFORMER_ENGINE_SYMBOL] ??
    g[NATIVE_TRANSFORMER_PACKAGE_SYMBOL]) as TransformerPackage | undefined;
  if (existing && typeof existing.plainToInstance === "function") {
    return existing;
  }
  if (!triedLoadingNativeTransformer) {
    triedLoadingNativeTransformer = true;
    const loaded = tryLoadOptionalPackage<TransformerPackage>(
      ["@bunest/validation", "transformer"],
      "/",
    );
    if (loaded && typeof loaded.plainToInstance === "function") {
      return (
        ((g[NATIVE_TRANSFORMER_ENGINE_SYMBOL] ??
          g[NATIVE_TRANSFORMER_PACKAGE_SYMBOL]) as
          | TransformerPackage
          | undefined) ?? loaded
      );
    }
  }
  return (g[NATIVE_TRANSFORMER_ENGINE_SYMBOL] ??
    g[NATIVE_TRANSFORMER_PACKAGE_SYMBOL]) as TransformerPackage | undefined;
}

export function getUpstreamValidatorPackage(): ValidatorPackage | undefined {
  if (cachedUpstreamValidatorPkg !== undefined) {
    return cachedUpstreamValidatorPkg ?? undefined;
  }
  const mod = tryLoadOptionalPackage<ValidatorPackage>(["class", "validator"]);
  cachedUpstreamValidatorPkg =
    mod && typeof mod.validate === "function" ? mod : null;
  return cachedUpstreamValidatorPkg ?? undefined;
}

export function getUpstreamTransformerPackage():
  | TransformerPackage
  | undefined {
  if (cachedUpstreamTransformerPkg !== undefined) {
    return cachedUpstreamTransformerPkg ?? undefined;
  }
  const mod = tryLoadOptionalPackage<TransformerPackage>([
    "class",
    "transformer",
  ]);
  cachedUpstreamTransformerPkg = mod ?? null;
  return cachedUpstreamTransformerPkg ?? undefined;
}

export function getUpstreamValidatorStorage():
  | ValidationMetadataStorageLike
  | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const globalStorage = g.classValidatorMetadataStorage as
    | Partial<ValidationMetadataStorageLike>
    | undefined;
  if (
    globalStorage &&
    typeof globalStorage.getTargetValidationMetadatas === "function"
  ) {
    return globalStorage as ValidationMetadataStorageLike;
  }
  const pkg = getUpstreamValidatorPackage() as
    | (ValidatorPackage & {
        getMetadataStorage?: () => ValidationMetadataStorageLike;
      })
    | undefined;
  if (pkg && typeof pkg.getMetadataStorage === "function") {
    return pkg.getMetadataStorage();
  }
  return undefined;
}

function hasStorageMetadataFor(
  storage: ValidationMetadataStorageLike | undefined,
  target: Function | undefined,
): boolean {
  if (!storage || typeof target !== "function") return false;
  if (typeof storage.hasMetadataFor === "function") {
    return storage.hasMetadataFor(target);
  }
  try {
    return (
      storage.getTargetValidationMetadatas(target, "", false, false).length > 0
    );
  } catch {
    return false;
  }
}

function hasNativeTransformerMetadataFor(target: Function | undefined): boolean {
  if (typeof target !== "function") return false;
  const storage = getNativeTransformerStorage() as
    | { hasMetadataFor?: (t: Function) => boolean }
    | undefined;
  return Boolean(storage?.hasMetadataFor?.(target));
}

function hasUpstreamTransformerMetadataFor(
  target: Function | undefined,
): boolean {
  if (typeof target !== "function") return false;
  const ctStorages: Array<{
    _typeMetadatas?: Map<Function, unknown>;
    _exposeMetadatas?: Map<Function, unknown>;
    _excludeMetadatas?: Map<Function, unknown>;
    _transformMetadatas?: Map<Function, unknown>;
  }> = [];
  for (const variant of ["cjs", "esm5"]) {
    const mod = tryLoadOptionalPackage<{ defaultMetadataStorage?: any }>(
      ["class-transformer", variant, "storage"],
      "/",
    );
    if (mod?.defaultMetadataStorage) {
      ctStorages.push(mod.defaultMetadataStorage);
    }
  }
  if (ctStorages.length === 0) return false;
  let cur: Function | null = target;
  while (
    typeof cur === "function" &&
    cur !== Function.prototype &&
    cur !== Object
  ) {
    for (let i = 0; i < ctStorages.length; i += 1) {
      const s = ctStorages[i]!;
      if (
        s._typeMetadatas?.has(cur) ||
        s._exposeMetadatas?.has(cur) ||
        s._excludeMetadatas?.has(cur) ||
        s._transformMetadatas?.has(cur)
      ) {
        return true;
      }
    }
    const parent = Object.getPrototypeOf(cur);
    if (typeof parent !== "function" || parent === Function.prototype) break;
    cur = parent;
  }
  return false;
}

/**
 * Queries validation metadata for `target` across both Bunest's native
 * `Symbol.for("bunest:class-validator:storage")` and (lazily, if installed)
 * upstream `class-validator` metadata storage (ADR-015 dual-engine coexistence).
 */
export function getValidationMetadatasForTarget(
  target: Function,
  always = false,
  strictGroups = false,
  groups?: string[],
): ValidationMetadataLike[] {
  const nativeStorage = getNativeValidatorStorage();
  const nativeMetas = nativeStorage
    ? nativeStorage.getTargetValidationMetadatas(
        target,
        "",
        always,
        strictGroups,
        groups,
      )
    : [];
  const upstreamStorage = getUpstreamValidatorStorage();
  const upstreamMetas =
    upstreamStorage && upstreamStorage !== nativeStorage
      ? upstreamStorage.getTargetValidationMetadatas(
          target,
          "",
          always,
          strictGroups,
          groups,
        )
      : [];
  if (nativeMetas.length === 0) return upstreamMetas;
  if (upstreamMetas.length === 0) return nativeMetas;
  return [...nativeMetas, ...upstreamMetas];
}

/**
 * Resolves the appropriate validator engine for `target` (ADR-015 §3):
 * - Prefers Bunest's zero-dep native engine when `target` uses native decorators
 *   or when no upstream-only metadata exists.
 * - Transparently falls back to upstream `class-validator` if `target` carries
 *   metadata registered only in upstream `class-validator`.
 */
export function resolveValidatorPackageFor(
  target?: Function,
): NativeValidatorEngineLike {
  const nativeStorage = getNativeValidatorStorage();
  if (target && hasStorageMetadataFor(nativeStorage, target)) {
    const nativeEngine = getNativeValidatorEngine();
    if (nativeEngine) return nativeEngine;
  }

  if (target) {
    const upstreamStorage = getUpstreamValidatorStorage();
    if (
      upstreamStorage &&
      upstreamStorage !== nativeStorage &&
      hasStorageMetadataFor(upstreamStorage, target)
    ) {
      const upstreamPkg = getUpstreamValidatorPackage();
      if (upstreamPkg) return upstreamPkg;
    }
  }

  const nativeEngine = getNativeValidatorEngine();
  if (nativeEngine) {
    return nativeEngine;
  }

  const upstreamPkg = getUpstreamValidatorPackage();
  if (upstreamPkg) {
    return upstreamPkg;
  }

  throw new Error(
    'Missing validation engine for ValidationPipe. Install "@bunest/validation" (or "class-validator") or pass a custom "validatorPackage".',
  );
}

/**
 * Resolves the appropriate transformer engine for `target` (ADR-015 §3):
 * - Prefers Bunest's zero-dep native engine when `target` uses native decorators
 *   or when no upstream-only metadata exists.
 * - Transparently falls back to upstream `class-transformer` when `target` carries
 *   upstream `class-transformer` or `class-validator` metadata.
 */
export function resolveTransformerPackageFor(
  target?: Function,
): TransformerPackage {
  if (
    target &&
    (hasNativeTransformerMetadataFor(target) ||
      hasStorageMetadataFor(getNativeValidatorStorage(), target))
  ) {
    const nativeEngine = getNativeTransformerEngine();
    if (nativeEngine) return nativeEngine;
  }

  if (target) {
    const hasUpstreamMeta =
      hasUpstreamTransformerMetadataFor(target) ||
      hasStorageMetadataFor(getUpstreamValidatorStorage(), target);
    if (hasUpstreamMeta) {
      const upstreamPkg = getUpstreamTransformerPackage();
      if (upstreamPkg) return upstreamPkg;
    }
  }

  const nativeEngine = getNativeTransformerEngine();
  if (nativeEngine) {
    return nativeEngine;
  }

  const upstreamPkg = getUpstreamTransformerPackage();
  if (upstreamPkg) {
    return upstreamPkg;
  }

  throw new Error(
    'Missing transformer engine for ValidationPipe / ClassSerializerInterceptor. Install "@bunest/validation" (or "class-transformer") or pass a custom "transformerPackage".',
  );
}

function findNestedClassConstructors(
  value: unknown,
  out: Set<Function>,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (depth > 8 || typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      findNestedClassConstructors(value[i], out, seen, depth + 1);
    }
    return;
  }
  const ctor = value.constructor;
  if (
    typeof ctor === "function" &&
    ctor !== Object &&
    ctor !== Array &&
    ctor !== Date &&
    ctor !== RegExp &&
    ctor !== Map &&
    ctor !== Set
  ) {
    out.add(ctor);
  }
  if (value instanceof Map || value instanceof Set) {
    for (const item of value.values()) {
      findNestedClassConstructors(item, out, seen, depth + 1);
    }
    return;
  }
  if (isNonTraversableObject(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    findNestedClassConstructors(record[key], out, seen, depth + 1);
  }
}

/**
 * Resolves the appropriate transformer engine for a runtime value (including
 * plain envelopes wrapping nested class instances, e.g. `{ data: new User() }`).
 */
export function resolveTransformerPackageForValue(
  value: unknown,
  explicitTarget?: Function,
): TransformerPackage {
  if (explicitTarget) {
    return resolveTransformerPackageFor(explicitTarget);
  }
  const ctors = new Set<Function>();
  findNestedClassConstructors(value, ctors, new WeakSet<object>(), 0);
  let hasUpstream = false;
  for (const ctor of ctors) {
    if (
      hasNativeTransformerMetadataFor(ctor) ||
      hasStorageMetadataFor(getNativeValidatorStorage(), ctor)
    ) {
      const nativeEngine = getNativeTransformerEngine();
      if (nativeEngine) return nativeEngine;
    }
    if (
      hasUpstreamTransformerMetadataFor(ctor) ||
      hasStorageMetadataFor(getUpstreamValidatorStorage(), ctor)
    ) {
      hasUpstream = true;
    }
  }
  if (hasUpstream) {
    const upstreamPkg = getUpstreamTransformerPackage();
    if (upstreamPkg) return upstreamPkg;
  }
  return resolveTransformerPackageFor(undefined);
}

export function loadDefaultValidatorPackage(
  target?: Function,
): ValidatorPackage {
  return resolveValidatorPackageFor(target);
}

export function loadDefaultTransformerPackage(
  target?: Function,
): TransformerPackage {
  return resolveTransformerPackageFor(target);
}
