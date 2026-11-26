import { BunestFactory } from "@bunest/core";
import { AppModule, configurePlaygroundApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configurePlaygroundApp(app);
app.enableShutdownHooks();

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest Playground listening on http://localhost:${port}`);
console.log(`  Swagger Docs:    http://localhost:${port}/docs`);
console.log(`  Health Check:    http://localhost:${port}/health`);
console.log(`  Prometheus:      http://localhost:${port}/metrics`);
console.log(`  Devtools Graph:  http://localhost:${port}/_devtools/graph`);
