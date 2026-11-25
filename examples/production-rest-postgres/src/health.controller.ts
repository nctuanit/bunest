import { Controller, Get, ServiceUnavailableException } from "@bunest/core";
import { HealthService } from "./health.service";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("/live")
  live() {
    return this.health.liveness();
  }

  @Get("/ready")
  async ready() {
    const result = await this.health.readiness();
    if (!result.ready) {
      throw new ServiceUnavailableException({ ...result });
    }
    return result;
  }
}
