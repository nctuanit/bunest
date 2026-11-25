import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  UnauthorizedException,
} from "@bunest/core";
import type { AppConfig } from "./config";
import { APP_CONFIG } from "./health.service";
import { MetricsService } from "./metrics.service";

@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get("/metrics")
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  getMetrics(@Headers("authorization") authorization?: string): string {
    if (this.config.metricsToken) {
      const expected = `Bearer ${this.config.metricsToken}`;
      if (authorization !== expected) {
        throw new UnauthorizedException("Invalid metrics credentials");
      }
    }
    return this.metrics.renderPrometheus();
  }
}
