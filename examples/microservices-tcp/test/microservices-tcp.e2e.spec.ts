import { describe, expect, it } from "bun:test";
import { MICROSERVICE_SERVER, TcpServer } from "@bunest/microservices";
import { Test } from "@bunest/testing";
import {
  createMathGatewayModule,
  createMathServerModule,
} from "../src/app.module";
import { MathRpcController } from "../src/math/math-rpc.controller";

describe("Microservices TCP (NestJS 03-microservices E2E)", () => {
  it("communicates between HTTP gateway and live TCP microservice via @MessagePattern, @EventPattern, and RpcException", async () => {
    const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });
    const serverMod = await Test.createTestingModule({
      imports: [createMathServerModule(tcpServer)],
    }).compile();
    await serverMod.init();

    const boundServer = serverMod.get<TcpServer>(MICROSERVICE_SERVER);
    expect(boundServer.port).toBeGreaterThan(0);

    const gatewayMod = await Test.createTestingModule({
      imports: [createMathGatewayModule("127.0.0.1", boundServer.port!)],
    }).compile();
    const httpApp = gatewayMod.createBunestApplication();
    const client = gatewayMod.createTestClient(httpApp);
    await httpApp.init();

    try {
      // 1. Request-reply: sum
      const sumRes = await client.post("/math/sum", {
        json: { numbers: [1, 2, 3, 4, 5] },
      });
      expect(sumRes.status).toBe(201);
      expect(await sumRes.json()).toEqual({ operation: "sum", result: 15 });

      // 2. Request-reply: multiply
      const mulRes = await client.post("/math/multiply", {
        json: { numbers: [2, 3, 7] },
      });
      expect(mulRes.status).toBe(201);
      expect(await mulRes.json()).toEqual({ operation: "multiply", result: 42 });

      // 3. Structured RpcException mapped to 400
      const errRes = await client.post("/math/sum", {
        json: { numbers: [] },
      });
      expect(errRes.status).toBe(400);
      expect(await errRes.json()).toMatchObject({ code: "EMPTY_INPUT" });

      // 4. Fire-and-forget @EventPattern
      const notifyRes = await client.post("/math/notify", {
        json: { operation: "sum", values: [1, 2, 3] },
      });
      expect(notifyRes.status).toBe(201);
      await Bun.sleep(25);

      const rpcController = serverMod.get(MathRpcController);
      expect(rpcController.auditLog).toEqual([
        { operation: "sum", values: [1, 2, 3], transport: "TCP" },
      ]);
    } finally {
      await httpApp.close();
      await serverMod.close();
    }
  });
});
