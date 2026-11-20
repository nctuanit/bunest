import { Inject, Injectable, Optional } from "@bunest/common";
import { ResilienceEvents } from "../events/resilience-events.service";
import type { BulkheadOptions } from "../interfaces/bulkhead-options.interface";
import type { ResilienceModuleOptions } from "../interfaces/resilience-module-options.interface";
import { BulkheadPolicy } from "../policies/bulkhead.policy";
import { RESILIENCE_MODULE_OPTIONS } from "../resilience.module-definition";
import { ms, NamedRegistry } from "./named-registry.service";

@Injectable()
export class BulkheadRegistry extends NamedRegistry<
  BulkheadPolicy,
  BulkheadOptions
> {
  protected override readonly kind = "Bulkhead";

  constructor(
    @Optional()
    @Inject(RESILIENCE_MODULE_OPTIONS)
    moduleOptions?: ResilienceModuleOptions,
    @Optional() events?: ResilienceEvents,
  ) {
    super(moduleOptions, events);
  }

  protected override create(
    name: string,
    options: BulkheadOptions = {},
  ): BulkheadPolicy {
    return new BulkheadPolicy({
      ...this.moduleOptions.defaults?.bulkhead,
      ...options,
      name,
    });
  }

  protected override normalize({ queueTimeout, ...rest }: BulkheadOptions): {
    name?: string;
    maxConcurrent?: number;
    maxQueue?: number;
    queueTimeout: number | undefined;
  } {
    return { ...rest, queueTimeout: ms(queueTimeout, "queueTimeout") };
  }
}
