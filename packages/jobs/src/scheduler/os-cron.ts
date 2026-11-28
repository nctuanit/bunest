import {
  BunestFactory,
  ClsService,
  DiscoveryService,
  Inject,
  Injectable,
  Logger,
  Optional,
  restoreClsContext,
  type BunestApplicationContext,
  type BunestCreateOptions,
  type IEntryNestModule,
  type InjectionToken,
  type OnModuleInit,
} from "@bunest/core";
import { OS_CRON_ADAPTER, SCHEDULE_MODULE_OPTIONS } from "./constants";
import {
  CronExpressionError,
  getNextCronDate,
  getNextCronDates,
  parseCronExpression,
} from "./cron/cron-parser";
import { getOsCronMetadata } from "./decorators/schedule.decorators";
import type {
  OsCronController,
  OsCronHandler,
  OsCronJobDefinition,
  OsCronModuleExport,
  OsCronRuntimeAdapter,
  ScheduleModuleOptions,
} from "./interfaces/scheduler.interface";
import { SchedulerRegistry } from "./scheduler.registry";

/**
 * Bun's OS-level cron title pattern (`crontab` markers, `launchd` labels,
 * Windows Task Scheduler names): alphanumeric, hyphens, and underscores only.
 */
export const OS_CRON_TITLE_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface DefineOsCronJobOptions {
  /**
   * Optional error hook invoked if the scheduled handler throws or rejects.
   */
  readonly onError?: (
    error: unknown,
    controller: OsCronController,
  ) => unknown | Promise<unknown>;
  /**
   * Whether to rethrow handler errors after invoking `onError` so the OS
   * scheduler records a non-zero exit code.
   * @default true
   */
  readonly rethrow?: boolean;
}

export type OsCronBootstrapTarget =
  | ((
      app: BunestApplicationContext,
      controller: OsCronController,
    ) => unknown | Promise<unknown>)
  | {
      /** DI provider token to resolve from the bootstrapped application context. */
      readonly provider: InjectionToken;
      /** Method name to invoke on the resolved provider with `(controller)`. */
      readonly method: string | symbol;
    }
  | {
      /** Name of a `@Cron(..., { name })` job registered in `SchedulerRegistry`. */
      readonly jobName: string;
    }
  | {
      /** Title of a `@OsCron(schedule, { title })` handler to discover and invoke. */
      readonly osCronTitle: string;
    };

export interface OsCronBootstrapOptions
  extends DefineOsCronJobOptions,
    Omit<BunestCreateOptions, "httpAdapter"> {
  /**
   * When `true` and `ClsService` is available in the application context,
   * wraps the invocation in a fresh CLS context populated with `requestId`,
   * `cron`, and `scheduledTime`.
   * @default true
   */
  readonly cls?: boolean;
}

export interface OsCronSyncOptions {
  /**
   * Obsolete OS cron job titles to remove via `Bun.cron.remove()` before
   * registering the desired definitions.
   */
  readonly removeTitles?: readonly string[];
  /**
   * Optional custom runtime adapter overriding native `Bun.cron`.
   */
  readonly adapter?: OsCronRuntimeAdapter;
}

export interface OsCronSyncResult {
  readonly registered: readonly OsCronJobDefinition[];
  readonly removed: readonly string[];
}

function normalizeDefaultOsCronTitle(
  className: string,
  methodName: string | symbol,
): string {
  const raw = `${className}-${String(methodName)}`
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return raw.length > 0 ? raw : "os-cron-job";
}

/**
 * Validates an OS-level cron title against Bun's cross-platform identifier
 * rules (`/^[A-Za-z0-9_-]+$/`).
 */
export function validateOsCronTitle(title: string): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed.length === 0 || !OS_CRON_TITLE_PATTERN.test(trimmed)) {
    throw new CronExpressionError(
      `Invalid OS cron title "${String(title)}": expected non-empty string containing only alphanumeric characters, hyphens, and underscores (/^[A-Za-z0-9_-]+$/).`,
    );
  }
  return trimmed;
}

/**
 * Validates that `schedule` is accepted by Bun's OS-level cron scheduler
 * (standard 5-field expression without wrap-around ranges, or one of Bun's
 * 7 nicknames `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`,
 * `@midnight`, `@hourly`) and has at least one future occurrence.
 */
export function validateOsCronSchedule(schedule: string): string {
  const parsed = parseCronExpression(schedule);
  if (parsed.nativeExpression === undefined) {
    throw new CronExpressionError(
      `Cron schedule "${schedule}" is not supported by OS-level Bun.cron: expected a 5-field expression (without wrap-around ranges) or a nickname (@yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly).`,
    );
  }

  if (typeof Bun !== "undefined" && typeof Bun.cron?.parse === "function") {
    let next: Date | null;
    try {
      next = Bun.cron.parse(parsed.nativeExpression, new Date());
    } catch (error) {
      throw new CronExpressionError(
        `Invalid OS cron schedule "${schedule}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (next === null) {
      throw new CronExpressionError(
        `OS cron schedule "${schedule}" has no matching date within 8 years.`,
      );
    }
  }

  return parsed.nativeExpression;
}

/**
 * Creates the default `OsCronRuntimeAdapter` backed directly by Bun 1.4.5's
 * native `Bun.cron(path, schedule, title)` and `Bun.cron.remove(title)`.
 */
export function createDefaultOsCronAdapter(): OsCronRuntimeAdapter {
  return {
    async register(
      path: string,
      schedule: string,
      title: string,
    ): Promise<void> {
      if (typeof Bun === "undefined" || typeof Bun.cron !== "function") {
        throw new CronExpressionError(
          "Native Bun.cron(path, schedule, title) is unavailable in this runtime (requires Bun >= 1.4.5).",
        );
      }
      await Bun.cron(path, schedule, title);
    },
    async remove(title: string): Promise<void> {
      if (typeof Bun === "undefined" || typeof Bun.cron?.remove !== "function") {
        throw new CronExpressionError(
          "Native Bun.cron.remove(title) is unavailable in this runtime (requires Bun >= 1.4.5).",
        );
      }
      await Bun.cron.remove(title);
    },
  };
}

/**
 * Validates and registers an OS-level cron job via `Bun.cron(path, schedule, title)`
 * (`crontab` on Linux, `launchd` on macOS, Task Scheduler on Windows).
 */
export async function registerOsCronJob(
  definition: OsCronJobDefinition,
  adapter: OsCronRuntimeAdapter = createDefaultOsCronAdapter(),
): Promise<OsCronJobDefinition> {
  const title = validateOsCronTitle(definition.title);
  const schedule = validateOsCronSchedule(definition.schedule);
  const path = typeof definition.path === "string" ? definition.path.trim() : "";
  if (path.length === 0) {
    throw new CronExpressionError(
      `Invalid OS cron job "${title}": "path" must be a non-empty path to a module exporting default.scheduled(controller).`,
    );
  }

  await adapter.register(path, schedule, title);
  return { title, schedule, path };
}

/**
 * Validates `title` and unregisters an OS-level cron job via `Bun.cron.remove(title)`.
 */
export async function removeOsCronJob(
  title: string,
  adapter: OsCronRuntimeAdapter = createDefaultOsCronAdapter(),
): Promise<void> {
  const validated = validateOsCronTitle(title);
  await adapter.remove(validated);
}

/**
 * Validates all inputs up front, optionally removes obsolete OS cron titles,
 * and registers every provided `OsCronJobDefinition` via `Bun.cron()`.
 */
export async function syncOsCronJobs(
  definitions: readonly OsCronJobDefinition[],
  options: OsCronSyncOptions = {},
): Promise<OsCronSyncResult> {
  const adapter = options.adapter ?? createDefaultOsCronAdapter();
  const seenTitles = new Set<string>();
  const normalizedDefs: OsCronJobDefinition[] = [];

  for (const def of definitions) {
    const title = validateOsCronTitle(def.title);
    if (seenTitles.has(title)) {
      throw new CronExpressionError(
        `Duplicate OS cron title "${title}" in syncOsCronJobs() definitions.`,
      );
    }
    seenTitles.add(title);
    const schedule = validateOsCronSchedule(def.schedule);
    const path = typeof def.path === "string" ? def.path.trim() : "";
    if (path.length === 0) {
      throw new CronExpressionError(
        `Invalid OS cron job "${title}": "path" must be a non-empty module path.`,
      );
    }
    normalizedDefs.push({ title, schedule, path });
  }

  const normalizedRemoveTitles: string[] = [];
  for (const title of options.removeTitles ?? []) {
    normalizedRemoveTitles.push(validateOsCronTitle(title));
  }

  const removed: string[] = [];
  for (const title of normalizedRemoveTitles) {
    await adapter.remove(title);
    removed.push(title);
  }

  const registered: OsCronJobDefinition[] = [];
  for (const def of normalizedDefs) {
    await adapter.register(def.path, def.schedule, def.title);
    registered.push(def);
  }

  return { registered, removed };
}

/**
 * Mode 1 (Lightweight / Zero-DI OS Cron Entrypoint):
 * Defines a Bun / Cloudflare Workers compatible `{ scheduled(controller) }`
 * default export for use with `Bun.cron(path, schedule, title)`.
 *
 * @example
 * ```ts
 * // src/jobs/cleanup.cron.ts
 * import { defineOsCronJob } from "@bunest/jobs/scheduler";
 *
 * export default defineOsCronJob(async (controller) => {
 *   console.log(`Fired ${controller.cron} at ${controller.scheduledTime}`);
 * });
 * ```
 */
export function defineOsCronJob(
  handler: OsCronHandler,
  options: DefineOsCronJobOptions = {},
): OsCronModuleExport {
  const rethrow = options.rethrow ?? true;
  return {
    async scheduled(controller: OsCronController): Promise<void> {
      try {
        await handler(controller);
      } catch (error) {
        if (options.onError) {
          await options.onError(error, controller);
        }
        if (rethrow) {
          throw error;
        }
      }
    },
  };
}

/**
 * Mode 2 (DI-Enabled OS Cron Entrypoint):
 * Returns a Bun / Cloudflare Workers compatible `{ scheduled(controller) }`
 * default export that boots a headless `BunestFactory.createApplicationContext(rootModule)`,
 * executes the configured handler / provider method / `@Cron` job / `@OsCron` handler
 * inside a clean CLS context, and cleanly closes the application context before exit.
 *
 * @example
 * ```ts
 * // src/jobs/weekly-report.cron.ts
 * import { bootstrapCronApplication } from "@bunest/jobs/scheduler";
 * import { AppModule } from "../app.module";
 * import { ReportsService } from "../reports/reports.service";
 *
 * export default bootstrapCronApplication(AppModule, {
 *   provider: ReportsService,
 *   method: "generateWeekly",
 * });
 * ```
 */
export function bootstrapCronApplication(
  rootModule: IEntryNestModule,
  target: OsCronBootstrapTarget,
  options: OsCronBootstrapOptions = {},
): OsCronModuleExport {
  const {
    onError,
    rethrow = true,
    cls: enableCls = true,
    ...createOptions
  } = options;

  return {
    async scheduled(controller: OsCronController): Promise<void> {
      const app = await BunestFactory.createApplicationContext(rootModule, {
        logger: false,
        ...createOptions,
      });

      try {
        await app.init();

        const invokeTarget = async (): Promise<void> => {
          if (typeof target === "function") {
            await target(app, controller);
            return;
          }

          if ("jobName" in target) {
            const registry = app.get(SchedulerRegistry, { strict: false });
            const job = registry.getCronJob(target.jobName);
            await job.fireOnce();
            return;
          }

          if ("osCronTitle" in target) {
            const wantedTitle = validateOsCronTitle(target.osCronTitle);
            const discovery = app.get(DiscoveryService, { strict: false });
            const wrappers = [
              ...discovery.getControllers(),
              ...discovery.getProviders(),
            ];
            let matched = false;
            const seen = new Set<object>();

            for (const wrapper of wrappers) {
              const instance = wrapper.instance;
              if (!instance || typeof instance !== "object" || seen.has(instance)) {
                continue;
              }
              seen.add(instance);
              const ctor = (instance as { constructor?: Function }).constructor;
              if (typeof ctor !== "function" || ctor === Object) {
                continue;
              }
              const className = ctor.name || "Anonymous";
              for (const meta of getOsCronMetadata(ctor)) {
                const resolvedTitle =
                  meta.options.title ??
                  normalizeDefaultOsCronTitle(className, meta.methodName);
                if (resolvedTitle !== wantedTitle) {
                  continue;
                }
                const fn = (instance as Record<string | symbol, unknown>)[
                  meta.methodName
                ];
                if (typeof fn !== "function") {
                  continue;
                }
                matched = true;
                await (fn as OsCronHandler).call(instance, controller);
              }
            }

            if (!matched) {
              throw new CronExpressionError(
                `No @OsCron() handler found with title "${wantedTitle}". Check that the provider is registered in the bootstrapped module and decorated with @OsCron(schedule, { title: "${wantedTitle}" }).`,
              );
            }
            return;
          }

          const instance = app.get<Record<string | symbol, unknown>>(
            target.provider,
            { strict: false },
          );
          const fn = instance?.[target.method];
          if (typeof fn !== "function") {
            const providerLabel =
              typeof target.provider === "function"
                ? target.provider.name
                : String(target.provider);
            throw new CronExpressionError(
              `Method "${String(target.method)}" was not found on provider "${providerLabel}".`,
            );
          }
          await (fn as OsCronHandler).call(instance, controller);
        };

        let clsService: ClsService | undefined;
        if (enableCls) {
          try {
            clsService = app.get(ClsService, { strict: false });
          } catch {
            clsService = undefined;
          }
        }

        if (clsService) {
          const requestId = `os-cron:${controller.cron}:${crypto.randomUUID()}`;
          await restoreClsContext(
            clsService,
            {
              clsId: requestId,
              values: {
                requestId,
                cron: controller.cron,
                scheduledTime: controller.scheduledTime,
              },
            },
            invokeTarget,
          );
        } else {
          await invokeTarget();
        }
      } catch (error) {
        if (onError) {
          await onError(error, controller);
        }
        if (rethrow) {
          throw error;
        }
      } finally {
        await app.close();
      }
    },
  };
}

/**
 * Injectable service exported by `ScheduleModule` for managing OS-level
 * Bun cron jobs (`Bun.cron(path, schedule, title)` and `Bun.cron.remove(title)`),
 * discovering `@OsCron()`-decorated handlers, and previewing schedules with
 * `Bun.cron.parse()`.
 */
@Injectable()
export class OsCronService implements OnModuleInit {
  private readonly adapter: OsCronRuntimeAdapter;
  private readonly registered = new Map<string, OsCronJobDefinition>();
  private readonly logger = new Logger("OsCronService");

  constructor(
    @Optional()
    @Inject(OS_CRON_ADAPTER)
    adapter?: OsCronRuntimeAdapter,
    @Optional()
    @Inject(SCHEDULE_MODULE_OPTIONS)
    private readonly moduleOptions: ScheduleModuleOptions = {},
    @Optional()
    private readonly discoveryService?: DiscoveryService,
  ) {
    this.adapter =
      adapter ?? moduleOptions.osCronAdapter ?? createDefaultOsCronAdapter();
  }

  async onModuleInit(): Promise<void> {
    if (
      this.moduleOptions.registerOsCronOnInit === true &&
      this.moduleOptions.osCronJobs &&
      this.moduleOptions.osCronJobs.length > 0
    ) {
      await this.syncConfigured();
    }
  }

  async register(definition: OsCronJobDefinition): Promise<OsCronJobDefinition> {
    const normalized = await registerOsCronJob(definition, this.adapter);
    this.registered.set(normalized.title, normalized);
    return normalized;
  }

  async remove(title: string): Promise<void> {
    const validated = validateOsCronTitle(title);
    await removeOsCronJob(validated, this.adapter);
    this.registered.delete(validated);
  }

  async sync(
    definitions: readonly OsCronJobDefinition[],
    options: Omit<OsCronSyncOptions, "adapter"> = {},
  ): Promise<OsCronSyncResult> {
    const result = await syncOsCronJobs(definitions, {
      ...options,
      adapter: this.adapter,
    });
    for (const removedTitle of result.removed) {
      this.registered.delete(removedTitle);
    }
    for (const def of result.registered) {
      this.registered.set(def.title, def);
    }
    return result;
  }

  async syncConfigured(): Promise<OsCronSyncResult> {
    const configured = this.moduleOptions.osCronJobs ?? [];
    return this.sync(configured);
  }

  /**
   * Discovers all `@OsCron()`-decorated methods across loaded static providers
   * and controllers, returning `OsCronJobDefinition[]` for entries that specify
   * a `path` (or using `defaultPath` when omitted).
   */
  discoverDecoratedJobs(defaultPath?: string): OsCronJobDefinition[] {
    if (!this.discoveryService) {
      return [];
    }
    const jobs: OsCronJobDefinition[] = [];
    const seen = new Set<object>();
    const wrappers = [
      ...this.discoveryService.getControllers(),
      ...this.discoveryService.getProviders(),
    ];

    for (const wrapper of wrappers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object" || seen.has(instance)) {
        continue;
      }
      seen.add(instance);
      const ctor = (instance as { constructor?: Function }).constructor;
      if (typeof ctor !== "function" || ctor === Object) {
        continue;
      }
      const className = ctor.name || "Anonymous";
      for (const meta of getOsCronMetadata(ctor)) {
        const title = validateOsCronTitle(
          meta.options.title ??
            normalizeDefaultOsCronTitle(className, meta.methodName),
        );
        const schedule = validateOsCronSchedule(meta.schedule);
        const path = meta.options.path?.trim() || defaultPath?.trim();
        if (!path) {
          this.logger.warn(
            `Skipping @OsCron() handler "${className}.${String(meta.methodName)}" (title="${title}") because neither options.path nor defaultPath was provided.`,
          );
          continue;
        }
        jobs.push({ title, schedule, path });
      }
    }

    return jobs.sort((a, b) => a.title.localeCompare(b.title));
  }

  getRegisteredJobs(): Map<string, OsCronJobDefinition> {
    return new Map(this.registered);
  }

  parseNext(
    expression: string,
    fromDate: Date = new Date(),
    timeZone?: string,
  ): Date {
    return getNextCronDate(expression, fromDate, timeZone);
  }

  preview(
    expression: string,
    count = 5,
    fromDate: Date = new Date(),
    timeZone?: string,
  ): Date[] {
    return getNextCronDates(expression, count, fromDate, timeZone);
  }
}
