import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(
  `GraphQL schema-first API listening on http://localhost:${port}/graphql`,
);
