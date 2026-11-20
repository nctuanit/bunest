import { Inject, Injectable, Optional } from "@bunest/common";
import { ResilienceEvents } from "../events/resilience-events.service";
import type { CircuitBreakerOptions } from "../interfaces/circuit-breaker-options.interface";
import type { ResilienceModuleOptions } from "../interfaces/resilience-module-options.interface";
import { CircuitBreakerPolicy } from "../policies/circuit-breaker.policy";
import { RESILIENCE_MODULE_OPTIONS } from "../resilience.module-definition";
import { ms, NamedRegistry } from "./named-registry.service";

@Injectable()
export class CircuitBreakerRegistry extends NamedRegistry<
  CircuitBreakerPolicy,
  CircuitBreakerOptions
> {
  protected override readonly kind = "Circuit breaker";

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
    options: CircuitBreakerOptions = {},
  ): CircuitBreakerPolicy {
    return new CircuitBreakerPolicy({
      ...this.moduleOptions.defaults?.circuitBreaker,
      ...options,
      name,
    });
  }

  protected override normalize({
    openDuration,
    slidingWindow,
    ...rest
  }: CircuitBreakerOptions): {
    name?: string;
    failureRateThreshold?: number;
    minimumCalls?: number;
    halfOpenMaxCalls?: number;
    recordIf?: (error: unknown) => boolean;
    openDuration: number | undefined;
    slidingWindow:
      | {
          type: "count" | "time";
          size: number | undefined;
        }
      | undefined;
  } {
    return {
      ...rest,
      openDuration: ms(openDuration, "openDuration"),
      slidingWindow: slidingWindow && {
        type: slidingWindow.type,
        size:
          slidingWindow.type === "time"
            ? ms(slidingWindow.size, "slidingWindow.size")
            : slidingWindow.size,
      },
    };
  }
}
