import "reflect-metadata";
import { BunestFactory } from "@bunest/core";
import { AppModule, configureRestCrudApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureRestCrudApp(app);

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest rest-crud listening on http://localhost:${port}`);
console.log(`OpenAPI docs available at http://localhost:${port}/docs`);
