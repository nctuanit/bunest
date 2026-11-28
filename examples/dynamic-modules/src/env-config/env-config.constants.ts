export const ENV_CONFIG_OPTIONS = Symbol("ENV_CONFIG_OPTIONS");

export interface EnvConfigOptions {
  readonly folder: string;
  readonly envName?: string;
}
