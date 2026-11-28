import { Inject, Injectable } from "@bunest/core";
import { registerAs, type ConfigType } from "@bunest/core/config";
import { EnvConfigService } from "./env-config/env-config.service";
import { GreetingService } from "./greeting/greeting.module";

export const featureConfig = registerAs("feature", () => ({
  serviceName: "dynamic-modules-demo",
  version: "1.0.0",
}));

@Injectable()
export class AppService {
  constructor(
    private readonly envConfig: EnvConfigService,
    private readonly greeting: GreetingService,
    @Inject(featureConfig.KEY)
    private readonly feature: ConfigType<typeof featureConfig>,
  ) {}

  getInfo(name: string) {
    return {
      greeting: this.greeting.format(name),
      helloMessage: this.envConfig.get("HELLO_MESSAGE"),
      region: this.envConfig.get("APP_REGION"),
      service: this.feature.serviceName,
      version: this.feature.version,
    };
  }
}
