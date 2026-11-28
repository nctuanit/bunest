import { Inject, Injectable, join, readTextSync } from "@bunest/core";
import { parseEnvContent } from "@bunest/core/config";
import {
  ENV_CONFIG_OPTIONS,
  type EnvConfigOptions,
} from "./env-config.constants";

@Injectable()
export class EnvConfigService {
  private readonly envConfig: Record<string, string>;

  constructor(@Inject(ENV_CONFIG_OPTIONS) options: EnvConfigOptions) {
    const envName = options.envName ?? Bun.env.NODE_ENV ?? "development";
    const filePath = join(options.folder, `${envName}.env`);
    this.envConfig = parseEnvContent(readTextSync(filePath));
  }

  get(key: string): string | undefined {
    return this.envConfig[key];
  }

  getAll(): Record<string, string> {
    return { ...this.envConfig };
  }
}
