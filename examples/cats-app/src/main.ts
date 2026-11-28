import { BunestFactory } from "@bunest/core";
import { AppModule, configureCatsApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureCatsApp(app);

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest cats-app listening on http://localhost:${port}`);
