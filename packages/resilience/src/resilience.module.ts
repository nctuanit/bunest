import { APP_INTERCEPTOR, Module, type DynamicModule } from "@bunest/common";
import { DiscoveryModule } from "@bunest/core";
import { ResilienceMethodAspectHandler } from "./aspects/resilience-aspect.handler";
import { ResilienceContext } from "./context/resilience.context";
import { ResilienceEvents } from "./events/resilience-events.service";
import { ResilienceInterceptor } from "./interceptors/resilience.interceptor";
import { RESILIENCE_METHOD_ASPECT } from "./resilience.constants";
import { ResilienceExplorer } from "./resilience.explorer";
import {
  ConfigurableModuleClass,
  OPTIONS_TYPE,
  type ResilienceModuleAsyncOptions,
} from "./resilience.module-definition";
import { ResilienceService } from "./resilience.service";
import { BulkheadRegistry } from "./services/bulkhead-registry.service";
import { CircuitBreakerRegistry } from "./services/circuit-breaker-registry.service";
import { EntrypointPlanner } from "./services/entrypoint-planner.service";
import { OutboundRateLimitRegistry } from "./services/outbound-rate-limit-registry.service";
import { PolicyFactory } from "./services/policy-factory.service";

/**
 * `ResilienceModule.forRoot({ defaults, presets })` or
 * `forRootAsync({ imports, inject, useFactory | useClass | useExisting })`.
 * Global by default.
 *
 * Registers one app-wide interceptor that applies the entrypoint decorators,
 * and exports `ResilienceService`, `ResilienceEvents` and `ResilienceContext`
 * for code inside services.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    ResilienceEvents,
    ResilienceContext,
    CircuitBreakerRegistry,
    BulkheadRegistry,
    OutboundRateLimitRegistry,
    PolicyFactory,
    ResilienceService,
    EntrypointPlanner,
    ResilienceExplorer,
    ResilienceInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ResilienceInterceptor },
    ResilienceMethodAspectHandler,
    {
      provide: RESILIENCE_METHOD_ASPECT,
      useExisting: ResilienceMethodAspectHandler,
    },
  ],
  exports: [
    ResilienceService,
    ResilienceEvents,
    ResilienceContext,
    ResilienceMethodAspectHandler,
    RESILIENCE_METHOD_ASPECT,
  ],
})
export class ResilienceModule extends ConfigurableModuleClass {
  static override forRoot(options: typeof OPTIONS_TYPE = {}): DynamicModule {
    return super.forRoot(options);
  }

  static override forRootAsync(
    options: ResilienceModuleAsyncOptions,
  ): DynamicModule {
    return super.forRootAsync(options);
  }
}
