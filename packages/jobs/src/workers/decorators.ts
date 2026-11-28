import {
  AspectPhase,
  Inject,
  Injectable,
  MetadataRegistry,
  Optional,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { WorkerPoolError } from "./errors";
import type {
  OffloadOptions,
  WorkerContractLike,
  WorkerHandlerMetadata,
  WorkerPoolLike,
} from "./interfaces";
import {
  WORKER_HANDLER_METADATA,
  WORKER_OFFLOAD_ASPECT,
  WORKER_POOL_REGISTRY,
  getWorkerPoolToken,
} from "./tokens";
import { isWorkerContract } from "./worker-contract";

export interface WorkerPoolLookup {
  get(name?: string): WorkerPoolLike | undefined;
}

/**
 * Injects the named `WorkerPool` registered via `WorkerModule.registerPool()`
 * or `WorkerModule.forRoot({ pools })` (defaults to `"default"`).
 */
export function InjectWorkerPool(
  name?: string,
): ParameterDecorator & PropertyDecorator {
  return Inject(getWorkerPoolToken(name));
}

/**
 * Marks a method on an `@Injectable()` provider inside a DI-enabled worker
 * (`bootstrapWorkerApplication`) as the handler for `taskNameOrContract`.
 * Inheritance-safe (copy-on-write on constructor).
 */
export function WorkerHandler(
  taskNameOrContract?: string | WorkerContractLike<string, any, any>,
): MethodDecorator {
  let explicitName: string | undefined;
  let contract: WorkerContractLike<string, any, any> | undefined;

  if (taskNameOrContract === undefined) {
    explicitName = undefined;
  } else if (typeof taskNameOrContract === "string") {
    explicitName = taskNameOrContract;
  } else if (isWorkerContract(taskNameOrContract)) {
    explicitName = taskNameOrContract.name;
    contract = taskNameOrContract;
  } else {
    throw new Error(
      "@WorkerHandler() expects a task name string, a WorkerContract from defineWorkerContract(), or no argument.",
    );
  }

  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor?: Function }).constructor;
    if (typeof ctor !== "function") {
      return;
    }
    const existing =
      MetadataRegistry.getOwn<readonly WorkerHandlerMetadata[]>(
        WORKER_HANDLER_METADATA,
        ctor,
      ) ?? [];
    const taskName = explicitName ?? String(propertyKey);
    const next: WorkerHandlerMetadata[] = [
      ...existing.filter((entry) => entry.methodName !== propertyKey),
      {
        taskName,
        methodName: propertyKey,
        ...(contract ? { contract } : {}),
      },
    ];
    MetadataRegistry.define(WORKER_HANDLER_METADATA, next, ctor);
  };
}

/**
 * Service-layer AOP aspect (ADR-014) backing `@Offload(...)`.
 * Routes decorated service methods transparently to a registered Bun `WorkerPool`.
 */
@Injectable()
export class WorkerOffloadAspect
  implements MethodAspectHandler<OffloadOptions>
{
  constructor(
    @Optional()
    @Inject(WORKER_POOL_REGISTRY)
    private readonly registry?: WorkerPoolLookup,
  ) {}

  async intercept(ctx: MethodAspectContext<OffloadOptions>): Promise<unknown> {
    const opts = ctx.options ?? {};
    const poolName = opts.pool ?? "default";
    const pool = this.registry?.get(poolName);

    if (!pool) {
      if (opts.fallbackToLocal) {
        return await ctx.proceed();
      }
      throw new WorkerPoolError(
        `@Offload() on ${ctx.targetClass.name}.${String(ctx.methodName)}() could not find worker pool "${poolName}". Register it with WorkerModule.registerPool({ name: "${poolName}", script }) or set fallbackToLocal: true.`,
        "BUNEST_E201",
        {
          details: {
            poolName,
            targetClass: ctx.targetClass.name,
            methodName: String(ctx.methodName),
          },
        },
      );
    }

    const payload = opts.mapArgs
      ? opts.mapArgs(...ctx.args)
      : ctx.args.length === 0
        ? undefined
        : ctx.args.length === 1
          ? ctx.args[0]
          : [...ctx.args];

    const transfer = opts.extractTransfer
      ? opts.extractTransfer(payload, ctx.args)
      : undefined;

    const runOptions = {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(transfer && transfer.length > 0 ? { transfer } : {}),
    };

    if (opts.contract) {
      return await pool.run(opts.contract, payload, runOptions);
    }

    const taskName = opts.task ?? String(ctx.methodName);
    return await pool.run(taskName, payload, runOptions);
  }
}

/**
 * Declaratively offloads a service method invocation to a Bun `WorkerPool` via
 * Bunest's compile-once service-layer AOP weaver (`ADR-014`).
 *
 * ```ts
 * @Injectable()
 * export class CryptoService {
 *   @Offload({ pool: "crypto", task: "hash", timeoutMs: 5_000 })
 *   async hash(input: Uint8Array): Promise<string> {
 *     throw new Error("Executed on worker thread");
 *   }
 * }
 * ```
 */
export function Offload(
  poolNameOrOptions?: string | OffloadOptions,
): MethodDecorator {
  const normalized: OffloadOptions =
    typeof poolNameOrOptions === "string"
      ? { pool: poolNameOrOptions }
      : (poolNameOrOptions ?? {});
  return createMethodAspectDecorator<OffloadOptions>(
    WORKER_OFFLOAD_ASPECT,
    normalized,
    { phase: AspectPhase.DEFAULT },
  );
}
