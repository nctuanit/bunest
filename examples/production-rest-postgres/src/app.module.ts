import {
  Module,
  type BunestApplication,
  type DynamicModule,
} from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { ValidationPipe } from "@bunest/validation";
import type { AppConfig } from "./config";
import { HealthController } from "./health.controller";
import { APP_CONFIG, HealthService } from "./health.service";
import { ItemEntity } from "./item.entity";
import { ItemRepository } from "./item.repository";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";
import { RequestTelemetryInterceptor } from "./request-telemetry.interceptor";

@Module({})
export class ProductionAppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ProductionAppModule,
      imports: [
        OrmModule.forRoot({
          type: "postgres",
          url: config.databaseUrl,
          entities: [ItemEntity],
          synchronize: false,
          max: config.dbPoolMax,
          connectionTimeout: config.dbConnectionTimeoutSec,
          idleTimeout: config.dbIdleTimeoutSec,
          applicationName: "bunest-production-rest-postgres",
        }),
        OrmModule.forFeature([ItemRepository]),
      ],
      controllers: [ItemsController, HealthController, MetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        ItemsService,
        HealthService,
        MetricsService,
        RequestTelemetryInterceptor,
      ],
      exports: [ItemsService, HealthService, MetricsService],
    };
  }
}

export function configureProductionApp(
  app: BunestApplication,
  config: AppConfig,
): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const telemetry = app.get(RequestTelemetryInterceptor);
  app.useGlobalInterceptors(telemetry);
  void config;
}
