import "reflect-metadata";
import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(
  `Bunest distributed-worker listening on http://localhost:${port}`,
);
console.log(`  POST /orders   - Create & trace distributed order job`);
console.log(`  GET  /health   - Liveness probe`);
console.log(`  GET  /metrics  - Prometheus exposition`);
