import { describe, expect, it } from "bun:test";
import { GrpcServer, MICROSERVICE_SERVER } from "@bunest/microservices";
import { Test } from "@bunest/testing";
import {
  createHeroGrpcServerModule,
  createHeroHttpGatewayModule,
} from "../src/app.module";
import type { Hero } from "../src/hero/hero.interface";

describe("gRPC Microservice (NestJS 04-grpc E2E)", () => {
  it("executes unary @GrpcMethod with metadata, NOT_FOUND mapping, and server-streaming @GrpcStreamMethod", async () => {
    const grpcServer = new GrpcServer({
      host: "127.0.0.1",
      port: 0,
      package: "hero",
    });
    const grpcMod = await Test.createTestingModule({
      imports: [createHeroGrpcServerModule(grpcServer)],
    }).compile();
    await grpcMod.init();

    const boundServer = grpcMod.get<GrpcServer>(MICROSERVICE_SERVER);
    expect(boundServer.port).toBeGreaterThan(0);

    const gatewayMod = await Test.createTestingModule({
      imports: [createHeroHttpGatewayModule(boundServer.url!)],
    }).compile();
    const httpApp = gatewayMod.createBunestApplication();
    const client = gatewayMod.createTestClient(httpApp);
    await httpApp.init();

    try {
      // 1. Unary gRPC call with request & response metadata
      const oneRes = await client.get("/hero/2", {
        headers: { "x-request-id": "req-grpc-42" },
      });
      expect(oneRes.status).toBe(200);
      expect(await oneRes.json()).toEqual({
        hero: { id: 2, name: "Doe", power: 95 },
        handledBy: "hero-grpc-node",
        echoRequestId: "req-grpc-42",
      });

      // 2. GrpcStatus.NOT_FOUND -> HTTP 404
      const missingRes = await client.get("/hero/999");
      expect(missingRes.status).toBe(404);

      // 3. Server-streaming gRPC call filtered by minPower
      const listRes = await client.get("/hero?minPower=90");
      expect(listRes.status).toBe(200);
      const { heroes } = (await listRes.json()) as { heroes: Hero[] };
      expect(heroes).toEqual([
        { id: 2, name: "Doe", power: 95 },
        { id: 3, name: "Valkyrie", power: 120 },
      ]);
    } finally {
      await httpApp.close();
      await grpcMod.close();
    }
  });
});
