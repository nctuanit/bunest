import {
  ClassSerializerInterceptor,
  Inject,
  Injectable,
  Logger,
  Optional,
  Reflector,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@bunest/core";
import { ApplicationConfig, HttpAdapterHost } from "@bunest/core";
import {
  Unreplayable,
  type Capture,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from "../contexts/context.adapter";
import { GraphqlContextAdapter } from "../contexts/graphql.context";
import { HttpContextAdapter } from "../contexts/http.context";
import { RpcContextAdapter } from "../contexts/rpc.context";
import { withDurationsInMs } from "../decorators/idempotent.decorator";
import { IdempotencyStoreTimeoutError } from "../errors/store-timeout.error";
import { UnreadableRecordError } from "../errors/unreadable-record.error";
import { UnreplayableResult } from "../errors/unreplayable-result.error";
import type { IdempotencyEvent } from "../events/idempotency-events.interface";
import { IdempotencyEvents } from "../events/idempotency-events.service";
import {
  DEFAULT_HEADER,
  DEFAULT_LOCK_TTL,
  DEFAULT_MAX_LOCK_HOLD,
  DEFAULT_REPLAY_HEADERS,
  DEFAULT_RETRY_AFTER,
  DEFAULT_STORE_TIMEOUT,
  DEFAULT_TTL,
  IDEMPOTENT_METADATA,
  MAX_KEY_LENGTH,
  NEVER_REPLAYED_HEADERS,
} from "../idempotency.constants";
import { IDEMPOTENCY_MODULE_OPTIONS } from "../idempotency.module-definition";
import type { IdempotencyModuleOptions } from "../interfaces/idempotency-module-options.interface";
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from "../interfaces/idempotency-store.interface";
import type {
  IdempotencyContextType,
  IdempotencyKeyFn,
  IdempotencyKeySource,
  IdempotencyKeySources,
  IdempotencyScopeFn,
  IdempotencyScopes,
  IdempotentOptions,
} from "../interfaces/idempotent-options.interface";
import { IdempotencyStorage } from "../storage/idempotency.storage";
import {
  plaintextCodec,
  ResponseCipher,
  type ResponseCodec,
} from "../utils/encryption.util";
import { canonicalJson, sha256 } from "../utils/fingerprint.util";

const INVALID_KEY = Symbol("invalid key");
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
/** The longest delay `setInterval()` and `setTimeout()` take; a longer one fires after 1 ms. */
const MAX_TIMEOUT = 2 ** 31 - 1;

interface ResolvedOptions {
  readonly required: boolean;
  readonly ttl: number;
  readonly lockTtl: number;
  readonly maxLockHold: number;
  readonly retryAfter: number;
  readonly storeIf: (status: number, error?: unknown) => boolean;
  readonly scope?: IdempotencyScopeFn | IdempotencyScopes | false;
  readonly fingerprint?: (payload: any, context: ExecutionContext) => unknown;
  readonly keyFrom?: IdempotencyKeySource | IdempotencyKeySources;
}

interface CallInfo {
  readonly adapter: IdempotencyContextAdapter;
  readonly context: ExecutionContext;
  readonly handler: string;
  readonly key: string;
  readonly scope?: string;
  readonly storeKey: string;
}

type Plan =
  | { readonly run: "passthrough" }
  | {
      readonly run: "replay";
      readonly call: CallInfo;
      readonly response: IdempotencyStoredResponse;
    }
  | {
      readonly run: "execute";
      readonly call: CallInfo;
      readonly owner: string;
    };

interface RenewalHandle {
  readonly lost: boolean;
  recording(): void;
  stop(): void;
}

@Injectable()
export class IdempotencyInterceptor
  implements BunestInterceptor, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger("IdempotencyModule");
  /** Handlers already warned about, per topic: each warning is logged once. */
  private readonly warned = new Map<string, WeakSet<Function>>();
  /** Locks being renewed, stopped at shutdown. */
  private readonly renewals = new Set<RenewalHandle>();
  private readonly defaults: IdempotencyModuleOptions;
  private readonly header: string;
  private readonly storeTimeout: number;
  private readonly adapters: Record<
    IdempotencyContextType,
    IdempotencyContextAdapter
  >;
  private readonly codec: ResponseCodec;

  constructor(
    @Inject(IDEMPOTENCY_MODULE_OPTIONS)
    options: IdempotencyModuleOptions,
    private readonly storage: IdempotencyStorage,
    private readonly events: IdempotencyEvents,
    private readonly reflector: Reflector,
    @Optional() adapterHost?: HttpAdapterHost,
    @Optional() private readonly appConfig?: ApplicationConfig,
  ) {
    // Everything that can be misconfigured fails here, at startup.
    assertOptions(options);
    this.defaults = withDurationsInMs(options, "IdempotencyModule");
    this.header = options.header ?? DEFAULT_HEADER;
    this.storeTimeout = Math.min(
      (this.defaults.storeTimeout as number | undefined) ??
        DEFAULT_STORE_TIMEOUT,
      MAX_TIMEOUT,
    );
    const replayHeaders = [
      ...new Set(
        [...DEFAULT_REPLAY_HEADERS, ...(options.replayHeaders ?? [])].map((h) =>
          h.toLowerCase(),
        ),
      ),
    ];
    assertReplayHeaders(replayHeaders);
    this.adapters = {
      http: new HttpContextAdapter(adapterHost, replayHeaders),
      graphql: new GraphqlContextAdapter(),
      rpc: new RpcContextAdapter(),
    };
    this.codec = options.encryption
      ? new ResponseCipher(options.encryption)
      : plaintextCodec;
  }

  /** The registered store (or the in-memory default), read per call: never in the constructor. */
  private get store(): IdempotencyStore {
    return this.storage.source;
  }

  /**
   * One store call, as a promise that rejects when the store throws
   * (synchronously too), and with `IdempotencyStoreTimeoutError` when it
   * doesn't answer within `storeTimeout`.
   */
  private async ask<T>(
    method: string,
    call: (store: IdempotencyStore) => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new IdempotencyStoreTimeoutError(method, this.storeTimeout)),
        this.storeTimeout,
      );
      timer.unref();
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => call(this.store)),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private releaseQuietly(key: string, owner: string): Promise<boolean> {
    return this.ask("release", (store) => store.release(key, owner));
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const classOptions = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      context.getClass(),
    );
    const handlerOptions = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      context.getHandler(),
    );
    if (!classOptions && !handlerOptions) {
      return next.handle();
    }

    const contextType = context.getType<string>();
    const adapter = this.adapters[contextType as IdempotencyContextType] as
      IdempotencyContextAdapter | undefined;
    if (!adapter) {
      this.warnOnce(
        context,
        "unsupported",
        `@Idempotent() has no effect on ${handlerName(context)}: ` +
          `"${contextType}" handlers are not supported (http, graphql and rpc are).`,
      );
      return next.handle();
    }

    // A class-level decorator doesn't reach GET routes, queries and the like.
    if (!handlerOptions && !adapter.coveredByClass(context)) {
      return next.handle();
    }

    const passThrough = adapter.passThrough?.(context);
    if (passThrough) {
      this.warnOnce(
        context,
        "pass-through",
        `@Idempotent() has no effect on ${handlerName(context)}: ${passThrough}.`,
      );
      return next.handle();
    }

    const opts = this.resolve(classOptions, handlerOptions);
    const plan = await this.plan(adapter, context, opts);
    switch (plan.run) {
      case "passthrough":
        return next.handle();
      case "replay":
        return plan.call.adapter.replay(plan.call.context, plan.response);
      case "execute":
        return this.execute(plan.call, plan.owner, next, opts);
    }
  }

  /**
   * Checks whether global interceptors registered before this one run outside it.
   * Rejects `ClassSerializerInterceptor` running outside `IdempotencyInterceptor`.
   */
  onApplicationBootstrap(): void {
    const globals = this.appConfig?.getGlobalInterceptors() ?? [];
    const position = globals.indexOf(this);
    if (position <= 0) {
      return;
    }
    const outside = globals.slice(0, position);
    const serializer = outside.find(
      (i) =>
        i instanceof ClassSerializerInterceptor ||
        i === ClassSerializerInterceptor,
    );
    if (serializer) {
      const serializerName =
        typeof serializer === "function"
          ? serializer.name
          : serializer.constructor.name;
      throw new Error(
        `IdempotencyModule: ${serializerName} runs outside IdempotencyInterceptor, ` +
          `because it was registered as a global interceptor first. A replay would hand it the ` +
          `stored plain object instead of the class instance, and send the fields @Exclude() ` +
          `hides. Register it with app.useGlobalInterceptors(), or as APP_INTERCEPTOR in a ` +
          `module imported after IdempotencyModule.`,
      );
    }
    const names = outside
      .map((i) => (typeof i === "function" ? i.name : i.constructor.name))
      .join(", ");
    this.logger.warn(
      `IdempotencyInterceptor runs inside ${names}, registered as global interceptors before ` +
        `it: replays pass through them too, with the stored copy of the result. To keep ` +
        `IdempotencyInterceptor outermost, register them with app.useGlobalInterceptors(), or ` +
        `in a module imported after IdempotencyModule.`,
    );
  }

  /**
   * In-flight calls that outlive the app stop renewing their locks, which
   * then expire after `lockTtl`, as after a crash.
   */
  onApplicationShutdown(): void {
    for (const renewal of this.renewals) {
      renewal.stop();
    }
  }

  private async plan(
    adapter: IdempotencyContextAdapter,
    context: ExecutionContext,
    opts: ResolvedOptions,
  ): Promise<Plan> {
    await adapter.prepare?.();
    const handler = handlerName(context);

    const reject = (
      rejection: IdempotencyRejection,
      call?: CallInfo,
    ): Error => {
      this.events.emit({
        type: "rejected",
        context: adapter.type,
        handler,
        code: rejection.code,
        status: rejection.status,
        ...(call && { key: call.key }),
        ...(call?.scope !== undefined && { scope: call.scope }),
      });
      return adapter.reject(context, rejection);
    };

    const key = normalizeKey(
      await this.readKey(adapter, context, opts.keyFrom),
    );
    if (key === INVALID_KEY) {
      throw reject({
        code: "IDEMPOTENCY_KEY_INVALID",
        status: 400,
        message: `The idempotency key must be 1 to ${MAX_KEY_LENGTH} printable ASCII characters.`,
      });
    }
    if (key === undefined) {
      if (!opts.required) {
        return { run: "passthrough" };
      }
      throw reject({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        status: 400,
        message: "An idempotency key is required for this operation.",
      });
    }

    const scopeFn = scopeFor(opts.scope, adapter.type);
    if (scopeFn === undefined) {
      this.warnIfUnscoped(adapter, context);
    }

    const { identity, payload } = await adapter.describe(context);
    if (!opts.fingerprint) {
      this.warnIfUnreadBody(adapter, context, payload);
    }

    const [rawScope, selected] = await Promise.all([
      scopeFn ? scopeFn(adapter.target(context), context) : undefined,
      opts.fingerprint ? opts.fingerprint(payload, context) : payload,
    ]);
    const scope = normalizeScope(rawScope, handler);

    // The scope is hashed in too: a record that turns up under another
    // user's key (copied in the store) is a 422, not a replay.
    const fingerprint = sha256(
      scope ?? "",
      ...identity,
      canonicalJson(selected),
    );
    const call: CallInfo = {
      adapter,
      context,
      handler,
      key,
      scope,
      storeKey: storeKey(scope, key, adapter.keySuffix?.(context)),
    };

    const owner = crypto.randomUUID();
    let acquired: IdempotencyAcquireResult;
    try {
      acquired = await this.ask("acquire", (store) =>
        store.acquire(call.storeKey, owner, fingerprint, opts.lockTtl),
      );
    } catch (err) {
      // The store may have taken the lock before its reply was lost. Releasing
      // it (it's owner-checked) spares the retry a wait of `lockTtl`.
      this.releaseQuietly(call.storeKey, owner).catch(() => {});
      throw err;
    }

    if (acquired.state === "acquired") {
      return { run: "execute", call, owner };
    }
    if (acquired.fingerprint !== fingerprint) {
      throw reject(
        {
          code: "IDEMPOTENCY_KEY_REUSED",
          status: 422,
          message:
            "This idempotency key was already used for a different request.",
        },
        call,
      );
    }
    if (acquired.state === "in-flight") {
      throw reject(
        {
          code: "IDEMPOTENCY_KEY_IN_USE",
          status: 409,
          message:
            "A request with this idempotency key is still being processed.",
          retryAfter: Math.ceil(opts.retryAfter / 1000),
        },
        call,
      );
    }

    let response: IdempotencyStoredResponse;
    try {
      response = await this.codec.open(call.storeKey, acquired.response);
    } catch (err) {
      if (!(err instanceof UnreadableRecordError)) {
        throw err;
      }
      // Fail closed: re-executing could repeat the side effect the record
      // proves already happened. The record expires with its ttl.
      this.logger.error(`${err.message} (key "${call.storeKey}")`);
      throw reject(
        {
          code: "IDEMPOTENCY_RECORD_UNREADABLE",
          status: 500,
          message:
            "The stored result for this idempotency key could not be read.",
        },
        call,
      );
    }

    this.emit(call, { type: "replayed", status: response.status });
    return { run: "replay", call, response };
  }

  /**
   * Runs the handler under the lock. The result is stored (or the key
   * released) before the caller gets it, so a retry that follows the
   * response always finds the record.
   */
  private async execute(
    call: CallInfo,
    owner: string,
    next: CallHandler,
    opts: ResolvedOptions,
  ): Promise<unknown> {
    const { adapter, context } = call;
    const renewal = this.renew(call, owner, opts);

    const outcomeOf = (
      capture: () => Capture,
    ): IdempotencyStoredResponse | undefined => {
      try {
        const captured = capture();
        if (captured instanceof Unreplayable) {
          this.warnUnreplayable(call, captured.reason);
          return undefined;
        }
        return captured ?? undefined;
      } catch (err) {
        if (err instanceof UnreplayableResult) {
          this.warnUnreplayable(call, err.message);
        } else {
          this.logger.error(
            `Could not capture the result for "${call.storeKey}"`,
            err,
          );
        }
        return undefined;
      }
    };

    try {
      const value = await next.handle();
      const outcome = outcomeOf(() =>
        adapter.captureSuccess(context, value, opts),
      );
      await this.record(call, owner, outcome, opts.ttl, renewal);
      return value;
    } catch (err) {
      const outcome = outcomeOf(() => adapter.captureError(err, opts));
      await this.record(call, owner, outcome, opts.ttl, renewal);
      throw err;
    }
  }

  private async record(
    call: CallInfo,
    owner: string,
    outcome: IdempotencyStoredResponse | undefined,
    ttl: number,
    renewal: RenewalHandle,
  ): Promise<void> {
    // Renewals go on until the store answers (or `storeTimeout` passes).
    renewal.recording();
    try {
      if (outcome) {
        const sealed = await this.codec.seal(call.storeKey, outcome);
        const ok = await this.ask("complete", (store) =>
          store.complete(call.storeKey, owner, sealed, ttl),
        );
        if (!ok && !renewal.lost) {
          this.lockLost(call, "complete", "the result was not stored");
        }
      } else {
        const ok = await this.releaseQuietly(call.storeKey, owner);
        if (!ok && !renewal.lost) {
          this.lockLost(call, "release", "the key was not released");
        }
      }
    } catch (err) {
      // The side effect already happened; failing the request now would
      // invite the exact retry we are trying to make safe.
      this.logger.error(`Idempotency store failed for "${call.storeKey}"`, err);
      if (!renewal.lost) {
        this.emit(call, {
          type: "lock-lost",
          phase: outcome ? "complete" : "release",
        });
      }
    } finally {
      renewal.stop();
    }
  }

  /**
   * Renews the lock every `lockTtl / 3`, one renewal at a time, until stopped
   * or `maxLockHold` elapses. Timers are `unref()`'d so they never keep the
   * process alive.
   */
  private renew(
    call: CallInfo,
    owner: string,
    { lockTtl, maxLockHold }: { lockTtl: number; maxLockHold: number },
  ): RenewalHandle {
    let stopped = false;
    let recording = false;
    let pending = false;
    let lost = false;

    const beat = async (): Promise<void> => {
      if (pending) {
        return;
      }
      pending = true;
      try {
        const ok = await this.ask("extend", (store) =>
          store.extend(call.storeKey, owner, lockTtl),
        );
        if (!ok) {
          if (!stopped && !recording) {
            lost = true;
            this.logger.warn(
              `Lost the lock for "${call.storeKey}" while the handler was running; ` +
                `a retry may run it again. Check the store's availability and lockTtl.`,
            );
            this.emit(call, { type: "lock-lost", phase: "extend" });
          }
          renewal.stop();
        }
      } catch (err) {
        if (!stopped) {
          this.logger.error(
            `Could not renew the lock for "${call.storeKey}"`,
            err,
          );
        }
      } finally {
        pending = false;
      }
    };

    const every = Math.min(Math.max(1, Math.floor(lockTtl / 3)), MAX_TIMEOUT);
    const timer = setInterval(() => void beat(), every);
    timer.unref();

    const ceiling = setTimeout(
      () => {
        this.logger.warn(
          `${call.handler} has held the lock for "${call.storeKey}" for maxLockHold ` +
            `(${maxLockHold} ms) without finishing, so the lock is no longer renewed: it expires ` +
            `after lockTtl, and a retry may then run the handler again.`,
        );
        renewal.stop();
      },
      Math.min(maxLockHold, MAX_TIMEOUT),
    );
    ceiling.unref();

    const renewal: RenewalHandle = {
      get lost() {
        return lost;
      },
      recording: () => {
        recording = true;
        clearTimeout(ceiling);
      },
      stop: () => {
        stopped = true;
        clearInterval(timer);
        clearTimeout(ceiling);
        this.renewals.delete(renewal);
      },
    };
    this.renewals.add(renewal);
    return renewal;
  }

  private lockLost(
    call: CallInfo,
    phase: "complete" | "release",
    outcome: string,
  ): void {
    this.logger.warn(
      `Lock for "${call.storeKey}" expired before the handler finished; ${outcome}. ` +
        `The lock is renewed while the handler runs, so this means renewals ` +
        `failed (store unavailable, blocked event loop) or lockTtl is too short.`,
    );
    this.emit(call, { type: "lock-lost", phase });
  }

  private emit(
    call: CallInfo,
    event:
      | { type: "replayed"; status: number }
      | { type: "lock-lost"; phase: "extend" | "complete" | "release" },
  ): void {
    const full: IdempotencyEvent = {
      ...event,
      context: call.adapter.type,
      handler: call.handler,
      key: call.key,
      ...(call.scope !== undefined && { scope: call.scope }),
    };
    this.events.emit(full);
  }

  private warnIfUnscoped(
    adapter: IdempotencyContextAdapter,
    context: ExecutionContext,
  ): void {
    const user = adapter.userLocation(context);
    if (!user) {
      return;
    }
    const example =
      adapter.type === "rpc"
        ? "`scope: { rpc: (payload, context) => ... }`"
        : "`scope: (req) => req.user.id`";
    this.warnOnce(
      context,
      "unscoped",
      `${handlerName(context)} was called by a signed-in user (${user} is set), but no ` +
        `\`scope\` applies to ${adapter.type} calls, so all users share one key namespace: ` +
        `a request that reuses another user's key gets that user's stored response. ` +
        `Set \`scope\`, for example ${example}, or \`scope: false\` if keys are unique ` +
        `across users on purpose.`,
    );
  }

  private warnIfUnreadBody(
    adapter: IdempotencyContextAdapter,
    context: ExecutionContext,
    payload: unknown,
  ): void {
    const type = adapter.unreadBody?.(context, payload);
    if (!type) {
      return;
    }
    this.warnOnce(
      context,
      "unread-body",
      `${handlerName(context)} received a body (${type}) that no parser had read when the ` +
        `idempotency key was checked, so the fingerprint doesn't cover it: a key reused with ` +
        `other content gets the stored response. Set \`fingerprint\` to read what a retry ` +
        `must repeat from the request, for example a hash of the field values and file bytes ` +
        `that the client sends in a header.`,
    );
  }

  private warnUnreplayable(call: CallInfo, reason: string): void {
    this.warnOnce(
      call.context,
      "unreplayable",
      `${call.handler} ran with an idempotency key, but ${reason}, so its result is not ` +
        `stored: the key was released, and a retry runs the handler again.`,
    );
  }

  private warnOnce(
    context: ExecutionContext,
    topic: string,
    message: string,
  ): void {
    let handlers = this.warned.get(topic);
    if (!handlers) {
      handlers = new WeakSet();
      this.warned.set(topic, handlers);
    }
    const handler = context.getHandler();
    if (handlers.has(handler)) {
      return;
    }
    handlers.add(handler);
    this.logger.warn(message);
  }

  private readKey(
    adapter: IdempotencyContextAdapter,
    context: ExecutionContext,
    keyFrom: IdempotencyKeySource | IdempotencyKeySources | undefined,
  ): unknown {
    const source = sourceFor(keyFrom, adapter.type);
    if (typeof source === "function") {
      return source(context);
    }
    return adapter.readKey(
      context,
      (source ?? "default") as DeclarativeKeySource,
      this.header,
    );
  }

  private resolve(
    classOptions?: IdempotentOptions,
    handlerOptions?: IdempotentOptions,
  ): ResolvedOptions {
    const merged: Record<string, unknown> = {
      ...definedOnly(this.defaults),
      ...definedOnly(classOptions),
      ...definedOnly(handlerOptions),
    };
    return {
      required: (merged.required as boolean | undefined) ?? false,
      ttl: (merged.ttl as number | undefined) ?? DEFAULT_TTL,
      lockTtl: (merged.lockTtl as number | undefined) ?? DEFAULT_LOCK_TTL,
      maxLockHold:
        (merged.maxLockHold as number | undefined) ?? DEFAULT_MAX_LOCK_HOLD,
      retryAfter:
        (merged.retryAfter as number | undefined) ?? DEFAULT_RETRY_AFTER,
      storeIf:
        (merged.storeIf as
          ((status: number, error?: unknown) => boolean) | undefined) ??
        ((status) => status < 500),
      scope: merged.scope as ResolvedOptions["scope"],
      fingerprint: merged.fingerprint as ResolvedOptions["fingerprint"],
      keyFrom: merged.keyFrom as ResolvedOptions["keyFrom"],
    };
  }
}

function handlerName(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`;
}

/** The key source for one context: a single source, or that context's entry. */
function sourceFor(
  keyFrom: IdempotencyKeySource | IdempotencyKeySources | undefined,
  type: IdempotencyContextType,
): IdempotencyKeySource | IdempotencyKeyFn | undefined {
  if (!keyFrom || typeof keyFrom === "function") {
    return keyFrom;
  }
  if ("header" in keyFrom || "arg" in keyFrom || "payload" in keyFrom) {
    return keyFrom as IdempotencyKeySource;
  }
  return (keyFrom as IdempotencyKeySources)[type];
}

/** The scope function for one context: `false` when unscoped on purpose, `undefined` when not configured. */
function scopeFor(
  scope: IdempotencyScopeFn | IdempotencyScopes | false | undefined,
  type: IdempotencyContextType,
): IdempotencyScopeFn | false | undefined {
  if (scope === undefined || scope === false || typeof scope === "function") {
    return scope;
  }
  return scope[type];
}

/**
 * A key is 1 to 255 printable ASCII characters, so it can't smuggle control
 * characters into logs and events. A number is taken as its digits; anything
 * else is invalid.
 */
function normalizeKey(raw: unknown): string | undefined | typeof INVALID_KEY {
  if (Array.isArray(raw)) {
    raw = raw[0];
  }
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    (typeof raw === "number" && Number.isFinite(raw)) ||
    typeof raw === "bigint"
  ) {
    raw = String(raw);
  }
  if (typeof raw !== "string") {
    return INVALID_KEY;
  }
  // Accept RFC 8941 sf-string ("...") as well as bare tokens.
  const key = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!key) {
    return undefined;
  }
  return key.length <= MAX_KEY_LENGTH && PRINTABLE_ASCII.test(key)
    ? key
    : INVALID_KEY;
}

/**
 * Numeric user ids are common; `null` and '' mean "no scope". Anything else
 * fails the call instead of collapsing callers into "[object Object]".
 */
function normalizeScope(raw: unknown, handler: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (
    (typeof raw === "number" && Number.isFinite(raw)) ||
    typeof raw === "bigint"
  ) {
    return String(raw);
  }
  const what =
    typeof raw === "number"
      ? String(raw)
      : typeof raw === "object"
        ? "an object"
        : `a ${typeof raw}`;
  throw new TypeError(
    `IdempotencyModule: \`scope\` returned ${what} for ${handler}. Return a string or a ` +
      `number that identifies the caller, such as the user's id: \`scope: (req) => req.user.id\`.`,
  );
}

/**
 * `[scope:]key[:suffix]`, each part URI-encoded so a `:` inside a client
 * key can't make an unscoped key look like a scoped one.
 */
function storeKey(
  scope: string | undefined,
  key: string,
  suffix: string | undefined,
): string {
  return [scope || undefined, key, suffix || undefined]
    .filter((part): part is string => part !== undefined)
    .map(encodeURIComponent)
    .join(":");
}

/**
 * What `forRoot()`'s types rule out, but a `forRootAsync()` factory (or
 * JavaScript) can still get wrong.
 */
function assertOptions(
  options: unknown,
): asserts options is IdempotencyModuleOptions {
  if (options === null || typeof options !== "object") {
    const what =
      options === null
        ? "null"
        : options === undefined
          ? "undefined"
          : `a ${typeof options}`;
    throw new TypeError(
      `IdempotencyModule: the options factory returned ${what}; return an object (\`{}\` for the defaults).`,
    );
  }
  for (const extra of ["isGlobal", "imports"]) {
    if (extra in options) {
      throw new TypeError(
        `IdempotencyModule: pass \`${extra}\` to forRootAsync() next to useFactory, ` +
          `not in the object the factory returns.`,
      );
    }
  }
  if ("store" in options) {
    throw new TypeError(
      "IdempotencyModule: `store` is not a module option. Register the store instead: a " +
        "provider that implements IdempotencyStore, injects IdempotencyStorage and calls " +
        "`storage.registerSource(this)` in its constructor.",
    );
  }
}

function assertReplayHeaders(headers: readonly string[]): void {
  for (const header of headers) {
    if (NEVER_REPLAYED_HEADERS.has(header)) {
      const why =
        header === "set-cookie"
          ? "cookies belong to the response that set them"
          : "the platform writes it for every response";
      throw new TypeError(
        `IdempotencyModule: \`replayHeaders\` can't include "${header}": ${why}.`,
      );
    }
  }
}

/** Drops `undefined` values, so `{ ttl: undefined }` doesn't erase a default. */
function definedOnly(options: object | undefined): Record<string, unknown> {
  if (!options) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
}
