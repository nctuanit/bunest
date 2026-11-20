export class MissingBullSharedConfigurationError extends Error {
  constructor(configKey: string, queueName?: string) {
    super(
      `Configuration "${configKey}" referenced from the "Queue(${queueName ?? "default"})" options does not exist.`,
    );
    this.name = "MissingBullSharedConfigurationError";
  }
}
