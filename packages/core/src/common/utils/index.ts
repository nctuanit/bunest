// Core NestJS-compatible utilities
export {
  assignMetadata,
  flatten,
  mixin,
  stripProtoKeys,
} from "./common.utils";

// Pattern matching struct (ts-pattern style)
export {
  MATCHER_SYMBOL,
  NonExhaustiveError,
  P,
  isMatching,
  match,
  type ArrayMatcher,
  type BigIntMatcher,
  type ChainableMatcher,
  type ExcludeMatched,
  type ExtractMatched,
  type MatchBuilder,
  type MatcherKind,
  type NonExhaustivePatternError,
  type NumberMatcher,
  type Pattern,
  type PatternMatcher,
  type StringMatcher,
} from "./pattern-match.util";

// Recursive nested ternary struct
export {
  TERNARY_INSTANCE_SYMBOL,
  TERNARY_LEAF_SYMBOL,
  TERNARY_NODE_SYMBOL,
  TERNARY_RULE_SYMBOL,
  Ternary,
  TernaryRule,
  asyncBranch,
  branch,
  cond,
  evalTernary,
  evalTernaryAsync,
  isTernary,
  isTernaryLeaf,
  isTernaryNode,
  labeledTernary,
  literal,
  mapTernary,
  ternary,
  ternaryFor,
  ternaryRule,
  traceTernary,
  type AsyncTernaryBranch,
  type AsyncTernaryCondition,
  type AsyncTernaryNode,
  type CondPair,
  type EvalTernaryOptions,
  type SubjectBranch,
  type SubjectTernaryBuilder,
  type TernaryBranch,
  type TernaryChain,
  type TernaryCondition,
  type TernaryLeaf,
  type TernaryNode,
  type TernaryPending,
  type TernaryRuleBuilder,
  type TernaryTraceResult,
  type TernaryTraceStep,
  type UnwrapAsyncTernary,
  type UnwrapSubjectBranch,
  type UnwrapTernary,
} from "./ternary.util";

// Type guards
export {
  hasOwn,
  isAllDefined,
  isAllNullish,
  isAnyNull,
  isAnyNullish,
  isAnyUndefined,
  isArray,
  isBigInt,
  isBoolean,
  isDate,
  isDefined,
  isError,
  isFiniteNumber,
  isFunction,
  isInstanceOf,
  isInstanceof,
  isInteger,
  isMap,
  isNonEmptyArray,
  isNonEmptyString,
  isNotNull,
  isNotUndefined,
  isNull,
  isNullish,
  isNumber,
  isObject,
  isPlainObject,
  isPrimitive,
  isPromiseLike,
  isRegExp,
  isSet,
  isString,
  isSymbol,
  isTypeOf,
  isTypeof,
  isUndefined,
  isValidDate,
  type Constructor,
  type JsonArray,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Primitive,
  type TypeofMap,
  type TypeofTag,
} from "./type-guards.util";

// Predicate & membership combinators
export {
  and,
  include,
  includes,
  isEqual,
  isOneOf,
  not,
  or,
} from "./predicate.util";

// Object & nested path utilities
export {
  deepClone,
  deepEqual,
  deepFreeze,
  deepMerge,
  definedOnly,
  deleteNestedValue,
  entriesOf,
  filterObject,
  flattenObject,
  getNestedValue,
  hasNestedValue,
  invertObject,
  isEmptyObject,
  keysOf,
  mapValues,
  mergeDefined,
  omit,
  pick,
  pickDefined,
  setNestedValue,
  unflattenObject,
  valuesOf,
} from "./object.util";

// Collection utilities
export {
  chunk,
  compact,
  countBy,
  difference,
  first,
  groupBy,
  indexBy,
  intersection,
  isEmpty,
  isNotEmpty,
  last,
  partition,
  range,
  sortBy,
  sumBy,
  toArray,
  unique,
  uniqueBy,
  zip,
} from "./collection.util";

// String utilities
export {
  camelCase,
  capitalize,
  ensurePrefix,
  ensureSuffix,
  escapeHtml,
  escapeRegExp,
  kebabCase,
  maskSecret,
  pascalCase,
  slugify,
  snakeCase,
  splitOnce,
  stringWidth,
  stripAnsi,
  trimPrefix,
  trimSuffix,
  truncate,
  uncapitalize,
} from "./string.util";

// Number & Math utilities
export {
  average,
  clamp,
  inRange,
  maxBy,
  minBy,
  roundTo,
  safeDivide,
  sum,
  toInt,
  toNumber,
} from "./number.util";

// Async & Concurrency utilities
export {
  TimeoutError,
  allSettledPartition,
  debounce,
  deferred,
  isPromiseFulfilled,
  mapLimit,
  peekPromise,
  pollUntil,
  throttle,
  withTimeout,
  type DebouncedFn,
  type Deferred,
  type PollUntilOptions,
  type SettledPartition,
  type ThrottledFn,
} from "./async.util";

// JSON & Serialization utilities
export {
  parseJsonOr,
  safeJsonParse,
  safeJsonStringify,
  stableStringify,
} from "./json.util";

// Functional, Result, Option & Error-handling utilities
export {
  assertNever,
  ensureError,
  err,
  flatMapOption,
  flatMapResult,
  flow,
  fromNullable,
  identity,
  invariant,
  isErr,
  isNone,
  isOk,
  isSome,
  mapOption,
  mapResult,
  mapResultErr,
  matchResult,
  memoize,
  none,
  noop,
  ok,
  once,
  pipe,
  some,
  tap,
  tryCatch,
  tryCatchAsync,
  unwrapOptionOr,
  unwrapResult,
  unwrapResultOr,
  type Err,
  type MemoizeOptions,
  type MemoizedFn,
  type None,
  type Ok,
  type Option,
  type Result,
  type Some,
} from "./functional.util";

// Duration utilities
export {
  formatDuration,
  isDuration,
  parseDuration,
  type Duration,
  type DurationUnit,
} from "./duration.util";

// Retry & backoff utilities
export {
  computeBackoffDelay,
  parseRetryAfter,
  resolveBackoff,
  retry,
  sleep,
  type BackoffOptions,
  type BackoffStrategy,
  type JitterMode,
  type ResolvedBackoff,
  type RetryOptions,
} from "./retry.util";

// Error description & UTF-8 truncation utilities
export {
  describeError,
  describeValue,
  truncateUtf8,
} from "./error.util";

// UUID utilities
export { isValidUuid, uuidv4, uuidv7 } from "./uuid.util";

// Comparison & Ordering utilities
export {
  compareAsc,
  compareBy,
  compareDesc,
  composeComparators,
  isBetween,
  isGt,
  isGte,
  isLt,
  isLte,
  reverseComparator,
  type ComparableValue,
  type Comparator,
  type OrderDirection,
} from "./compare.util";

// Crypto & Security utilities
export {
  base64UrlDecode,
  base64UrlEncode,
  crc32,
  fastHash,
  hmacSha256,
  md5,
  randomHex,
  randomInt,
  randomIntRange,
  randomToken,
  sha256,
  sha512,
  timingSafeEqualBytes,
  timingSafeEqualStr,
  type HashEncoding,
} from "./crypto.util";

// Pure-TS Path, Assertion, Network & Runtime Info primitives
export {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  posixPath,
  relative,
  resolve,
  sep,
  win32Path,
  type PlatformPath,
} from "./path.util";
export {
  AssertionError,
  strictAssert,
  type AssertPredicate,
  type AssertionErrorOptions,
  type StrictAssert,
} from "./assert.util";
export { isIp, isIpv4, isIpv6 } from "./net.util";
export {
  getArch,
  getCpuCount,
  getHostname,
  getPlatform,
} from "./runtime-info.util";

// URL & HTTP Query utilities
export {
  buildQueryString,
  isSafeUrl,
  joinUrl,
  normalizeHeaders,
  normalizePath,
  parseQueryString,
  type QueryParamValue,
} from "./url.util";

// Environment & Config utilities
export {
  EnvError,
  envBool,
  envDuration,
  envEnum,
  envJson,
  envList,
  envNumber,
  envString,
  type EnvSource,
} from "./env.util";

// Concurrency primitives
export {
  BatchLoader,
  Mutex,
  Semaphore,
  Singleflight,
  coalesceAsync,
  type BatchLoaderOptions,
} from "./concurrency.util";

// Data structures
export {
  BiMap,
  LruCache,
  MultiMap,
  PriorityQueue,
  RingBuffer,
  type LruCacheOptions,
} from "./structures.util";

// Object diff, patch & redaction utilities
export {
  applyPatch,
  diffObjects,
  redactFields,
  type DiffEntry,
  type DiffKind,
  type RedactOptions,
} from "./diff.util";

// Date, time & injectable Clock utilities
export {
  addDuration,
  createFakeClock,
  diffMs,
  endOfDay,
  fromUnixSeconds,
  isExpired,
  isSameDay,
  startOfDay,
  subDuration,
  systemClock,
  toUnixSeconds,
  type Clock,
  type DateInput,
  type FakeClock,
} from "./date.util";

// Stream & AsyncIterable utilities
export {
  batchAsync,
  collectAsync,
  concatBytes,
  filterAsync,
  fromArrayAsync,
  mapAsync,
  mergeAsyncIterables,
  streamToBytes,
  streamToJson,
  streamToText,
  takeAsync,
} from "./stream.util";

// Type-level utilities
export type {
  Brand,
  DeepMutable,
  DeepPartial,
  DeepReadonly,
  DeepRequired,
  MaybePromise,
  Mutable,
  NonEmptyArray,
  Nullable,
  Nullish,
  PathOf,
  PathValue,
  Prettify,
  RequireAtLeastOne,
  RequireOnlyOne,
  StrictOmit,
  Unbrand,
  ValueOf,
} from "./types.util";
