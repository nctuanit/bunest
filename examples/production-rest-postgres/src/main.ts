import { BunestFactory } from "@bunest/core";
import { loadAppConfig, logJson } from "./config";
import { HealthService } from "./health.service";
import { MetricsService } from "./metrics.service";
import { ProductionAppModule, configureProductionApp } from "./app.module";

const config = loadAppConfig();

const app = await BunestFactory.create(ProductionAppModule.register(config), {
  logger: false,
  bodyLimit: config.bodyLimitBytes,
  trustProxy: config.trustProxy,
});

configureProductionApp(app, config);

const health = app.get(HealthService);
const metrics = app.get(MetricsService);

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  health.beginShutdown();
  logJson("info", "shutdown_started", {
    signal,
    inFlight: metrics.getInFlightCount(),
    readinessDelayMs: config.shutdownReadinessDelayMs,
    drainTimeoutMs: config.shutdownDrainTimeoutMs,
  });

  try {
    if (config.shutdownReadinessDelayMs > 0) {
      await Bun.sleep(config.shutdownReadinessDelayMs);
    }
    const drained = await metrics.waitForDrain(config.shutdownDrainTimeoutMs);
    logJson("info", "shutdown_drained", {
      drained,
      remainingInFlight: metrics.getInFlightCount(),
    });
    await app.close();
    logJson("info", "shutdown_complete", { signal });
    process.exit(0);
  } catch (err) {
    logJson("error", "shutdown_error", { signal, error: err });
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

const server = await app.listen(config.port, config.host);
logJson("info", "server_listening", {
  host: config.host,
  port: server.port,
  version: config.appVersion,
  dbPoolMax: config.dbPoolMax,
  databaseUrl: config.databaseUrl,
});
