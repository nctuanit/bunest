import { APP_INTERCEPTOR, Module, type DynamicModule } from "@bunest/core";
import { DiscoveryModule } from "@bunest/core";
import { AUTHORIZATION_MODULE_OPTIONS } from "./authorization.constants";
import {
  ConfigurableModuleClass,
  type AuthorizationModuleAsyncOptions,
  type OPTIONS_TYPE,
} from "./authorization.module-definition";
import { AuthorizationService } from "./authorization.service";
import { AuthorizationEvents } from "./events/authorization-events.service";
import { AuthorizationGuard } from "./guards/authorization.guard";
import { AuthorizationErrorInterceptor } from "./interceptors/authorization-error.interceptor";
import { PolicyEvaluator } from "./services/policy-evaluator.service";
import { PolicyRegistry } from "./services/policy-registry.service";

/**
 * `AuthorizationModule.forRoot()` / `forRoot({...})` /
 * `forRootAsync({ imports, inject, useFactory | useClass | useExisting })`.
 *
 * Provides `AuthorizationService`, registers `AuthorizationGuard` globally
 * (it denies handlers that declare no check), and turns an `AuthorizationError`
 * leaving a handler into the transport's 401/403. Policies are found
 * wherever they are registered as providers.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    PolicyRegistry,
    PolicyEvaluator,
    AuthorizationService,
    AuthorizationEvents,
    AuthorizationGuard,
    AuthorizationErrorInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: AuthorizationErrorInterceptor },
  ],
  exports: [
    AuthorizationService,
    AuthorizationEvents,
    AuthorizationGuard,
    PolicyEvaluator,
    AUTHORIZATION_MODULE_OPTIONS,
  ],
})
export class AuthorizationModule extends ConfigurableModuleClass {
  static override forRoot(options: typeof OPTIONS_TYPE = {}): DynamicModule {
    return super.forRoot(options);
  }

  static override forRootAsync(
    options: AuthorizationModuleAsyncOptions,
  ): DynamicModule {
    return super.forRootAsync(options);
  }
}
