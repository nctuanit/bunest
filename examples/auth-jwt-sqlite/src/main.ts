import "reflect-metadata";
import { BunestFactory } from "@bunest/core";
import { AppModule, configureAuthSqliteApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureAuthSqliteApp(app);

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest auth-jwt-sqlite listening on http://localhost:${port}`);
