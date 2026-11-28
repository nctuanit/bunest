import { Module, resolve } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";
import { AppController } from "./app.controller";
import { AppService, featureConfig } from "./app.service";
import { EnvConfigModule } from "./env-config/env-config.module";
import { GreetingModule } from "./greeting/greeting.module";

export const DEFAULT_CONFIG_DIR = resolve(import.meta.dir, "..", "config");

export function createDynamicAppModule(envName: string = "development") {
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [featureConfig],
      }),
      EnvConfigModule.register({
        folder: DEFAULT_CONFIG_DIR,
        envName,
      }),
      GreetingModule.forRoot({
        prefix: envName === "production" ? "Welcome" : "Hi",
        excited: true,
        isGlobal: true,
      }),
    ],
    controllers: [AppController],
    providers: [AppService],
  })
  class DynamicAppModule {}

  return DynamicAppModule;
}

export const AppModule = createDynamicAppModule(
  Bun.env.NODE_ENV ?? "development",
);
