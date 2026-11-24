import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.enableShutdownHooks();
const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest hello-world listening on http://localhost:${port}`);
