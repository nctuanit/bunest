import { Controller, Get } from "@bunest/core";

@Controller()
export class HealthController {
  @Get("health")
  health() {
    return {
      status: "ok",
      shop: Bun.env.APP_NAME ?? "Bunest Sneaker Shop",
      runtime: `Bun ${Bun.version}`,
    };
  }
}
