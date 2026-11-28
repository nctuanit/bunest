import { BunestFactory } from "@bunest/core";
import { AppModule, configureServeStaticApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureServeStaticApp(app);

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest serve-static listening on http://localhost:${port}`);
