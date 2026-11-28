import { Controller, Get, Query } from "@bunest/core";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getInfo(@Query("name") name?: string) {
    return this.appService.getInfo(name || "Bunest");
  }
}
