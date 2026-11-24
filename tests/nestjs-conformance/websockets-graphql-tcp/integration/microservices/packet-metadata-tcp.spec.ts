import { afterEach, beforeEach, expect, it } from "bun:test";
import { Controller, Module } from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  Ctx,
  EventPattern,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  TcpServer,
  Transport,
  createClientProxy,
  type ClientProxy,
  type RpcContext,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

@Controller()
class MetadataController {
  static lastEventMetadata: Readonly<Record<string, unknown>> | undefined;
  static eventReceived: () => void = () => undefined;

  @MessagePattern("echo-metadata")
  echo(@Payload() data: unknown, @Ctx() context: RpcContext) {
    return { data, metadata: context.metadata ?? null };
  }

  @EventPattern("record-metadata")
  record(@Ctx() context: RpcContext) {
    MetadataController.lastEventMetadata = context.metadata;
    MetadataController.eventReceived();
  }
}

/**
 * Packet metadata over a real TCP round trip: verifies dispatch hook behavior
 * and metadata propagation for requests and events.
 */
describeConformance(
  "Packet metadata (TCP)",
  {
    upstreamPath: "integration/microservices/e2e/packet-metadata-tcp.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Uses ephemeral port: 0 native TcpServer + createClientProxy(Transport.TCP) and Promise-based send()/emit(). Wire-level packet metadata round-trip tests capture missing ClientProxy.setOnDispatchHook / RpcEnvelope.metadata propagation.",
  },
  () => {
    let app: BunestMicroserviceApplication<MicroserviceHost> | undefined;
    let client: ClientProxy | undefined;
    let tcpServer: TcpServer | undefined;

    beforeEach(async () => {
      MetadataController.lastEventMetadata = undefined;
      MetadataController.eventReceived = () => undefined;

      tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });

      @Module({
        imports: [MicroserviceModule.forRoot({ server: tcpServer })],
        controllers: [MetadataController],
      })
      class MetadataModule {}

      app = await NestFactory.createMicroservice(
        MetadataModule,
        (ctx) => ctx.get(MicroserviceHost),
        { logger: false },
      );
      await app.listen();

      const port = tcpServer.port!;
      expect(port).toBeGreaterThan(0);

      client = createClientProxy({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      await client.connect();
    });

    afterEach(async () => {
      await client?.close();
      client = undefined;
      await app?.close();
      app = undefined;
      tcpServer = undefined;
    });

    it("delivers what the dispatch hook attached to a request, beside the payload", async () => {
      const dispatchCapable = client as unknown as {
        setOnDispatchHook: (
          fn: (packet: {
            pattern: unknown;
            data: unknown;
            metadata?: Record<string, string>;
          }) => void,
        ) => void;
      };
      dispatchCapable.setOnDispatchHook((packet) => {
        packet.metadata = { "x-request-id": "trace-1" };
      });

      const reply = await client!.send("echo-metadata", { orderId: 7 });

      expect(reply).toEqual({
        data: { orderId: 7 },
        metadata: { "x-request-id": "trace-1" },
      });
    });

    it("delivers it with an event as well", async () => {
      const received = new Promise<void>((resolve) => {
        MetadataController.eventReceived = resolve;
      });
      const dispatchCapable = client as unknown as {
        setOnDispatchHook: (
          fn: (packet: {
            pattern: unknown;
            data: unknown;
            metadata?: Record<string, string>;
          }) => void,
        ) => void;
      };
      dispatchCapable.setOnDispatchHook((packet) => {
        packet.metadata = { "x-request-id": "trace-2" };
      });

      await client!.emit("record-metadata", {});
      await received;

      expect(MetadataController.lastEventMetadata).toEqual({
        "x-request-id": "trace-2",
      });
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "leaves the context without metadata when no hook is set",
      async () => {
        const reply = await client!.send<{
          data: unknown;
          metadata: Record<string, unknown> | null;
        }>("echo-metadata", "plain");

        expect(reply.data).toBe("plain");
        // Bunest TcpServer populates transport-level remoteAddress only; no custom packet metadata
        expect(reply.metadata?.["x-request-id"]).toBeUndefined();
      },
      "TcpServer RpcContext transport metadata without user packet metadata",
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "calls the hook once per packet, with the pattern and the data",
      async () => {
        const seen: unknown[] = [];
        client!.setPreRequestHook((packet) => {
          seen.push({ pattern: packet.pattern, data: packet.data });
        });

        await client!.send("echo-metadata", 1);
        await client!.send("echo-metadata", 2);

        expect(seen).toEqual([
          { pattern: "echo-metadata", data: 1 },
          { pattern: "echo-metadata", data: 2 },
        ]);
      },
      "ClientProxy.setPreRequestHook",
    );
  },
);
