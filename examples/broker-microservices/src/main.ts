import { BunestFactory } from "@bunest/core";
import { MicroserviceHost } from "@bunest/microservices";
import { createBrokerMicroservicesModule } from "./app.module";

const { AppModule } = createBrokerMicroservicesModule();
const app = await BunestFactory.create(AppModule);
await app.get(MicroserviceHost).listen();

const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Broker Microservices HTTP+RPC app running on http://localhost:${port}`);
