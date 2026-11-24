import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const port = Number(Bun.env.PORT ?? 3100);
const app = await BunestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(port);
console.log(`🚀 Bunest VS Code Extension Showcase running at http://localhost:${port}/users (and /orders)`);
