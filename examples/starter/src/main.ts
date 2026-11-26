import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
app.enableShutdownHooks();

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Bunest Sneaker Shop running at http://localhost:${port}`);
