import {
  Injectable,
  Logger,
  Optional,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
} from "@bunest/core";
import { getCurrentRequestContext } from "@bunest/core/http";
import { MemoryThrottlerStorage } from "./memory-throttler.storage";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
} from "./throttler.decorators";
import { ThrottlerException, throttlerMessage } from "./throttler.exception";
import {
  SKIP_THROTTLE_METADATA,
  THROTTLE_METADATA,
  isThrottlerOptionsArray,
  type Resolvable,
  type ThrottleDecoratorConfig,
  type ThrottleOverride,
  type ThrottlerGenerateKeyFunction,
  type ThrottlerGetTrackerFunction,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from "./throttler.interface";
import { DEFAULT_IPV6_SUBNET_PREFIX, normalizeIp } from "./throttler.utils";

function isDirectThrottleConfig(cfg: ThrottleDecoratorConfig): cfg is {
  ttl: Resolvable<number>;
  limit: Resolvable<number>;
  blockDuration?: Resolvable<number>;
  getTracker?: ThrottlerGetTrackerFunction;
  generateKey?: ThrottlerGenerateKeyFunction;
} {
  const c = cfg as { ttl?: unknown; limit?: unknown };
  return (
    (typeof c.ttl === "number" || typeof c.ttl === "function") &&
    (typeof c.limit === "number" || typeof c.limit === "function")
  );
}

function readHeader(
  req: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const headers = req.headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  if (
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    return (
      (headers as { get: (n: string) => string | null }).get(name) ?? undefined
    );
  }
  const map = headers as Record<string, unknown>;
  const val = map[name] ?? map[name.toLowerCase()];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return undefined;
}

interface PrimaryHeaderState {
  limit: number;
  remaining: number;
  resetEpochSec: number;
}

/**
 * Rate-limiting guard enforcing configured throttler rules, setting standard
 * `X-RateLimit-*` / `Retry-After` headers, normalizing IPv6 `/64` subnets,
 * and exposing protected subclassing hooks compatible with `@nestjs/throttler`.
 */
@Injectable()
export class ThrottlerGuard implements CanActivate, OnModuleInit {
  protected readonly options: ThrottlerModuleOptions;
  protected readonly storageService: ThrottlerStorage;
  protected readonly reflector: Reflector;
  protected headerPrefix = "X-RateLimit";
  protected logger = new Logger(ThrottlerGuard.name);
  protected errorMessage: string = throttlerMessage;
  protected throttlers: ThrottlerOptions[];
  protected commonOptions: Pick<
    ThrottlerOptions,
    "skipIf" | "ignoreUserAgents" | "getTracker" | "generateKey" | "setHeaders"
  >;
  protected ipv6SubnetPrefix: number = DEFAULT_IPV6_SUBNET_PREFIX;

  private readonly activeHeaderStates = new WeakMap<
    ExecutionContext,
    {
      primary?: PrimaryHeaderState;
      hasDefault: boolean;
      setHeaders: boolean;
    }
  >();

  constructor(
    @Optional()
    @InjectThrottlerOptions()
    options: ThrottlerModuleOptions = {
      throttlers: [{ name: "default", ttl: 60_000, limit: 60 }],
    },
    @Optional()
    @InjectThrottlerStorage()
    storageService?: ThrottlerStorage,
    @Optional()
    reflector: Reflector = new Reflector(),
  ) {
    this.options = options;
    this.storageService =
      storageService ??
      (!isThrottlerOptionsArray(options) ? options.storage : undefined) ??
      new MemoryThrottlerStorage();
    this.reflector = reflector;
  }

  async onModuleInit(): Promise<void> {
    const rawThrottlers = isThrottlerOptionsArray(this.options)
      ? [...this.options]
      : [...(this.options.throttlers ?? [])];

    let defaultAssigned = false;
    this.throttlers = rawThrottlers
      .map((opt, idx) => ({
        ...opt,
        name:
          opt.name ??
          (!defaultAssigned
            ? ((defaultAssigned = true), "default")
            : `rule_${idx}`),
      }))
      .sort((first, second) => {
        if (typeof first.ttl === "function") {
          return typeof second.ttl === "function" ? 0 : 1;
        }
        if (typeof second.ttl === "function") {
          return -1;
        }
        return first.ttl - second.ttl;
      });

    if (this.throttlers.length === 0) {
      this.logger.warn(
        "No throttlers are configured, so no request is limited.",
      );
    }

    if (isThrottlerOptionsArray(this.options)) {
      this.commonOptions = {};
      this.ipv6SubnetPrefix = DEFAULT_IPV6_SUBNET_PREFIX;
    } else {
      this.commonOptions = {
        skipIf: this.options.skipIf,
        ignoreUserAgents: this.options.ignoreUserAgents,
        getTracker: this.options.getTracker,
        generateKey: this.options.generateKey,
        setHeaders: this.options.setHeaders,
      };
      this.ipv6SubnetPrefix =
        this.options.ipv6SubnetPrefix ?? DEFAULT_IPV6_SUBNET_PREFIX;
    }

    this.commonOptions.getTracker ??= this.getTracker.bind(this);
    this.commonOptions.generateKey ??= this.generateKey.bind(this);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.throttlers) {
      await this.onModuleInit();
    }

    const handler = context.getHandler();
    const classRef = context.getClass();

    if (await this.shouldSkip(context)) {
      return true;
    }

    const skipMeta = this.reflector.getAllAndOverride<
      boolean | Record<string, boolean>
    >(SKIP_THROTTLE_METADATA, [handler, classRef]);

    if (skipMeta === true) {
      return true;
    }

    if (this.throttlers.length === 0) {
      return true;
    }

    const throttleMeta =
      this.reflector.getAllAndOverride<ThrottleDecoratorConfig>(
        THROTTLE_METADATA,
        [handler, classRef],
      );

    const state: {
      primary?: PrimaryHeaderState;
      hasDefault: boolean;
      setHeaders: boolean;
    } = {
      hasDefault: false,
      setHeaders: this.commonOptions.setHeaders ?? true,
    };
    this.activeHeaderStates.set(context, state);

    const continues: boolean[] = [];

    try {
      for (const namedThrottler of this.throttlers) {
        const throttlerName = namedThrottler.name ?? "default";
        if (
          typeof skipMeta === "object" &&
          skipMeta !== null &&
          skipMeta[throttlerName] === true
        ) {
          continues.push(true);
          continue;
        }

        const skipIf = namedThrottler.skipIf ?? this.commonOptions.skipIf;
        if (skipIf && (await this.resolveValue(context, skipIf))) {
          continues.push(true);
          continue;
        }

        const override = this.extractOverrideForThrottler(
          throttlerName,
          throttleMeta,
        );

        const limit = this.toNumber(
          await this.resolveValue(
            context,
            override?.limit ?? namedThrottler.limit,
          ),
          "limit",
          throttlerName,
        );
        const ttl = this.toNumber(
          await this.resolveValue(context, override?.ttl ?? namedThrottler.ttl),
          "ttl",
          throttlerName,
        );
        const rawBlockDuration =
          override?.blockDuration ?? namedThrottler.blockDuration;
        const blockDuration =
          rawBlockDuration !== undefined
            ? this.toNumber(
                await this.resolveValue(context, rawBlockDuration),
                "blockDuration",
                throttlerName,
              )
            : 0;

        const getTracker: ThrottlerGetTrackerFunction =
          override?.getTracker ??
          namedThrottler.getTracker ??
          this.commonOptions.getTracker ??
          this.getTracker.bind(this);
        const generateKey: ThrottlerGenerateKeyFunction =
          override?.generateKey ??
          namedThrottler.generateKey ??
          this.commonOptions.generateKey ??
          this.generateKey.bind(this);

        continues.push(
          await this.handleRequest({
            context,
            limit,
            ttl,
            throttler: namedThrottler,
            blockDuration,
            getTracker,
            generateKey,
          }),
        );
      }

      if (!state.hasDefault && state.primary) {
        const { res } = this.getRequestResponse(context);
        this.setResponseHeader(
          res,
          `${this.headerPrefix}-Limit`,
          state.primary.limit,
        );
        this.setResponseHeader(
          res,
          `${this.headerPrefix}-Remaining`,
          state.primary.remaining,
        );
        this.setResponseHeader(
          res,
          `${this.headerPrefix}-Reset`,
          state.primary.resetEpochSec,
        );
      }
    } finally {
      this.activeHeaderStates.delete(context);
    }

    return continues.every(Boolean);
  }

  protected async shouldSkip(_context: ExecutionContext): Promise<boolean> {
    return false;
  }

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const {
      context,
      limit,
      ttl,
      throttler,
      blockDuration,
      getTracker,
      generateKey,
    } = requestProps;
    const { req, res } = this.getRequestResponse(context);

    const ignoreUserAgents =
      throttler.ignoreUserAgents ?? this.commonOptions?.ignoreUserAgents;
    if (Array.isArray(ignoreUserAgents)) {
      const userAgent = readHeader(req, "user-agent") ?? "";
      for (const pattern of ignoreUserAgents) {
        pattern.lastIndex = 0;
        if (pattern.test(userAgent)) {
          return true;
        }
      }
    }

    const throttlerName = throttler.name ?? "default";
    const tracker = await getTracker(req, context);
    const key = generateKey(context, tracker, throttlerName);
    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
      await this.storageService.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );

    const suffix = throttlerName === "default" ? "" : `-${throttlerName}`;
    const setHeaders =
      throttler.setHeaders ?? this.commonOptions?.setHeaders ?? true;

    const remaining = Math.max(0, limit - totalHits);
    const resetSec = Math.max(0, isBlocked ? timeToBlockExpire : timeToExpire);
    const resetEpochSec = Math.ceil(Date.now() / 1000) + Math.ceil(resetSec);
    const retryAfterSec = Math.max(1, Math.ceil(resetSec));

    const headerState = this.activeHeaderStates.get(context);

    if (isBlocked || totalHits > limit) {
      if (setHeaders) {
        this.setResponseHeader(
          res,
          `${this.headerPrefix}-Limit${suffix}`,
          limit,
        );
        this.setResponseHeader(
          res,
          `${this.headerPrefix}-Remaining${suffix}`,
          0,
        );
        this.setResponseHeader(
          res,
          `${this.headerPrefix}-Reset${suffix}`,
          resetEpochSec,
        );
        this.setResponseHeader(res, `Retry-After${suffix}`, retryAfterSec);
        if (suffix) {
          this.setResponseHeader(res, "Retry-After", retryAfterSec);
        }
      }

      if (headerState) {
        headerState.setHeaders = setHeaders;
      }

      await this.throwThrottlingException(context, {
        limit,
        ttl,
        key,
        tracker,
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire,
      });
    }

    if (setHeaders) {
      this.setResponseHeader(
        res,
        `${this.headerPrefix}-Limit${suffix}`,
        limit,
      );
      this.setResponseHeader(
        res,
        `${this.headerPrefix}-Remaining${suffix}`,
        remaining,
      );
      this.setResponseHeader(
        res,
        `${this.headerPrefix}-Reset${suffix}`,
        resetEpochSec,
      );

      if (headerState) {
        if (!suffix) {
          headerState.hasDefault = true;
        } else if (
          !headerState.primary ||
          remaining < headerState.primary.remaining
        ) {
          headerState.primary = {
            limit,
            remaining,
            resetEpochSec,
          };
        }
      }
    }

    return true;
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    if (
      req &&
      typeof req.ip === "string" &&
      req.ip.length > 0 &&
      req.ip !== "unknown"
    ) {
      return normalizeIp(req.ip, this.ipv6SubnetPrefix);
    }

    const ctx = getCurrentRequestContext();
    if (ctx?.ip && ctx.ip !== "unknown") {
      return normalizeIp(ctx.ip, this.ipv6SubnetPrefix);
    }

    const forwarded = readHeader(req, "x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) {
        return normalizeIp(first, this.ipv6SubnetPrefix);
      }
    }

    const realIp = readHeader(req, "x-real-ip")?.trim();
    if (realIp) {
      return normalizeIp(realIp, this.ipv6SubnetPrefix);
    }

    return "127.0.0.1";
  }

  protected setResponseHeader(
    res: Record<string, unknown>,
    name: string,
    value: string | number,
  ): void {
    if (!res || typeof res !== "object") {
      return;
    }
    if (typeof res.header === "function") {
      (res.header as (n: string, v: string) => void)(name, String(value));
    } else if (typeof res.setHeader === "function") {
      (res.setHeader as (n: string, v: string | number) => void)(name, value);
    } else if (
      res.headers &&
      typeof res.headers === "object" &&
      typeof (res.headers as { set?: unknown }).set === "function"
    ) {
      (res.headers as { set: (n: string, v: string) => void }).set(
        name,
        String(value),
      );
    }
  }

  protected getRequestResponse(context: ExecutionContext): {
    req: Record<string, unknown>;
    res: Record<string, unknown>;
  } {
    const http = context.switchToHttp();
    return {
      req: http.getRequest<Record<string, unknown>>(),
      res: http.getResponse<Record<string, unknown>>(),
    };
  }

  protected generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    const controllerName = context.getClass()?.name || "Controller";
    const handlerName =
      String(context.getHandlerKey?.() ?? context.getHandler()?.name) ||
      "handler";
    return `${name}:${controllerName}:${handlerName}:${suffix}`;
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const message = await this.getErrorMessage(context, throttlerLimitDetail);
    const setHeaders =
      this.activeHeaderStates.get(context)?.setHeaders ??
      this.commonOptions?.setHeaders ??
      true;

    const resetSec = Math.max(
      0,
      throttlerLimitDetail.isBlocked
        ? throttlerLimitDetail.timeToBlockExpire
        : throttlerLimitDetail.timeToExpire,
    );
    const resetEpochSec = Math.ceil(Date.now() / 1000) + Math.ceil(resetSec);
    const retryAfterSec = Math.max(1, Math.ceil(resetSec));

    throw new ThrottlerException(message, {
      headers: setHeaders
        ? {
            [`${this.headerPrefix}-Limit`]: String(throttlerLimitDetail.limit),
            [`${this.headerPrefix}-Remaining`]: "0",
            [`${this.headerPrefix}-Reset`]: String(resetEpochSec),
            "Retry-After": String(retryAfterSec),
          }
        : undefined,
    });
  }

  protected async getErrorMessage(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<string> {
    if (!isThrottlerOptionsArray(this.options) && this.options.errorMessage) {
      return typeof this.options.errorMessage === "function"
        ? this.options.errorMessage(context, throttlerLimitDetail)
        : this.options.errorMessage;
    }
    return this.errorMessage;
  }

  private extractOverrideForThrottler(
    ruleName: string,
    override: ThrottleDecoratorConfig | undefined,
  ): ThrottleOverride | undefined {
    if (!override) {
      return undefined;
    }
    if (isDirectThrottleConfig(override)) {
      return override;
    }
    return override[ruleName] ?? override.default;
  }

  private toNumber(
    value: unknown,
    option: string,
    throttlerName: string,
  ): number {
    const num =
      typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof num !== "number" || Number.isNaN(num)) {
      throw new Error(
        `Invalid "${option}" for the "${throttlerName}" throttler: expected a number, got ${JSON.stringify(value)}.`,
      );
    }
    return num;
  }

  private async resolveValue<T extends number | string | boolean>(
    context: ExecutionContext,
    resolvableValue: Resolvable<T>,
  ): Promise<T> {
    return typeof resolvableValue === "function"
      ? await resolvableValue(context)
      : resolvableValue;
  }
}
