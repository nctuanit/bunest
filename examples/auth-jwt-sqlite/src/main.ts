import { BunestFactory } from "@bunest/core";
import { AppModule, configureAuthSqliteApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureAuthSqliteApp(app);
app.enableShutdownHooks();

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest auth-jwt-sqlite listening on http://localhost:${port}`);
