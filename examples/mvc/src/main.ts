import { BunestFactory } from "@bunest/core";
import { AppModule, configureMvcApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureMvcApp(app);

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest MVC listening on http://localhost:${port}`);
