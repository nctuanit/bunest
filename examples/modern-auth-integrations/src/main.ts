import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.enableCors({
  origin: [Bun.env.FRONTEND_ORIGIN ?? "http://localhost:5173"],
  credentials: true,
});

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Modern Auth API running on http://localhost:${port}`);
