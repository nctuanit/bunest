import { Controller, Get, Query } from "@bunest/core";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(@Query("name") name?: string) {
    return this.appService.getGreeting(name);
  }

  @Get("/health")
  getHealth() {
    return { status: "ok" };
  }
}
