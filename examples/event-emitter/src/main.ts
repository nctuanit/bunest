import { BunestFactory } from "@bunest/core";
import { AppModule, configureEventEmitterApp } from "./app.module";

const app = await BunestFactory.create(AppModule);
configureEventEmitterApp(app);

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest event-emitter listening on http://localhost:${port}`);
