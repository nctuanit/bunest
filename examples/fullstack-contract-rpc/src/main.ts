import { BunestFactory } from "@bunest/core";
import { AppModule, configureFullstackContractApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureFullstackContractApp(app);

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Contract RPC server listening on http://localhost:${port}`);
console.log(`Swagger UI available at http://localhost:${port}/docs`);
