import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import { NodeAdapter, type NestNodeApplication } from "@nestjs/platform-node";
import { attachIpcChannel } from "./ipc";
import { AppModule } from "./nestjs-app";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestNodeApplication>(
    AppModule,
    new NodeAdapter(),
    { logger: false },
  );
  await app.listen(0, "127.0.0.1");

  const addr = app.getHttpServer().address() as AddressInfo | null;
  if (!addr || typeof addr !== "object" || !addr.port) {
    throw new Error("Failed to determine NestJS+PlatformNode listening port");
  }

  attachIpcChannel(addr.port, async () => {
    await app.close();
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
