import { flatten, type Provider } from "@bunest/common";
import type { BullModuleOptions } from "./interfaces/bull-module-options.interface";
import { BullQueue } from "./queue/bull-queue";
import {
  createConditionalDepHolder,
  type IConditionalDepHolder,
} from "./utils/create-conditional-dep-holder.helper";
import { getQueueOptionsToken } from "./utils/get-queue-options-token.util";
import { getQueueToken } from "./utils/get-queue-token.util";
import {
  BULL_CONFIG_DEFAULT_TOKEN,
  getSharedConfigToken,
} from "./utils/get-shared-config-token.util";
import {
  isAdvancedProcessor,
  isAdvancedSeparateProcessor,
  isProcessorCallback,
  isSeparateProcessor,
} from "./utils/processor-guards.util";

function buildQueue(options: BullModuleOptions): BullQueue {
  const queueName = options.name ? options.name : "default";
  const queue = new BullQueue(queueName, options);

  if (options.processors) {
    for (const processor of options.processors) {
      let args: any[] = [];
      if (isAdvancedProcessor(processor)) {
        args.push(processor.name, processor.concurrency, processor.callback);
      } else if (isAdvancedSeparateProcessor(processor)) {
        args.push(processor.name, processor.concurrency, processor.path);
      } else if (isSeparateProcessor(processor)) {
        args.push(processor);
      } else if (isProcessorCallback(processor)) {
        args.push(processor);
      }
      args = args.filter((arg) => typeof arg !== "undefined");
      if (args.length > 0) {
        (queue.process as (...a: any[]) => void).apply(queue, args);
      }
    }
  }

  return queue;
}

export function createQueueOptionProviders(
  options: BullModuleOptions[],
): Provider[] {
  const providers = options.map((option) => {
    const optionalSharedConfigHolder = createConditionalDepHolder(
      getSharedConfigToken(option.configKey),
      BULL_CONFIG_DEFAULT_TOKEN,
    );
    return [
      optionalSharedConfigHolder,
      {
        provide: getQueueOptionsToken(option.name),
        useFactory: (optionalDepHolder: IConditionalDepHolder) => {
          return {
            ...optionalDepHolder.getDependencyRef(option.name),
            ...option,
          };
        },
        inject: [optionalSharedConfigHolder],
      },
    ];
  });
  return flatten(providers) as unknown as Provider[];
}

export function createQueueProviders(options: BullModuleOptions[]): Provider[] {
  return options.map((option) => ({
    provide: getQueueToken(option.name),
    useFactory: (o: BullModuleOptions) => {
      const queueName = o?.name || option.name;
      return buildQueue({ ...o, name: queueName });
    },
    inject: [getQueueOptionsToken(option.name)],
  }));
}
