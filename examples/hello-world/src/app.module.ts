import { Controller, Get, Injectable, Module, Query } from "@bunest/core";

@Injectable()
export class AppService {
  getGreeting(name?: string): { message: string; runtime: string } {
    const target = name?.trim() || "Bunest";
    return {
      message: `Hello, ${target}!`,
      runtime: `Bun ${Bun.version}`,
    };
  }
}

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

@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
