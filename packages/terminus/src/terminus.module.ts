import { Module, type DynamicModule } from "@bunest/common";
import {
  DiskHealthIndicator,
  EventLoopHealthIndicator,
  FetchHealthIndicator,
  GRPCHealthIndicator,
  HealthCheckService,
  HealthIndicatorService,
  HttpHealthIndicator,
  MemoryHealthIndicator,
  MicroserviceHealthIndicator,
  PrismaHealthIndicator,
  TerminusModule as ObservabilityTerminusModule,
  type TerminusAsyncOptions,
  type TerminusModuleOptions,
} from "@bunest/observability";
import {
  MikroOrmHealthIndicator,
  MongooseHealthIndicator,
  SequelizeHealthIndicator,
  TypeOrmHealthIndicator,
} from "./orm-health.indicators";

const TERMINUS_PROVIDERS = [
  HealthIndicatorService,
  HealthCheckService,
  MemoryHealthIndicator,
  EventLoopHealthIndicator,
  FetchHealthIndicator,
  HttpHealthIndicator,
  DiskHealthIndicator,
  PrismaHealthIndicator,
  MicroserviceHealthIndicator,
  GRPCHealthIndicator,
  TypeOrmHealthIndicator,
  MongooseHealthIndicator,
  SequelizeHealthIndicator,
  MikroOrmHealthIndicator,
] as const;

/**
 * Drop-in `@nestjs/terminus@12.2.0` module combining `@bunest/observability`'s
 * `TerminusModule` with all zero-dependency structural ORM health indicators
 * (`TypeOrmHealthIndicator`, `MongooseHealthIndicator`, `SequelizeHealthIndicator`,
 * and `MikroOrmHealthIndicator`).
 */
@Module({
  providers: [...TERMINUS_PROVIDERS],
  exports: [...TERMINUS_PROVIDERS],
})
export class TerminusModule {
  static forRoot(options: TerminusModuleOptions = {}): DynamicModule {
    const base = ObservabilityTerminusModule.forRoot(options);
    return {
      module: TerminusModule,
      providers: [...(base.providers ?? [])],
      exports: [...TERMINUS_PROVIDERS],
    };
  }

  static forRootAsync(options: TerminusAsyncOptions): DynamicModule {
    const base = ObservabilityTerminusModule.forRootAsync(options);
    return {
      module: TerminusModule,
      global: options.global,
      imports: base.imports ?? [],
      providers: [...(base.providers ?? [])],
      exports: [...TERMINUS_PROVIDERS],
    };
  }
}
