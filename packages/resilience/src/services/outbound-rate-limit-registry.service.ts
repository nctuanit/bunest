import { Inject, Injectable, Optional } from "@bunest/common";
import { ResilienceEvents } from "../events/resilience-events.service";
import type { OutboundRateLimitOptions } from "../interfaces/outbound-rate-limit-options.interface";
import type { ResilienceModuleOptions } from "../interfaces/resilience-module-options.interface";
import { OutboundRateLimitPolicy } from "../policies/outbound-rate-limit.policy";
import { RESILIENCE_MODULE_OPTIONS } from "../resilience.module-definition";
import { ms, NamedRegistry } from "./named-registry.service";

@Injectable()
export class OutboundRateLimitRegistry extends NamedRegistry<
  OutboundRateLimitPolicy,
  OutboundRateLimitOptions
> {
  protected override readonly kind = "Outbound rate limit";

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
    options: OutboundRateLimitOptions | undefined,
  ): OutboundRateLimitPolicy {
    if (!options) {
      throw new Error(
        `Outbound rate limit "${name}" has no configuration (limit and interval are required).`,
      );
    }
    return new OutboundRateLimitPolicy({ ...options, name });
  }

  protected override normalize({
    interval,
    maxWait,
    ...rest
  }: OutboundRateLimitOptions): {
    name?: string;
    limit: number;
    interval: number | undefined;
    maxWait: number | undefined;
  } {
    return {
      ...rest,
      interval: ms(interval, "interval"),
      maxWait: ms(maxWait, "maxWait"),
    };
  }
}
