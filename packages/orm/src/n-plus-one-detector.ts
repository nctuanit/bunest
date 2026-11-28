import {
  ContextStorage,
  Logger,
  diagnosticsChannel,
  getCurrentRequestContext,
} from "@bunest/core";
import {
  ORM_QUERY_CHANNEL,
  type OrmQueryDiagnosticEvent,
} from "./diagnostics";
import { OrmError } from "./errors";

export interface NPlusOneDetectionEvent {
  readonly fingerprint: string;
  readonly sampleSql: string;
  readonly count: number;
  readonly threshold: number;
  readonly dataSource?: string;
}

export interface NPlusOneDetectorOptions {
  /**
   * Minimum number of identical normalized SQL queries within a single request/scope
   * before flagging as a potential N+1 query.
   * @default 5
   */
  readonly threshold?: number;
  /**
   * Fallback sliding window (ms) used when queries execute outside an active
   * HTTP `RequestContext` or `withNPlusOneDetection()` scope.
   * @default 2000
   */
  readonly windowMs?: number;
  /**
   * When `true`, throws `OrmNPlusOneError` immediately upon crossing `threshold`
   * (ideal for CI and unit/integration tests). When `false`, logs a warning.
   * @default false
   */
  readonly strict?: boolean;
  /**
   * Optional custom callback invoked whenever a fingerprint crosses `threshold`.
   */
  readonly onDetect?: (event: NPlusOneDetectionEvent) => void;
  /**
   * Additional SQL regex patterns to ignore (combined with built-in transaction/ping ignores).
   */
  readonly ignorePatterns?: readonly RegExp[];
  /**
   * Optional DataSource name filter. When set, ignores queries from other DataSources.
   */
  readonly dataSourceName?: string;
  /**
   * Maximum number of detection events retained in memory for `getDetections()`.
   * Prevents unbounded memory growth on long-running servers.
   * @default 500
   */
  readonly maxDetections?: number;
}

export interface NPlusOneDetectorHandle {
  stop(): void;
  getDetections(): readonly NPlusOneDetectionEvent[];
  reset(): void;
}

export class OrmNPlusOneError extends OrmError {
  readonly fingerprint: string;
  readonly sampleSql: string;
  readonly count: number;
  readonly threshold: number;
  readonly dataSource?: string;

  constructor(event: NPlusOneDetectionEvent) {
    super(
      `[BunestORM] Potential N+1 query detected (executed ${event.count}x, threshold ${event.threshold}): ${event.fingerprint} — Fix: eager-load via \`relations: [...]\`, batch with \`In([...])\`, or use GraphQL \`@Loader()\`.`,
    );
    this.fingerprint = event.fingerprint;
    this.sampleSql = event.sampleSql;
    this.count = event.count;
    this.threshold = event.threshold;
    this.dataSource = event.dataSource;
  }
}

const DEFAULT_IGNORE_PATTERNS: readonly RegExp[] = [
  /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|PRAGMA)\b/i,
  /^\s*SELECT\s+1\b/i,
];

/**
 * Normalizes a SQL statement into a structural fingerprint by stripping SQL comments,
 * replacing string literals, numeric literals (including negative numbers),
 * positional parameters (`$1`, `?1`, `?`), and `IN (...)` parameter lists.
 */
export function normalizeSqlFingerprint(sql: string): string {
  // Single pass over string literals and SQL comments so comment markers inside
  // string literals (e.g. 'http://a/*b*/--c') are preserved as string literals
  // while actual comments are stripped BEFORE whitespace collapsing.
  return sql
    .replace(
      /'(?:''|\\'|[^'])*'|\/\*[\s\S]*?\*\/|--[^\r\n]*/g,
      (match) => (match.startsWith("'") ? "?" : " "),
    )
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\$\d+|\?\d+/g, "?")
    .replace(/(?<![\w$])-?\d+(?:\.\d+)?\b/g, "?")
    .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)");
}

interface ScopeTracker {
  readonly counts: Map<string, number>;
  readonly alerted: Set<string>;
}

const explicitDetectionScope = new ContextStorage<ScopeTracker>();
const detectorLogger = new Logger("OrmNPlusOneDetector");

/**
 * Subscribes to `"bunest:orm:query"` (`ORM_QUERY_CHANNEL`) and detects repeated
 * identical normalized SQL queries within an HTTP request, `withNPlusOneDetection()` scope,
 * or fallback sliding time window.
 */
export function createNPlusOneDetector(
  options: NPlusOneDetectorOptions = {},
): NPlusOneDetectorHandle {
  const threshold = Math.max(2, Math.floor(options.threshold ?? 5));
  const windowMs = Math.max(50, Math.floor(options.windowMs ?? 2_000));
  const maxDetections = Math.max(0, Math.floor(options.maxDetections ?? 500));
  const strict = options.strict === true;
  const ignorePatterns = [
    ...DEFAULT_IGNORE_PATTERNS,
    ...(options.ignorePatterns ?? []).map((pattern) =>
      pattern.global || pattern.sticky
        ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
        : pattern,
    ),
  ];

  let requestScopes = new WeakMap<object, ScopeTracker>();
  let fallbackWindowStart = Date.now();
  let fallbackTracker: ScopeTracker = {
    counts: new Map(),
    alerted: new Set(),
  };

  const detections: NPlusOneDetectionEvent[] = [];

  const getTracker = (): ScopeTracker => {
    const explicit = explicitDetectionScope.getStore();
    if (explicit) return explicit;

    const reqCtx = getCurrentRequestContext();
    if (reqCtx) {
      let tracker = requestScopes.get(reqCtx);
      if (!tracker) {
        tracker = { counts: new Map(), alerted: new Set() };
        requestScopes.set(reqCtx, tracker);
      }
      return tracker;
    }

    const now = Date.now();
    if (now - fallbackWindowStart > windowMs) {
      fallbackWindowStart = now;
      fallbackTracker = { counts: new Map(), alerted: new Set() };
    }
    return fallbackTracker;
  };

  const onQuery = (raw: unknown): void => {
    const event = raw as OrmQueryDiagnosticEvent | undefined;
    if (!event || typeof event.sql !== "string") return;
    if (
      options.dataSourceName !== undefined &&
      event.dataSource !== options.dataSourceName
    ) {
      return;
    }
    for (let i = 0; i < ignorePatterns.length; i++) {
      if (ignorePatterns[i]!.test(event.sql)) return;
    }

    const fingerprint = normalizeSqlFingerprint(event.sql);
    const tracker = getTracker();
    const nextCount = (tracker.counts.get(fingerprint) ?? 0) + 1;
    tracker.counts.set(fingerprint, nextCount);

    if (nextCount >= threshold && !tracker.alerted.has(fingerprint)) {
      tracker.alerted.add(fingerprint);
      const detection: NPlusOneDetectionEvent = {
        fingerprint,
        sampleSql: event.sql,
        count: nextCount,
        threshold,
        dataSource: event.dataSource,
      };
      if (maxDetections > 0) {
        if (detections.length >= maxDetections) {
          detections.shift();
        }
        detections.push(detection);
      }

      if (options.onDetect) {
        options.onDetect(detection);
      } else if (!strict) {
        detectorLogger.warn(
          `Potential N+1 query detected (${nextCount}x, threshold ${threshold}): ${fingerprint} — consider eager \`relations: [...]\`, \`In([...])\`, or GraphQL \`@Loader()\`.`,
        );
      }

      if (strict) {
        throw new OrmNPlusOneError(detection);
      }
    }
  };

  const channel = diagnosticsChannel(ORM_QUERY_CHANNEL);
  channel.subscribe(onQuery);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      channel.unsubscribe(onQuery);
    },
    getDetections(): readonly NPlusOneDetectionEvent[] {
      return [...detections];
    },
    reset(): void {
      detections.length = 0;
      requestScopes = new WeakMap<object, ScopeTracker>();
      fallbackWindowStart = Date.now();
      fallbackTracker = { counts: new Map(), alerted: new Set() };
    },
  };
}

/**
 * Runs an async (or sync) operation inside an isolated N+1 detection scope.
 * Ideal for asserting zero N+1 queries in unit and integration tests.
 */
export async function withNPlusOneDetection<T>(
  fn: () => T | Promise<T>,
  options: NPlusOneDetectorOptions = {},
): Promise<{
  readonly result: T;
  readonly detections: readonly NPlusOneDetectionEvent[];
}> {
  const tracker: ScopeTracker = {
    counts: new Map(),
    alerted: new Set(),
  };
  // Collect detections inside the scope and throw unwrapped `OrmNPlusOneError`
  // after `fn()` settles (avoiding driver `QueryFailedError` wrapping during telemetry).
  const detector = createNPlusOneDetector({
    ...options,
    strict: false,
    onDetect: options.onDetect ?? (() => {}),
  });
  try {
    const result = await explicitDetectionScope.run(tracker, fn);
    const detections = detector.getDetections();
    if (options.strict === true && detections.length > 0) {
      throw new OrmNPlusOneError(detections[0]!);
    }
    return {
      result,
      detections,
    };
  } finally {
    detector.stop();
  }
}
