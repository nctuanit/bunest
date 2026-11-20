import {
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  SetMetadata,
  type InjectableMetadata,
} from "@bunest/common";
import { BULL_MODULE_QUEUE } from "../bull.constants";

/**
 * @publicApi
 */
export interface ProcessorOptions {
  /**
   * Specifies the name of the queue to subscribe to.
   */
  name?: string;
  /**
   * Specifies the lifetime of an injected Processor.
   */
  scope?: Scope;
}

/**
 * Represents a worker that is able to process jobs from the queue.
 */
export function Processor(): ClassDecorator;
/**
 * Represents a worker that is able to process jobs from the queue.
 * @param queueName queue name
 */
export function Processor(queueName: string): ClassDecorator;
/**
 * Represents a worker that is able to process jobs from the queue.
 * @param processorOptions processor options
 */
export function Processor(processorOptions: ProcessorOptions): ClassDecorator;
export function Processor(
  queueNameOrOptions?: string | ProcessorOptions,
): ClassDecorator {
  const options: ProcessorOptions =
    queueNameOrOptions && typeof queueNameOrOptions === "object"
      ? queueNameOrOptions
      : { name: queueNameOrOptions };

  return (target: Function) => {
    const existing = MetadataRegistry.getOwn<InjectableMetadata>(
      METADATA_KEYS.INJECTABLE,
      target,
    );
    const scope = options.scope ?? existing?.scope ?? Scope.SINGLETON;
    MetadataRegistry.define<InjectableMetadata>(
      METADATA_KEYS.INJECTABLE,
      { ...existing, scope },
      target,
    );
    SetMetadata(BULL_MODULE_QUEUE, options)(target);
  };
}
