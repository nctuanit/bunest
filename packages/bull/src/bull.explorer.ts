import {
  Injectable,
  Logger,
  Scope,
  type OnModuleInit,
} from "@bunest/common";
import {
  createContextId,
  DiscoveryService,
  MetadataScanner,
  ModuleRef,
  type InstanceWrapper,
} from "@bunest/core";
import { NO_QUEUE_FOUND } from "./bull.constants";
import { BullMetadataAccessor } from "./bull-metadata.accessor";
import type { BullQueueEventOptions } from "./bull.types";
import type { ProcessOptions } from "./decorators/process.decorator";
import type { BullQueue } from "./queue/bull-queue";
import { getQueueToken } from "./utils/get-queue-token.util";

function isWrapperStatic(wrapper: InstanceWrapper | any): boolean {
  if (!wrapper) return true;
  if (typeof wrapper.isDependencyTreeStatic === "function") {
    return wrapper.isDependencyTreeStatic();
  }
  if (wrapper.isDependencyTreeStatic === false) {
    return false;
  }
  return wrapper.scope !== Scope.REQUEST && wrapper.scope !== Scope.TRANSIENT;
}

@Injectable()
export class BullExplorer implements OnModuleInit {
  private readonly logger = new Logger("BullModule");
  private explored = false;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly discoveryService: DiscoveryService,
    private readonly metadataAccessor: BullMetadataAccessor,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    this.explore();
  }

  explore(): void {
    if (this.explored) {
      return;
    }
    this.explored = true;

    const providers = this.discoveryService
      .getProviders()
      .filter((wrapper) => !(wrapper as any).isAlias)
      .filter((wrapper) => {
        const target =
          !wrapper.metatype || (wrapper as any).inject
            ? (wrapper.instance as { constructor?: Function } | undefined)
                ?.constructor
            : wrapper.metatype;
        return this.metadataAccessor.isQueueComponent(target);
      });

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;
      const isRequestScoped = !isWrapperStatic(wrapper);
      const targetCtor =
        (instance && typeof instance === "object"
          ? (instance as { constructor?: Function }).constructor
          : undefined) ?? (typeof metatype === "function" ? metatype : undefined);

      if (!targetCtor) {
        continue;
      }

      const queueMeta =
        this.metadataAccessor.getQueueComponentMetadata(targetCtor) ?? {};
      const queueName: string | undefined = queueMeta.name;
      const queueToken = getQueueToken(queueName);
      const bullQueue = this.getQueue(queueToken, queueName);

      const prototype =
        instance && typeof instance === "object"
          ? Object.getPrototypeOf(instance)
          : targetCtor.prototype;

      const scanTarget = (instance ?? prototype ?? {}) as Record<string, any>;

      this.metadataScanner.scanFromPrototype(scanTarget, prototype, (key) => {
        const methodRef =
          instance && typeof instance === "object"
            ? (instance as Record<string, any>)[key]
            : prototype?.[key];

        if (typeof methodRef !== "function") {
          return;
        }

        if (this.metadataAccessor.isProcessor(methodRef)) {
          const metadata = this.metadataAccessor.getProcessMetadata(methodRef);
          this.handleProcessor(
            scanTarget,
            key,
            bullQueue,
            wrapper,
            isRequestScoped,
            metadata,
          );
        } else if (this.metadataAccessor.isListener(methodRef)) {
          const metadata = this.metadataAccessor.getListenerMetadata(methodRef);
          if (metadata) {
            this.handleListener(scanTarget, key, wrapper, bullQueue, metadata);
          }
        }
      });
    }
  }

  getQueue(queueToken: string, queueName?: string): BullQueue {
    try {
      return this.moduleRef.get<BullQueue>(queueToken, { strict: false });
    } catch (err) {
      this.logger.error(NO_QUEUE_FOUND(queueName));
      throw err;
    }
  }

  handleProcessor(
    instance: object,
    key: string,
    queue: BullQueue,
    wrapperOrModuleRef: InstanceWrapper | any,
    isRequestScoped: boolean,
    options?: ProcessOptions,
  ): void {
    const args: any[] = [options?.name, options?.concurrency];

    if (isRequestScoped) {
      const callback = async (...jobArgs: any[]) => {
        const contextId = createContextId();
        const jobRef = jobArgs[0];
        const resolverRef: ModuleRef =
          wrapperOrModuleRef?.moduleRef ?? this.moduleRef;

        if (typeof resolverRef.registerRequestByContextId === "function") {
          resolverRef.registerRequestByContextId(jobRef, contextId);
        }

        const token =
          wrapperOrModuleRef?.token ??
          wrapperOrModuleRef?.metatype ??
          (instance as { constructor?: any }).constructor;

        const contextInstance = (await resolverRef.resolve(token, contextId, {
          strict: false,
        })) as Record<string, Function>;

        const fn = contextInstance?.[key];
        if (typeof fn !== "function") {
          throw new Error(
            `Method "${key}" not found on request-scoped processor.`,
          );
        }
        return await fn.call(contextInstance, ...jobArgs);
      };
      args.push(callback);
    } else {
      const fn = (instance as Record<string, Function>)[key];
      if (typeof fn !== "function") {
        return;
      }
      args.push(fn.bind(instance));
    }

    const filtered = args.filter((item) => item !== undefined);
    (queue.process as (...a: any[]) => void).apply(queue, filtered);
  }

  handleListener(
    instance: object,
    key: string,
    wrapper: InstanceWrapper | any,
    queue: BullQueue,
    options: BullQueueEventOptions,
  ): void {
    if (!isWrapperStatic(wrapper)) {
      const name =
        wrapper?.name ??
        wrapper?.metatype?.name ??
        (instance as { constructor?: { name?: string } })?.constructor?.name ??
        "Processor";
      this.logger.warn(
        `Warning! "${name}" class is request-scoped and it defines an event listener ("${name}#${key}"). Since event listeners cannot be registered on scoped providers, this handler will be ignored.`,
      );
      return;
    }

    const fn = (instance as Record<string, Function>)[key];
    if (typeof fn !== "function") {
      return;
    }

    if (options.name || options.id) {
      queue.on(options.eventName, async (jobOrJobId: any, ...args: any[]) => {
        const job =
          typeof jobOrJobId === "string" || typeof jobOrJobId === "number"
            ? (await queue.getJob(jobOrJobId)) || { name: false, id: false }
            : jobOrJobId;

        const matchesName =
          options.name !== undefined && job?.name === options.name;
        const matchesId =
          options.id !== undefined &&
          job?.id !== false &&
          String(job?.id) === String(options.id);

        if (matchesName || matchesId) {
          return fn.apply(instance, [job, ...args]);
        }
      });
    } else {
      queue.on(options.eventName, fn.bind(instance));
    }
  }
}
