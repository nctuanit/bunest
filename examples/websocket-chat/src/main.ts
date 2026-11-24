import { BunestFactory } from "@bunest/core";
import { WebSocketModule } from "@bunest/core/ws";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
await WebSocketModule.attach(app);
app.enableShutdownHooks();

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest WebSocket chat listening on ws://localhost:${port}/chat`);
