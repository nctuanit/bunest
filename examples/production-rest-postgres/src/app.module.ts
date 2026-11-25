import {
  Injectable,
  Module,
  type BunestApplication,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
  type ResponseContext,
} from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { ValidationPipe } from "@bunest/validation";
import { logJson, type AppConfig } from "./config";
import { HealthController } from "./health.controller";
import { APP_CONFIG, HealthService } from "./health.service";
import { ItemEntity } from "./item.entity";
import { ItemRepository } from "./item.repository";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

@Injectable()
export class RequestTelemetryInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const url = new URL(req.url);
    const requestId =
      req.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const start = performance.now();

    const isProbe = url.pathname === "/live" || url.pathname === "/ready";
    if (!isProbe) {
      this.metrics.beginRequest();
    }

    let status = 200;
    try {
      const result = await next.handle();
      const res = http.getResponse<ResponseContext>();
      res?.header("x-request-id", requestId);
      if (result instanceof Response) {
        status = result.status;
        const headers = new Headers(result.headers);
        headers.set("x-request-id", requestId);
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers,
        });
      }
      status = res?.getStatus() ?? (req.method === "POST" ? 201 : 200);
      return result;
    } catch (err) {
      const maybeHttp = err as { getStatus?: () => number; status?: number };
      status =
        typeof maybeHttp?.getStatus === "function"
          ? maybeHttp.getStatus()
          : typeof maybeHttp?.status === "number"
            ? maybeHttp.status
            : 500;
      throw err;
    } finally {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (!isProbe) {
        this.metrics.endRequest(status, durationMs);
      }
      if (!isProbe && url.pathname !== "/metrics") {
        logJson(status >= 500 ? "error" : "info", "http_request", {
          requestId,
          method: req.method,
          path: url.pathname,
          status,
          durationMs,
        });
      }
    }
  }
}

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
