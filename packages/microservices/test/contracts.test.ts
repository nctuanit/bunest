import { describe, expect, it } from "bun:test";
import { BunestFactory, Controller, MetadataRegistry, Module } from "@bunest/core";
import {
  ClientProxy,
  EVENT_PATTERN_METADATA,
  EventPattern,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MESSAGE_PATTERN_METADATA,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  Transport,
  defineEventContract,
  defineMessageContract,
  isEventContract,
  isMessageContract,
  type ContractPayload,
  type ContractRequest,
  type ContractResponse,
  type PatternHandlerMetadata,
} from "../src/index";

describe("Type-safe Microservice Contracts (defineMessageContract & defineEventContract)", () => {
  const CreateOrderMsg = defineMessageContract<
    { sku: string; qty: number },
    { orderId: string }
  >("orders.create");

  const CalcSumMsg = defineMessageContract<{ values: number[] }, number>({
    cmd: "sum",
    version: 1,
  });

  const OrderCreatedEvt = defineEventContract<{ orderId: string }>({
    event: "orders.created",
  });

  const OrderUpdatedEvt = defineEventContract<{ orderId: string }>(
    "orders.updated",
  );

  it("registers @MessagePattern(contract) and @EventPattern(contract) with unwrapped patterns, arrays, transport, and extras", () => {
    expect(isMessageContract(CreateOrderMsg)).toBe(true);
    expect(isEventContract(OrderCreatedEvt)).toBe(true);
    expect(isMessageContract(OrderCreatedEvt)).toBe(false);

    class OrdersHandler {
      @MessagePattern([CreateOrderMsg, CalcSumMsg], Transport.TCP, {
        role: "orders",
      })
      createOrder(
        data: ContractRequest<typeof CreateOrderMsg>,
      ): ContractResponse<typeof CreateOrderMsg> {
        return { orderId: `${data.sku}-${data.qty}` };
      }

      @EventPattern([OrderCreatedEvt, OrderUpdatedEvt], { group: "audit" })
      onOrderEvent(_payload: ContractPayload<typeof OrderCreatedEvt>): void {}
    }

    const msgMeta = MetadataRegistry.get<PatternHandlerMetadata[]>(
      MESSAGE_PATTERN_METADATA,
      OrdersHandler,
    );
    expect(msgMeta).toHaveLength(2);
    expect(msgMeta?.[0]?.pattern).toBe("orders.create");
    expect(msgMeta?.[0]?.transport).toBe(Transport.TCP);
    expect(msgMeta?.[0]?.extras).toEqual({ role: "orders" });
    expect(msgMeta?.[1]?.pattern).toEqual({ cmd: "sum", version: 1 });
    expect(msgMeta?.[1]?.transport).toBe(Transport.TCP);

    const evtMeta = MetadataRegistry.get<PatternHandlerMetadata[]>(
      EVENT_PATTERN_METADATA,
      OrdersHandler,
    );
    expect(evtMeta).toHaveLength(2);
    expect(evtMeta?.[0]?.pattern).toEqual({ event: "orders.created" });
    expect(evtMeta?.[0]?.extras).toEqual({ group: "audit" });
    expect(evtMeta?.[1]?.pattern).toBe("orders.updated");
  });

  it("validates patterns, freezes object patterns, and rejects cross-contract misuse", () => {
    expect(() => defineMessageContract("")).toThrow();
    expect(() => defineEventContract("   ")).toThrow();
    expect(() => defineMessageContract(null as any)).toThrow();

    const mutable = { cmd: "ping" };
    const PingMsg = defineMessageContract<void, string>(mutable);
    mutable.cmd = "mutated";
    expect(PingMsg.pattern).toEqual({ cmd: "ping" });

    expect(() => MessagePattern(OrderCreatedEvt as any)).toThrow(
      "@MessagePattern() received an EventContract",
    );
    expect(() => EventPattern(CreateOrderMsg as any)).toThrow(
      "@EventPattern() received a MessageContract",
    );
  });

  it("dispatches typed RPC requests via sendContract() and events via emitContract()", async () => {
    const emitted: Array<{ pattern: string; data: unknown }> = [];

    class MockClient extends ClientProxy {
      readonly transport = Transport.TCP;
      async connect(): Promise<void> {}
      async close(): Promise<void> {}
      protected async sendOnce<TRes = any, TReq = any>(
        _pattern: string,
        data: TReq,
      ): Promise<TRes> {
        const req = data as unknown as { sku: string; qty: number };
        return { orderId: `ord:${req.sku}:${req.qty}` } as unknown as TRes;
      }
      protected async dispatchEvent<TReq = any>(
        pattern: string,
        data: TReq,
      ): Promise<void> {
        emitted.push({ pattern, data });
      }
    }

    const client = new MockClient();
    const res = await client.sendContract(CreateOrderMsg, {
      sku: "BOOK-1",
      qty: 2,
    });
    expect(res).toEqual({ orderId: "ord:BOOK-1:2" });

    await client.emitContract(OrderCreatedEvt, { orderId: "ord:BOOK-1:2" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toEqual({ orderId: "ord:BOOK-1:2" });

    expect(() => client.sendContract(OrderCreatedEvt as any, {} as any)).toThrow(
      "ClientProxy.sendContract() requires a MessageContract",
    );
    expect(() => client.emitContract(CreateOrderMsg as any, {} as any)).toThrow(
      "ClientProxy.emitContract() requires an EventContract",
    );
  });

  it("dispatches contracts end-to-end through MicroserviceHost and respects transport filtering", async () => {
    const broker = new InMemoryBroker();
    const otherBroker = new InMemoryBroker();
    const observedEvents: Array<{ orderId: string }> = [];

    @Controller()
    class OrdersController {
      @MessagePattern(CreateOrderMsg, Transport.IN_MEMORY, { role: "orders" })
      createOrder(
        @Payload() data: ContractRequest<typeof CreateOrderMsg>,
      ): ContractResponse<typeof CreateOrderMsg> {
        return { orderId: `${data.sku}:${data.qty}` };
      }

      @MessagePattern(CalcSumMsg)
      sum(@Payload() data: ContractRequest<typeof CalcSumMsg>): number {
        return data.values.reduce((acc, n) => acc + n, 0);
      }

      @MessagePattern(
        defineMessageContract<{ x: number }, number>("tcp.only"),
        Transport.TCP,
      )
      tcpOnly(@Payload() data: { x: number }): number {
        return data.x * 2;
      }

      @EventPattern([OrderCreatedEvt, OrderUpdatedEvt])
      onOrder(@Payload() payload: ContractPayload<typeof OrderCreatedEvt>) {
        observedEvents.push(payload);
      }
    }

    @Module({
      imports: [
        MicroserviceModule.forRoot({
          transport: Transport.IN_MEMORY,
          options: { broker },
        }),
      ],
      controllers: [OrdersController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    const host = app.get(MicroserviceHost);

    // Add a second server with a custom transportId to verify transport filtering
    const secondaryServer = new InMemoryServer({ broker: otherBroker });
    secondaryServer.transportId = Symbol("SECONDARY");
    host.addServer(secondaryServer);

    await app.init();
    const client = new InMemoryClientProxy({ broker });
    await client.connect();

    try {
      const created = await client.sendContract(CreateOrderMsg, {
        sku: "LAPTOP",
        qty: 3,
      });
      expect(created).toEqual({ orderId: "LAPTOP:3" });

      const sum = await client.sendContract(CalcSumMsg, { values: [2, 3, 5] });
      expect(sum).toBe(10);

      await client.emitContract(OrderCreatedEvt, { orderId: "LAPTOP:3" });
      await client.emitContract(OrderUpdatedEvt, { orderId: "LAPTOP:3-u" });
      expect(observedEvents).toEqual([
        { orderId: "LAPTOP:3" },
        { orderId: "LAPTOP:3-u" },
      ]);

      // TCP-only handler must NOT be registered on the IN_MEMORY server
      const primaryServer = host.getTransportServer()!;
      expect(primaryServer.getHandlerByPattern("tcp.only")).toBeNull();
      // Extras preserved on compiled handler
      expect(
        primaryServer.getHandlerByPattern("orders.create")?.extras,
      ).toEqual({ role: "orders" });
    } finally {
      await client.close();
      await app.close();
    }
  });
});
