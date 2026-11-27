import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  BadRequestException,
  Body,
  BunestFactory,
  ClsModule,
  ClsService,
  Controller,
  FileInterceptor,
  ForbiddenException,
  FunctionalModule,
  Get,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFileStream,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  createFetchHandler,
  defineRoutes,
  getAmbientTraceparent,
  hasSubscribers,
  join,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
  type StandardSchemaV1,
  type StoredUploadedFile,
  type UploadedFileStream as UploadedFileStreamPart,
} from "../../packages/core/src";
import {
  HttpClient,
  HttpValidationError,
  createContractClient,
  defineContract,
  defineRoute,
} from "../../packages/core/src/client/typed-client-entry";
import {
  McpExpose,
  McpModule,
  McpRegistry,
  type McpContext,
} from "../../packages/ai/src/mcp";
import { connectMcpClient } from "../../packages/ai/src/mcp/testing";
import {
  MemoryQueueDriver,
  Process,
  Processor,
  Queue,
  QueueModule,
  SqlSchedulerLockDriver,
  getQueueToken,
  getSchedulerLockMigrationSql,
  type Job,
} from "../../packages/jobs/src";
import {
  Ctx,
  InMemoryBroker,
  InMemoryClientProxy,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  Transport,
  type RpcContext,
} from "../../packages/microservices/src";
import {
  HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL,
  InMemorySpanExporter,
  JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL,
  JOBS_PROCESS_DIAGNOSTICS_CHANNEL,
  ORM_QUERY_DIAGNOSTICS_CHANNEL,
  ORM_TRANSACTION_DIAGNOSTICS_CHANNEL,
  ObservabilityLogger,
  ObservabilityModule,
  RPC_CLIENT_DIAGNOSTICS_CHANNEL,
  RPC_SERVER_DIAGNOSTICS_CHANNEL,
  Tracer,
  formatTraceParent,
} from "../../packages/observability/src";
import {
  Column,
  DataSource,
  Entity,
  InjectDataSource,
  InjectRepository,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  SqliteOrmDriver,
  Transactional,
  onTransactionCommit,
} from "../../packages/orm/src";
import {
  SqlIdempotencyStore,
  SqlLockStore,
  getIdempotencyMigrationSql,
  getLocksMigrationSql,
} from "../../packages/resilience/src";
import {
  COSE_ALG_ES256,
  COSE_CRV_P256,
  COSE_KTY_EC2,
  CurrentTenant,
  JwtAuthGuard,
  JwtModule,
  JwtService,
  RequireTenant,
  SqlAuthenticationStore,
  TenantGuard,
  TenantRoles,
  WebAuthnService,
  base64UrlDecode,
  base64UrlEncode,
  createBunSqliteAuthExecutor,
  encodeCbor,
  getAuthMigrationSql,
  p1363ToDer,
  type CborKey,
  type CborValue,
} from "../../packages/security/src";
import { AuthenticationStorage } from "../../packages/security/src/auth-next";
import { InMemoryDisk, uploadToDisk } from "../../packages/storage/src";
import {
  ApiGenericResponse,
  ApiOkResponse,
  ApiProperty,
  ApiSchema,
  DocumentBuilder,
  GenericType,
  OmitType,
  PartialType,
  SwaggerModule,
  UnionType,
} from "../../packages/swagger/src";
import { Test } from "../../packages/testing/src";
import { createSchemaDto, s } from "../../packages/validation/src";

// ─────────────────────────────────────────────────────────────────────────────
// Shared deterministic helpers
// ─────────────────────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function sha256Raw(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const digest = new Bun.CryptoHasher("sha256").update(data).digest();
  const out = new Uint8Array(digest.byteLength);
  out.set(digest);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function buildMultipartBytes(
  boundary: string,
  parts: Array<
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly filename: string;
        readonly contentType?: string;
        readonly data: Uint8Array | string;
      }
  >,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(textEncoder.encode(`--${boundary}\r\n`));
    if ("filename" in part) {
      chunks.push(
        textEncoder.encode(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        ),
      );
      if (part.contentType) {
        chunks.push(textEncoder.encode(`Content-Type: ${part.contentType}\r\n`));
      }
      chunks.push(textEncoder.encode("\r\n"));
      chunks.push(
        typeof part.data === "string"
          ? textEncoder.encode(part.data)
          : part.data,
      );
      chunks.push(textEncoder.encode("\r\n"));
    } else {
      chunks.push(
        textEncoder.encode(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`,
        ),
      );
      chunks.push(textEncoder.encode(`${part.value}\r\n`));
    }
  }
  chunks.push(textEncoder.encode(`--${boundary}--\r\n`));
  return concatBytes(...chunks);
}

function streamFromChunks(
  bytes: Uint8Array,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

// Helper preserving strict StandardSchemaV1<T, T> inference over s.object(...)
const objSchema = <T extends object>(shape: Record<string, unknown>) =>
  s.object(shape as Record<string, any>) as unknown as StandardSchemaV1<T, T>;

function makeMcpContext(
  name: string,
  headers: Record<string, string> = {},
): McpContext {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers,
  });
  return {
    kind: "tool",
    name,
    transport: "http",
    era: "modern",
    request: req,
    requestInfo: req,
    signal: new AbortController().signal,
    server: {
      mcpReq: {
        id: "e2e-req-1",
        method: "tools/call",
        notify: async () => {},
      },
    },
    reportProgress: async () => {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 Entities
// ─────────────────────────────────────────────────────────────────────────────

@Entity("e2e_orders")
class E2eOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  tenantId!: string;

  @Column()
  sku!: string;

  @Column("integer")
  totalCents!: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 DTOs (Swagger Generics/Unions + createSchemaDto Mapped Types + MCP)
// ─────────────────────────────────────────────────────────────────────────────

interface CreateProductInput {
  name: string;
  price: number;
  internalCost: number;
  sku?: string;
}

const CreateProductSchema = objSchema<CreateProductInput>({
  name: s.string().min(3),
  price: s.coerce.number().int().min(1),
  internalCost: s.coerce.number().int().min(0).default(0),
  sku: s.string().min(2).optional(),
});

class CreateProductDto extends createSchemaDto(CreateProductSchema) {}
class UpdateProductDto extends PartialType(CreateProductDto) {}
class PublicProductDto extends OmitType(CreateProductDto, [
  "internalCost",
] as const) {}

class ApiEnvelopeDto<T> {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ description: "Envelope payload" })
  data!: T;
}

class PaginatedCatalogDto<T> {
  @ApiProperty({ example: 10 })
  total!: number;

  @ApiProperty({ isArray: true })
  items!: T[];
}

@ApiSchema({ name: "DigitalFulfillment" })
class DigitalFulfillmentDto {
  @ApiProperty({ enum: ["digital"] })
  kind!: "digital";

  @ApiProperty({ format: "uri" })
  downloadUrl!: string;
}

class PhysicalFulfillmentDto {
  @ApiProperty({ enum: ["physical"] })
  kind!: "physical";

  @ApiProperty()
  weightGrams!: number;
}

const FulfillmentUnion = UnionType(
  [DigitalFulfillmentDto, PhysicalFulfillmentDto],
  {
    name: "FulfillmentVariant",
    description: "Product fulfillment strategy",
    discriminator: {
      propertyName: "kind",
      mapping: {
        digital: DigitalFulfillmentDto,
        physical: PhysicalFulfillmentDto,
      },
    },
  },
);

const FulfillmentEnvelopeDto = GenericType(
  ApiEnvelopeDto,
  { data: FulfillmentUnion },
  { name: "FulfillmentEnvelope" },
);

// ═════════════════════════════════════════════════════════════════════════════
// 1. Cross-Subsystem OTel Auto-Instrumentation + CLS + W3C traceparent
// ═════════════════════════════════════════════════════════════════════════════

describe("Community Wishlist E2E Integration Suite", () => {
  describe("1. Cross-Subsystem OTel Auto-Instrumentation + CLS + W3C traceparent Propagation", () => {
    it("automatically emits linked OTel spans with the SAME traceId across ORM, Jobs, Microservices RPC, and HttpClient while propagating CLS & traceparent", async () => {
      const exporter = new InMemorySpanExporter();
      const logLines: string[] = [];
      const broker = new InMemoryBroker();
      const commitHookEvents: Array<{
        orderId: number;
        inTx: boolean;
        tenantId?: string;
      }> = [];
      const jobSnapshots: Array<{
        orderId: number;
        tenantId?: string;
        userId?: string;
        traceparent?: string;
        metaTraceparent?: unknown;
      }> = [];
      const rpcObserved: Array<{
        sku: string;
        tenantId?: string;
        userId?: string;
        traceparent?: string;
        metaTraceparent?: unknown;
      }> = [];
      const outboundHttpHeaders: Array<{
        traceparent: string | null;
        tenantId: string | null;
      }> = [];

      const ephemeralServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          outboundHttpHeaders.push({
            traceparent: req.headers.get("traceparent"),
            tenantId: req.headers.get("x-tenant-id"),
          });
          return Response.json({ carrier: "fastship", cents: 750 });
        },
      });

      @Injectable()
      class OrderPersistenceService {
        constructor(
          @InjectDataSource() private readonly dataSource: DataSource,
          @InjectRepository(E2eOrder)
          private readonly orderRepo: OrmRepository<E2eOrder>,
          private readonly cls: ClsService,
        ) {}

        @Transactional({ isolationLevel: "SERIALIZABLE" })
        async createOrderTransactional(
          sku: string,
          totalCents: number,
        ): Promise<E2eOrder> {
          const tenantId = this.cls.get<string>("tenantId") ?? "unknown";
          const saved = await this.orderRepo.save({
            tenantId,
            sku,
            totalCents,
          });
          const count = await this.orderRepo.count();
          expect(count).toBeGreaterThanOrEqual(1);

          onTransactionCommit(async () => {
            commitHookEvents.push({
              orderId: saved.id,
              inTx: this.dataSource.driver.isInTransaction(),
              tenantId: this.cls.get<string>("tenantId"),
            });
          });

          return saved;
        }
      }

      @Processor("e2e-orders")
      class OrderNotificationsProcessor {
        constructor(private readonly cls: ClsService) {}

        @Process("notify")
        async handleNotify(job: Job<{ orderId: number }>) {
          jobSnapshots.push({
            orderId: job.data.orderId,
            tenantId: this.cls.get<string>("tenantId"),
            userId: this.cls.get<string>("userId"),
            traceparent: this.cls.get<string>("traceparent"),
            metaTraceparent: job.metadata?.traceparent,
          });
        }
      }

      @Controller()
      class InventoryRpcController {
        constructor(private readonly cls: ClsService) {}

        @MessagePattern("inventory.reserve")
        reserve(
          @Payload() payload: { sku: string; qty: number },
          @Ctx() ctx: RpcContext,
        ) {
          const snapshot = {
            sku: payload.sku,
            tenantId: this.cls.get<string>("tenantId"),
            userId: this.cls.get<string>("userId"),
            traceparent: this.cls.get<string>("traceparent"),
            metaTraceparent: ctx.metadata?.traceparent,
          };
          rpcObserved.push(snapshot);
          return { reserved: true, ...snapshot };
        }
      }

      @Module({
        imports: [
          ClsModule.forRoot({ global: true }),
          ObservabilityModule.forRoot({
            tracing: { serviceName: "wishlist-e2e", exporter },
            autoInstrument: true,
            logging: {
              clsKeys: ["tenantId", "userId"],
              json: true,
              writer: (line) => {
                logLines.push(line);
              },
            },
          }),
          OrmModule.forRoot({
            type: "sqlite",
            database: ":memory:",
            entities: [E2eOrder],
            synchronize: true,
          }),
          OrmModule.forFeature([E2eOrder]),
          QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
          QueueModule.registerQueue({ name: "e2e-orders", concurrency: 2 }),
          MicroserviceModule.forRoot({
            transport: Transport.IN_MEMORY,
            options: { channel: "e2e-rpc", broker },
          }),
        ],
        controllers: [InventoryRpcController],
        providers: [OrderPersistenceService, OrderNotificationsProcessor],
      })
      class CrossSubsystemAppModule {}

      const app = await BunestFactory.create(CrossSubsystemAppModule, {
        logger: false,
      });
      await app.init();

      const host = app.get(MicroserviceHost);
      await host.listen();

      const rpcClient = new InMemoryClientProxy({
        channel: "e2e-rpc",
        broker,
      });
      await rpcClient.connect();

      try {
        const cls = app.get(ClsService);
        const tracer = app.get(Tracer);
        const logger = app.get(ObservabilityLogger);
        const dataSource = app.get(DataSource);
        const orderService = app.get(OrderPersistenceService);
        const queue = app.get<Queue<{ orderId: number }>>(
          getQueueToken("e2e-orders"),
        );

        expect(dataSource.driver).toBeInstanceOf(SqliteOrmDriver);
        expect(hasSubscribers(ORM_QUERY_DIAGNOSTICS_CHANNEL)).toBe(true);
        expect(hasSubscribers(ORM_TRANSACTION_DIAGNOSTICS_CHANNEL)).toBe(true);
        expect(hasSubscribers(JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL)).toBe(true);
        expect(hasSubscribers(JOBS_PROCESS_DIAGNOSTICS_CHANNEL)).toBe(true);
        expect(hasSubscribers(RPC_CLIENT_DIAGNOSTICS_CHANNEL)).toBe(true);
        expect(hasSubscribers(RPC_SERVER_DIAGNOSTICS_CHANNEL)).toBe(true);
        expect(hasSubscribers(HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL)).toBe(
          true,
        );

        // Bootstrap `synchronize: true` DDL query was already auto-instrumented during init
        expect(
          exporter
            .getFinishedSpans()
            .some(
              (span) =>
                span.attributes["db.system"] === "sqlite" &&
                span.attributes["db.operation"] === "CREATE",
            ),
        ).toBe(true);
        exporter.reset();

        let rootTraceId = "";
        let rootSpanId = "";
        let expectedTraceparent = "";
        let createdOrderId = 0;

        await cls.run(
          async () => {
            await tracer.startActiveSpan(
              "checkout.e2e",
              async (rootSpan) => {
                rootTraceId = rootSpan.traceId;
                rootSpanId = rootSpan.spanId;
                expectedTraceparent = formatTraceParent(rootSpan.context);

                expect(getAmbientTraceparent()).toBe(expectedTraceparent);

                // Structured logger enriches CLS keys + active traceId
                logger.info({ stage: "checkout" }, "starting e2e checkout");

                // 1a. ORM @Transactional() + onTransactionCommit
                const order = await orderService.createOrderTransactional(
                  "SKU-WIDGET",
                  4900,
                );
                createdOrderId = order.id;
                expect(createdOrderId).toBeGreaterThan(0);

                // Also exercise DataSource.transaction() directly with a SELECT query
                const fetched = await dataSource.transaction(async (em) =>
                  em.findOneBy(E2eOrder, { id: createdOrderId }),
                );
                expect(fetched?.tenantId).toBe("acme");

                // 1b. Queue enqueue with delay so worker executes outside caller's sync ALS stack
                const enqueued = await queue.add(
                  "notify",
                  { orderId: createdOrderId },
                  {
                    delayMs: 15,
                    tenantId: "acme",
                    metadata: { origin: "e2e-checkout" },
                  },
                );
                expect(enqueued.metadata?.traceparent).toBe(
                  expectedTraceparent,
                );

                // 1c. Microservice RPC client.send() -> @MessagePattern()
                const rpcRes = await rpcClient.send<{
                  reserved: boolean;
                  tenantId?: string;
                  userId?: string;
                  traceparent?: string;
                  metaTraceparent?: string;
                }>("inventory.reserve", { sku: "SKU-WIDGET", qty: 2 });
                expect(rpcRes.reserved).toBe(true);
                expect(rpcRes.tenantId).toBe("acme");
                expect(rpcRes.userId).toBe("u-42");
                expect(rpcRes.traceparent).toBe(expectedTraceparent);
                expect(rpcRes.metaTraceparent).toBe(expectedTraceparent);

                // 1d. Outgoing HttpClient against ephemeral Bun.serve on port 0
                const httpClient = new HttpClient({
                  baseUrl: `http://127.0.0.1:${ephemeralServer.port}`,
                  propagateClsHeaders: true,
                });
                const quoteRes = await httpClient.get<{
                  carrier: string;
                  cents: number;
                }>("/shipping/quote");
                expect(quoteRes.status).toBe(200);
                expect(quoteRes.data).toEqual({
                  carrier: "fastship",
                  cents: 750,
                });
              },
            );
          },
          {
            tenantId: "acme",
            userId: "u-42",
            requestId: "req-e2e-1",
          },
        );

        // Wait for delayed background queue worker to finish processing
        await waitUntil(() => jobSnapshots.length === 1);

        // Verify onTransactionCommit ran strictly after outermost commit (outside tx)
        expect(commitHookEvents).toHaveLength(1);
        expect(commitHookEvents[0]).toEqual({
          orderId: createdOrderId,
          inTx: false,
          tenantId: "acme",
        });

        // Verify Queue worker restored CLS & received exact parent traceparent
        expect(jobSnapshots[0]).toEqual({
          orderId: createdOrderId,
          tenantId: "acme",
          userId: "u-42",
          traceparent: expectedTraceparent,
          metaTraceparent: expectedTraceparent,
        });

        // Verify RPC handler observed CLS & traceparent
        expect(rpcObserved).toHaveLength(1);
        expect(rpcObserved[0]?.tenantId).toBe("acme");
        expect(rpcObserved[0]?.userId).toBe("u-42");
        expect(rpcObserved[0]?.traceparent).toBe(expectedTraceparent);

        // Verify HttpClient injected matching W3C traceparent & CLS x-tenant-id
        expect(outboundHttpHeaders).toHaveLength(1);
        expect(outboundHttpHeaders[0]?.traceparent).toBe(expectedTraceparent);
        expect(outboundHttpHeaders[0]?.tenantId).toBe("acme");

        // Verify ObservabilityLogger auto-enriched clsKeys + traceId
        const parsedLogs = logLines.map(
          (line) => JSON.parse(line) as Record<string, unknown>,
        );
        const checkoutLog = parsedLogs.find(
          (entry) => entry.message === "starting e2e checkout",
        );
        expect(checkoutLog).toBeDefined();
        expect(checkoutLog?.tenantId).toBe("acme");
        expect(checkoutLog?.userId).toBe("u-42");
        expect(checkoutLog?.traceId).toBe(rootTraceId);

        // Assert ALL 4 subsystems automatically emitted linked OTel spans with the SAME traceId!
        const spans = exporter.getFinishedSpans();

        const ormQuerySpans = spans.filter(
          (span) =>
            span.attributes["db.system"] === "sqlite" &&
            span.attributes["db.operation"] !== "TRANSACTION",
        );
        const ormTxSpans = spans.filter(
          (span) =>
            span.attributes["db.operation"] === "TRANSACTION" &&
            span.attributes["db.transaction.phase"] === "commit",
        );
        const jobProducerSpan = spans.find(
          (span) =>
            span.kind === "PRODUCER" &&
            span.attributes["messaging.system"] === "bunest.jobs" &&
            span.attributes["messaging.destination.name"] === "e2e-orders",
        );
        const jobConsumerSpan = spans.find(
          (span) =>
            span.kind === "CONSUMER" &&
            span.attributes["messaging.system"] === "bunest.jobs" &&
            span.attributes["messaging.destination.name"] === "e2e-orders",
        );
        const rpcClientSpan = spans.find(
          (span) =>
            span.kind === "CLIENT" &&
            span.attributes["rpc.method"] === "inventory.reserve",
        );
        const rpcServerSpan = spans.find(
          (span) =>
            span.kind === "SERVER" &&
            span.attributes["rpc.method"] === "inventory.reserve",
        );
        const httpClientSpan = spans.find(
          (span) =>
            span.kind === "CLIENT" &&
            span.attributes["http.request.method"] === "GET" &&
            span.attributes["url.path"] === "/shipping/quote",
        );

        expect(ormQuerySpans.length).toBeGreaterThanOrEqual(2);
        expect(ormTxSpans.length).toBeGreaterThanOrEqual(2);
        expect(jobProducerSpan).toBeDefined();
        expect(jobConsumerSpan).toBeDefined();
        expect(rpcClientSpan).toBeDefined();
        expect(rpcServerSpan).toBeDefined();
        expect(httpClientSpan).toBeDefined();

        const linkedSpans = [
          ...ormQuerySpans,
          ...ormTxSpans,
          jobProducerSpan!,
          jobConsumerSpan!,
          rpcClientSpan!,
          rpcServerSpan!,
          httpClientSpan!,
        ];

        for (const span of linkedSpans) {
          expect(span.traceId).toBe(rootTraceId);
          expect(span.parentSpanId).toBe(rootSpanId);
          expect(span.status.code).toBe("OK");
        }

        expect(httpClientSpan!.attributes["http.response.status_code"]).toBe(
          200,
        );
      } finally {
        await rpcClient.close();
        await app.close();
        ephemeralServer.stop(true);
      }

      // Auto-instrumentation unsubscribes & releases ambient traceparent on close
      expect(hasSubscribers(ORM_QUERY_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(hasSubscribers(JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(hasSubscribers(RPC_CLIENT_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(hasSubscribers(HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL)).toBe(
        false,
      );
      expect(getAmbientTraceparent()).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Typed Contract Client + Functional Routes + Single-Flight + Streaming
  // ═══════════════════════════════════════════════════════════════════════════

  describe("2. Typed Contract Client + Functional Routes + Single-Flight createFetchHandler + Streaming FileInterceptor", () => {
    it("serves a Standard-Schema contract over FunctionalModule + single-flight createFetchHandler and calls it via @bunest/core/typed-client", async () => {
      // Verify the public `@bunest/core/typed-client` package export resolves to the browser-pure entry
      const resolvedTypedClientEntry = Bun.resolveSync(
        "@bunest/core/typed-client",
        join(import.meta.dir, "../../packages/observability"),
      );
      expect(resolvedTypedClientEntry.replace(/\\/g, "/")).toEndWith(
        "/packages/core/src/client/typed-client-entry.ts",
      );

      const widgetParamsSchema = objSchema<{ id: number }>({
        id: s.coerce.number().int().min(1),
      });
      const widgetQuerySchema = objSchema<{ verbose?: boolean }>({
        verbose: s.coerce.boolean().optional(),
      });
      const createWidgetBodySchema = objSchema<{
        name: string;
        quantity: number;
      }>({
        name: s.string().min(2),
        quantity: s.coerce.number().int().min(1),
      });
      const widgetResponseSchema = objSchema<{
        id: number;
        name: string;
        quantity: number;
        verbose?: boolean;
      }>({
        id: s.number().int().min(1),
        name: s.string(),
        quantity: s.number().int().min(1),
        verbose: s.boolean().optional(),
      });

      const contract = defineContract(
        {
          widgets: {
            get: defineRoute({
              method: "GET",
              path: "/widgets/:id",
              params: widgetParamsSchema,
              query: widgetQuerySchema,
              response: widgetResponseSchema,
            }),
            create: defineRoute({
              method: "POST",
              path: "/widgets",
              body: createWidgetBodySchema,
              response: widgetResponseSchema,
            }),
          },
        },
        { basePath: "/api/v1" },
      );

      let initCount = 0;

      @Injectable()
      class WidgetsRepository implements OnModuleInit {
        private nextId = 2;
        private readonly rows = new Map<
          number,
          { id: number; name: string; quantity: number }
        >([[1, { id: 1, name: "Sprocket", quantity: 5 }]]);

        async onModuleInit(): Promise<void> {
          initCount += 1;
          await Bun.sleep(20);
        }

        findById(id: number) {
          return this.rows.get(id);
        }

        create(name: string, quantity: number) {
          const record = { id: this.nextId++, name, quantity };
          this.rows.set(record.id, record);
          return record;
        }
      }

      const widgetRoutes = defineRoutes("/api/v1", (r) => {
        r.get(
          "/widgets/:id",
          {
            paramsSchema: widgetParamsSchema,
            querySchema: widgetQuerySchema,
            responseSchema: widgetResponseSchema,
          },
          (ctx) => {
            const repo = ctx.get(WidgetsRepository);
            const found = repo.findById(ctx.params.id);
            if (!found) {
              throw new BadRequestException("Widget not found");
            }
            return {
              ...found,
              ...(ctx.query.verbose !== undefined
                ? { verbose: ctx.query.verbose }
                : {}),
            };
          },
        ).post(
          "/widgets",
          {
            bodySchema: createWidgetBodySchema,
            responseSchema: widgetResponseSchema,
            httpCode: 201,
          },
          (ctx) => {
            const repo = ctx.get(WidgetsRepository);
            return repo.create(ctx.body.name, ctx.body.quantity);
          },
        );
      });

      @Module({
        imports: [FunctionalModule.forRoutes(widgetRoutes)],
        providers: [WidgetsRepository],
      })
      class ContractAppModule {}

      const handler = createFetchHandler(ContractAppModule, { logger: false });
      let serverFetchCount = 0;

      const fetchAdapter = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        serverFetchCount += 1;
        const req =
          input instanceof Request
            ? input
            : new Request(input instanceof URL ? input.href : input, init);
        return handler.fetch(req);
      }) as typeof globalThis.fetch;

      const client = createContractClient(contract, {
        baseUrl: "http://wishlist.local",
        fetch: fetchAdapter,
      });

      try {
        // Concurrent cold-start requests prove single-flight bootstrap (initCount === 1)
        const concurrentResponses = await Promise.all(
          Array.from({ length: 10 }, () =>
            client.widgets.get({ params: { id: 1 }, query: { verbose: true } }),
          ),
        );
        expect(initCount).toBe(1);
        expect(serverFetchCount).toBe(10);
        for (const res of concurrentResponses) {
          expect(res.status).toBe(200);
          expect(res.data).toEqual({
            id: 1,
            name: "Sprocket",
            quantity: 5,
            verbose: true,
          });
        }

        // Typed POST route validates body & response end-to-end
        const created = await client.widgets.create({
          body: { name: "Gearbox", quantity: 12 },
        });
        expect(created.status).toBe(201);
        expect(created.data).toEqual({
          id: 2,
          name: "Gearbox",
          quantity: 12,
        });

        // Fetch newly created widget through typed client
        const fetched = await client.widgets.get({ params: { id: 2 } });
        expect(fetched.status).toBe(200);
        expect(fetched.data).toEqual({
          id: 2,
          name: "Gearbox",
          quantity: 12,
        });

        // Client-side Standard Schema validation fails fast BEFORE calling fetch
        const beforeInvalid = serverFetchCount;
        await expect(
          client.widgets.create({
            body: { name: "x", quantity: 0 },
          }),
        ).rejects.toBeInstanceOf(HttpValidationError);
        expect(serverFetchCount).toBe(beforeInvalid);
      } finally {
        await handler.close();
      }
    });

    it("streams multipart uploads via FileInterceptor({ mode: 'stream' }) + @UploadedFileStream() directly into @bunest/storage InMemoryDisk via uploadToDisk()", async () => {
      const disk = new InMemoryDisk();

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x01, 0x02, 0x03, 0x04,
      ]);

      const diskStorageEngine = uploadToDisk({
        disk,
        key: (file) => `uploads/${file.originalname}`,
        contentTypes: ["image/png"],
      });

      @Controller("/files")
      class StreamingUploadController {
        // Plug-and-play streaming bridge: FileInterceptor({ mode: "stream", storage: uploadToDisk(...) }) + @UploadedFileStream()
        @Post("upload-disk")
        @UseInterceptors(
          FileInterceptor("file", {
            mode: "stream",
            storage: diskStorageEngine,
          }),
        )
        uploadViaStorageEngine(
          @UploadedFileStream() stored: StoredUploadedFile,
        ) {
          return {
            key: stored.key,
            size: stored.size,
            contentType: stored.contentType,
            etag: stored.etag,
          };
        }

        // Rollback verification: if handler throws after uploadToDisk writes, _removeFile deletes the object
        @Post("upload-disk-fail")
        @UseInterceptors(
          FileInterceptor("file", {
            mode: "stream",
            storage: diskStorageEngine,
          }),
        )
        uploadViaStorageEngineFail() {
          throw new Error("downstream metadata save failed");
        }

        // Pure mode: "stream" route receiving live @UploadedFileStream() and streaming into InMemoryDisk via uploadToDisk()
        @Post("upload-raw-stream")
        @UseInterceptors(FileInterceptor("file", { mode: "stream" }))
        async uploadLiveStream(
          @UploadedFileStream() file: UploadedFileStreamPart,
        ) {
          const engine = uploadToDisk({
            disk,
            key: (info) => `raw/${info.originalname}`,
            detectContentType: (_bytes, info) =>
              info.mimetype || "text/plain",
          });
          const stored = await new Promise<Record<string, unknown>>(
            (resolve, reject) => {
              engine._handleFile(
                {},
                {
                  fieldname: file.fieldname,
                  originalname: file.originalname,
                  mimetype: file.mimetype,
                  stream: file.stream,
                  truncated: file.truncated,
                },
                (err, info) => {
                  if (err) reject(err);
                  else resolve((info ?? {}) as Record<string, unknown>);
                },
              );
            },
          );
          return {
            ...stored,
            bytesRead: file.bytesRead,
          };
        }
      }

      @Module({ controllers: [StreamingUploadController] })
      class UploadAppModule {}

      const handler = createFetchHandler(UploadAppModule, { logger: false });
      const boundary = "----WishlistStreamBoundary";

      const makeMultipartReq = (
        path: string,
        filename: string,
        contentType: string,
        data: Uint8Array | string,
      ) =>
        new Request(`http://wishlist.local/files/${path}`, {
          method: "POST",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body: streamFromChunks(
            buildMultipartBytes(boundary, [
              { name: "file", filename, contentType, data },
            ]),
            7,
          ),
        });

      try {
        // 1. Magic-byte sniffing detects image/png even when client sends application/octet-stream
        const resPng = await handler.fetch(
          makeMultipartReq(
            "upload-disk",
            "avatar.png",
            "application/octet-stream",
            pngBytes,
          ),
        );
        expect(resPng.status).toBe(201);
        const pngMeta = (await resPng.json()) as {
          key: string;
          size: number;
          contentType: string;
          etag: string;
        };
        expect(pngMeta.key).toBe("uploads/avatar.png");
        expect(pngMeta.size).toBe(pngBytes.byteLength);
        expect(pngMeta.contentType).toBe("image/png");
        expect(typeof pngMeta.etag).toBe("string");
        expect(await disk.exists("uploads/avatar.png")).toBe(true);
        expect(new Uint8Array(await disk.getBuffer("uploads/avatar.png"))).toEqual(
          pngBytes,
        );

        // 2. Non-PNG content rejected by uploadToDisk contentTypes allowlist with 415
        const resBad = await handler.fetch(
          makeMultipartReq(
            "upload-disk",
            "evil.png",
            "image/png",
            "alert('not a real png')",
          ),
        );
        expect(resBad.status).toBe(415);
        expect(await disk.exists("uploads/evil.png")).toBe(false);

        // 3. Downstream handler error rolls back stored file from InMemoryDisk via _removeFile
        const resRollback = await handler.fetch(
          makeMultipartReq(
            "upload-disk-fail",
            "orphan.png",
            "image/png",
            pngBytes,
          ),
        );
        expect(resRollback.status).toBe(500);
        expect(await disk.exists("uploads/orphan.png")).toBe(false);

        // 4. Pure mode: "stream" + @UploadedFileStream() -> uploadToDisk() -> InMemoryDisk
        const payloadText = "zero-buffer streaming multipart payload into disk";
        const resRaw = await handler.fetch(
          makeMultipartReq(
            "upload-raw-stream",
            "notes.txt",
            "text/plain",
            payloadText,
          ),
        );
        expect(resRaw.status).toBe(201);
        const rawMeta = (await resRaw.json()) as {
          key: string;
          size: number;
          contentType: string;
          bytesRead: number;
        };
        expect(rawMeta.key).toBe("raw/notes.txt");
        expect(rawMeta.size).toBe(payloadText.length);
        expect(rawMeta.bytesRead).toBe(payloadText.length);
        expect(rawMeta.contentType).toBe("text/plain");
        expect(await disk.getText("raw/notes.txt")).toBe(payloadText);
      } finally {
        await handler.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Security (TenantGuard + WebAuthnService) + Resilience SQLite Stores
  // ═══════════════════════════════════════════════════════════════════════════

  describe("3. Security (TenantGuard + WebAuthnService) + Resilience SQLite Stores", () => {
    it("TenantGuard propagates verified tenantId into ClsService, enforces @TenantRoles, and rejects spoofed x-tenant-id with 403", async () => {
      @Injectable()
      class TenantAwareRepo {
        constructor(private readonly cls: ClsService) {}

        getAmbientTenantId(): string | undefined {
          return this.cls.get<string>("tenantId");
        }
      }

      @Controller("/secure")
      class TenantProtectedController {
        constructor(private readonly repo: TenantAwareRepo) {}

        @RequireTenant()
        @Get("profile")
        getProfile(@CurrentTenant() tenant: string) {
          return {
            tenant,
            clsTenant: this.repo.getAmbientTenantId(),
          };
        }

        @RequireTenant({ sources: ["header", "user"] })
        @TenantRoles("admin")
        @Get("admin")
        getAdmin(@CurrentTenant() tenant: string) {
          return {
            tenant,
            clsTenant: this.repo.getAmbientTenantId(),
            admin: true,
          };
        }
      }

      const mod = await Test.createTestingModule({
        imports: [
          ClsModule.forRoot({ global: true, middleware: { mount: true } }),
          JwtModule.register({ secret: "e2e-tenant-guard-secret" }),
        ],
        controllers: [TenantProtectedController],
        providers: [
          TenantAwareRepo,
          { provide: APP_GUARD, useClass: JwtAuthGuard },
          { provide: APP_GUARD, useClass: TenantGuard },
        ],
      }).compile();

      try {
        const client = mod.createTestClient();
        const jwt = mod.get(JwtService);

        const acmeToken = await jwt.sign({ sub: "u-acme", tenantId: "acme" });
        const multiTenantToken = await jwt.sign({
          sub: "u-multi",
          tenants: ["acme", "beta"],
          tenantRoles: {
            acme: ["admin"],
            beta: ["viewer"],
          },
        });

        // Verified tenant propagates into both @CurrentTenant() and ClsService
        const okRes = await client
          .withBearerToken(acmeToken)
          .get("/secure/profile");
        expect(okRes.status).toBe(200);
        expect(await okRes.json()).toEqual({
          tenant: "acme",
          clsTenant: "acme",
        });

        // Spoofed x-tenant-id header mismatches JWT tenant -> 403 Forbidden
        const spoofedRes = await client
          .withBearerToken(acmeToken)
          .get("/secure/profile", {
            headers: { "x-tenant-id": "evil-corp" },
          });
        expect(spoofedRes.status).toBe(403);

        // Tenant-scoped roles: admin on acme -> 200; viewer on beta -> 403; non-member gamma -> 403
        const adminAcme = await client
          .withBearerToken(multiTenantToken)
          .get("/secure/admin", { headers: { "x-tenant-id": "acme" } });
        expect(adminAcme.status).toBe(200);
        expect(await adminAcme.json()).toEqual({
          tenant: "acme",
          clsTenant: "acme",
          admin: true,
        });

        const viewerBeta = await client
          .withBearerToken(multiTenantToken)
          .get("/secure/admin", { headers: { "x-tenant-id": "beta" } });
        expect(viewerBeta.status).toBe(403);

        const nonMemberGamma = await client
          .withBearerToken(multiTenantToken)
          .get("/secure/admin", { headers: { "x-tenant-id": "gamma" } });
        expect(nonMemberGamma.status).toBe(403);
      } finally {
        await mod.close();
      }
    });

    it("WebAuthnService completes real ES256 (P-256) passkey registration, authentication, and replay rejection backed by bun:sqlite SqlAuthenticationStore", async () => {
      const db = new Database(":memory:");
      try {
        db.exec(getAuthMigrationSql("sqlite"));

        const sqlStore = new SqlAuthenticationStore(
          createBunSqliteAuthExecutor(db),
          { dialect: "sqlite" },
        );
        const authStorage = new AuthenticationStorage();
        sqlStore.registerInto(authStorage);

        let clock = 1_800_000_000_000;
        const webauthn = new WebAuthnService(authStorage, {
          webauthn: {
            rpId: "app.bunest.dev",
            rpName: "Bunest E2E",
            origin: "https://app.bunest.dev",
            now: () => clock,
          },
        });

        // Generate real WebCrypto P-256 authenticator key pair
        const keyPair = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        );
        const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
        const coseBytes = encodeCbor(
          new Map<CborKey, CborValue>([
            [1, COSE_KTY_EC2],
            [3, COSE_ALG_ES256],
            [-1, COSE_CRV_P256],
            [-2, base64UrlDecode(jwk.x!)],
            [-3, base64UrlDecode(jwk.y!)],
          ]),
        );
        const credentialId = crypto.getRandomValues(new Uint8Array(32));

        const signDer = async (
          payload: Uint8Array,
        ): Promise<Uint8Array<ArrayBuffer>> => {
          const copy = new Uint8Array(payload.byteLength);
          copy.set(payload);
          const p1363Sig = new Uint8Array(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              keyPair.privateKey,
              copy,
            ),
          );
          return p1363ToDer(p1363Sig, 32);
        };

        const buildAuthData = (opts: {
          flags: number;
          signCount: number;
          includeAttestedCred?: boolean;
        }): Uint8Array<ArrayBuffer> => {
          const header = new Uint8Array(37);
          header.set(sha256Raw(textEncoder.encode("app.bunest.dev")), 0);
          header[32] = opts.flags;
          new DataView(header.buffer).setUint32(33, opts.signCount, false);
          if (!opts.includeAttestedCred) {
            return header;
          }
          const aaguid = new Uint8Array(16);
          const lenBuf = new Uint8Array(2);
          new DataView(lenBuf.buffer).setUint16(0, credentialId.byteLength, false);
          return concatBytes(header, aaguid, lenBuf, credentialId, coseBytes);
        };

        // 1. Register passkey with packed self-attestation
        const regOpts = await webauthn.generateRegistrationOptions({
          userId: "user-passkey-1",
          userName: "ada@bunest.dev",
          userDisplayName: "Ada",
        });
        const regClientDataBytes = textEncoder.encode(
          JSON.stringify({
            type: "webauthn.create",
            challenge: regOpts.challenge,
            origin: "https://app.bunest.dev",
            crossOrigin: false,
          }),
        );
        const regAuthData = buildAuthData({
          flags: 0x01 | 0x04 | 0x40, // UP | UV | AT
          signCount: 1,
          includeAttestedCred: true,
        });
        const regSig = await signDer(
          concatBytes(regAuthData, sha256Raw(regClientDataBytes)),
        );
        const attestationObject = encodeCbor(
          new Map<CborKey, CborValue>([
            ["fmt", "packed"],
            ["authData", regAuthData],
            [
              "attStmt",
              new Map<CborKey, CborValue>([
                ["alg", COSE_ALG_ES256],
                ["sig", regSig],
              ]),
            ],
          ]),
        );

        const regResult = await webauthn.verifyRegistration({
          userId: "user-passkey-1",
          name: "Security Key",
          id: base64UrlEncode(credentialId),
          response: {
            clientDataJSON: base64UrlEncode(regClientDataBytes),
            attestationObject: base64UrlEncode(attestationObject),
            transports: ["internal"],
          },
        });
        expect(regResult.verified).toBe(true);
        expect(regResult.credential.counter).toBe(1);
        expect(await webauthn.listPasskeys("user-passkey-1")).toHaveLength(1);

        // 2. Authenticate passkey with monotonic signCount (1 -> 2)
        const authOpts = await webauthn.generateAuthenticationOptions({
          userId: "user-passkey-1",
        });
        const authClientDataBytes = textEncoder.encode(
          JSON.stringify({
            type: "webauthn.get",
            challenge: authOpts.challenge,
            origin: "https://app.bunest.dev",
          }),
        );
        const authData = buildAuthData({
          flags: 0x01 | 0x04, // UP | UV
          signCount: 2,
        });
        const assertionSig = await signDer(
          concatBytes(authData, sha256Raw(authClientDataBytes)),
        );

        clock += 2_000;
        const authResult = await webauthn.verifyAuthentication({
          userId: "user-passkey-1",
          id: regResult.credential.id,
          response: {
            clientDataJSON: base64UrlEncode(authClientDataBytes),
            authenticatorData: base64UrlEncode(authData),
            signature: base64UrlEncode(assertionSig),
          },
        });
        expect(authResult.verified).toBe(true);
        expect(authResult.newCounter).toBe(2);

        // 3. Replaying single-use challenge is rejected
        await expect(
          webauthn.verifyAuthentication({
            userId: "user-passkey-1",
            id: regResult.credential.id,
            response: {
              clientDataJSON: base64UrlEncode(authClientDataBytes),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(assertionSig),
            },
          }),
        ).rejects.toMatchObject({ code: "webauthn_invalid_challenge" });

        // 4. Stale signCount replay attack is rejected by atomic SQL counter check
        const replayOpts = await webauthn.generateAuthenticationOptions({
          userId: "user-passkey-1",
        });
        const replayCdBytes = textEncoder.encode(
          JSON.stringify({
            type: "webauthn.get",
            challenge: replayOpts.challenge,
            origin: "https://app.bunest.dev",
          }),
        );
        const staleAuthData = buildAuthData({
          flags: 0x01 | 0x04,
          signCount: 2, // not strictly greater than stored counter 2
        });
        const staleSig = await signDer(
          concatBytes(staleAuthData, sha256Raw(replayCdBytes)),
        );
        await expect(
          webauthn.verifyAuthentication({
            userId: "user-passkey-1",
            id: regResult.credential.id,
            response: {
              clientDataJSON: base64UrlEncode(replayCdBytes),
              authenticatorData: base64UrlEncode(staleAuthData),
              signature: base64UrlEncode(staleSig),
            },
          }),
        ).rejects.toMatchObject({ code: "webauthn_replay_detected" });
      } finally {
        db.close();
      }
    });

    it("SqlLockStore + SqlIdempotencyStore + SqlSchedulerLockDriver coexist cleanly on a single shared bun:sqlite Database", async () => {
      const db = new Database(":memory:");
      let now = 1_000_000;

      try {
        // Apply all 3 SQLite DDL migrations onto the exact same Database
        db.exec(getLocksMigrationSql("sqlite"));
        db.exec(getIdempotencyMigrationSql("sqlite"));
        db.exec(getSchedulerLockMigrationSql("sqlite"));

        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name);
        expect(tables).toContain("bunest_locks");
        expect(tables).toContain("bunest_idempotency");
        expect(tables).toContain("bunest_scheduler_locks");

        const lockStore = new SqlLockStore(db, {
          dialect: "sqlite",
          now: () => now,
        });
        const idempotencyStore = new SqlIdempotencyStore(db, {
          dialect: "sqlite",
          now: () => now,
        });
        const schedulerLocks = new SqlSchedulerLockDriver(db, {
          now: () => now,
        });

        // Deliberately use the exact SAME logical key across all 3 stores to prove full table isolation!
        const sharedKey = "billing:monthly-close";

        // 1. SqlLockStore: acquire, contention, monotonic fencing tokens across release & expiry
        const lockA = await lockStore.acquire(sharedKey, "node-a", 1_000);
        expect(lockA).toEqual({ acquired: true, fencingToken: 1 });
        expect(await lockStore.acquire(sharedKey, "node-b", 1_000)).toEqual({
          acquired: false,
        });
        expect(await lockStore.release(sharedKey, "node-b")).toBe(false);
        expect(await lockStore.release(sharedKey, "node-a")).toBe(true);

        const lockB = await lockStore.acquire(sharedKey, "node-b", 1_000);
        expect(lockB).toEqual({ acquired: true, fencingToken: 2 });

        // 2. SqlIdempotencyStore: acquire, in-flight contention, complete, replay, pruneExpired
        const idemFirst = await idempotencyStore.acquire(
          sharedKey,
          "req-1",
          "fp-abc",
          2_000,
        );
        expect(idemFirst).toEqual({ state: "acquired" });

        const idemInFlight = await idempotencyStore.acquire(
          sharedKey,
          "req-2",
          "fp-abc",
          2_000,
        );
        expect(idemInFlight).toEqual({
          state: "in-flight",
          fingerprint: "fp-abc",
        });

        const storedResponse = {
          status: 201,
          headers: { "content-type": "application/json" },
          body: { invoiceId: "inv-77" },
        };
        expect(
          await idempotencyStore.complete(
            sharedKey,
            "req-1",
            storedResponse,
            5_000,
          ),
        ).toBe(true);

        const idemReplay = await idempotencyStore.acquire(
          sharedKey,
          "req-3",
          "fp-abc",
          2_000,
        );
        expect(idemReplay).toEqual({
          state: "completed",
          fingerprint: "fp-abc",
          response: storedResponse,
        });

        // 3. SqlSchedulerLockDriver: acquire, contention, renew, expiry takeover, pruneExpired
        expect(await schedulerLocks.acquire(sharedKey, 1_500, "cron-1")).toBe(
          true,
        );
        expect(await schedulerLocks.acquire(sharedKey, 1_500, "cron-2")).toBe(
          false,
        );
        expect(await schedulerLocks.renew(sharedKey, 2_500, "cron-2")).toBe(
          false,
        );
        expect(await schedulerLocks.renew(sharedKey, 2_500, "cron-1")).toBe(
          true,
        );

        // Advance time by 1_200ms: lockB (1_000ms) expired; idempotency (5_000ms) and scheduler lock (2_500ms) remain live!
        now += 1_200;

        // Reclaiming expired lockB yields fencingToken 3
        const lockC = await lockStore.acquire(sharedKey, "node-c", 5_000);
        expect(lockC).toEqual({ acquired: true, fencingToken: 3 });

        // Idempotency replay & scheduler lock are still completely unaffected
        const stillCompleted = await idempotencyStore.acquire(
          sharedKey,
          "req-4",
          "fp-abc",
          2_000,
        );
        expect(stillCompleted.state).toBe("completed");
        expect(await schedulerLocks.acquire(sharedKey, 1_000, "cron-2")).toBe(
          false,
        );

        // Advance past scheduler lock (2_500ms) and prune expired scheduler rows
        now += 2_000;
        expect(await schedulerLocks.pruneExpired()).toBe(1);
        expect(await schedulerLocks.acquire(sharedKey, 1_000, "cron-2")).toBe(
          true,
        );

        // LockStore & IdempotencyStore remain unaffected by scheduler pruneExpired()
        expect(await lockStore.acquire(sharedKey, "node-d", 1_000)).toEqual({
          acquired: false,
        });
        expect(
          (await idempotencyStore.acquire(sharedKey, "req-5", "fp-abc", 1_000))
            .state,
        ).toBe("completed");

        // Advance past idempotency TTL and pruneExpired()
        now += 3_000;
        expect(await idempotencyStore.pruneExpired()).toBe(1);
        expect(
          await idempotencyStore.acquire(sharedKey, "req-6", "fp-new", 1_000),
        ).toEqual({ state: "acquired" });
      } finally {
        db.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. OpenAPI Generics/Unions + createSchemaDto Mapped Types + @McpExpose
  // ═══════════════════════════════════════════════════════════════════════════

  describe("4. OpenAPI Generics/Unions + createSchemaDto Mapped Types + @McpExpose REST-to-MCP Bridge", () => {
    it("generates OpenAPI 3.1 oneOf, discriminator, generic wrappers, and PartialType(createSchemaDto(...)) schemas alongside runtime validation", async () => {
      @Controller("/products")
      @UsePipes(new ValidationPipe())
      class ProductsApiController {
        @Get()
        @ApiGenericResponse({
          wrapper: PaginatedCatalogDto,
          item: PublicProductDto,
          isArray: true,
          description: "Paginated public products",
        })
        listProducts() {
          return { total: 0, items: [] };
        }

        @Get("fulfillment")
        @ApiOkResponse({ type: FulfillmentUnion })
        getFulfillment() {
          return {};
        }

        @Get("fulfillment-envelope")
        @ApiOkResponse({ type: FulfillmentEnvelopeDto })
        getFulfillmentEnvelope() {
          return {};
        }

        @Post()
        createProduct(@Body() dto: CreateProductDto) {
          return {
            created: true,
            isDto: dto instanceof CreateProductDto,
            dto,
          };
        }

        @Patch(":id")
        updateProduct(
          @Param("id", ParseIntPipe) id: number,
          @Body() dto: UpdateProductDto,
        ) {
          return {
            id,
            isPartialDto: dto instanceof UpdateProductDto,
            patch: dto,
          };
        }
      }

      @Module({ controllers: [ProductsApiController] })
      class OpenApiAppModule {}

      const app = await BunestFactory.create(OpenApiAppModule, {
        logger: false,
      });
      await app.init();

      try {
        const doc = SwaggerModule.createDocument(
          app,
          new DocumentBuilder()
            .setTitle("Wishlist OpenAPI E2E")
            .setVersion("1.0.0")
            .build(),
        );
        const schemas = doc.components?.schemas ?? {};

        // 1. @ApiGenericResponse auto-registers parameterized wrapper & inner OmitType(createSchemaDto) without @ApiExtraModels
        expect(
          doc.paths["/products"]?.get?.responses["200"]?.content?.[
            "application/json"
          ]?.schema,
        ).toEqual({
          $ref: "#/components/schemas/PaginatedCatalogDtoOfPublicProductDtoArray",
        });
        expect(
          schemas.PaginatedCatalogDtoOfPublicProductDtoArray?.properties?.total,
        ).toMatchObject({ type: "number" });
        expect(
          schemas.PaginatedCatalogDtoOfPublicProductDtoArray?.properties?.items,
        ).toEqual({
          type: "array",
          items: { $ref: "#/components/schemas/PublicProductDto" },
        });
        expect(schemas.PublicProductDto?.properties?.name).toMatchObject({
          type: "string",
        });
        expect(
          schemas.PublicProductDto?.properties?.internalCost,
        ).toBeUndefined();

        // 2. UnionType emits oneOf + discriminator (honoring @ApiSchema custom name)
        expect(schemas.FulfillmentVariant).toEqual({
          description: "Product fulfillment strategy",
          oneOf: [
            { $ref: "#/components/schemas/DigitalFulfillment" },
            { $ref: "#/components/schemas/PhysicalFulfillmentDto" },
          ],
          discriminator: {
            propertyName: "kind",
            mapping: {
              digital: "#/components/schemas/DigitalFulfillment",
              physical: "#/components/schemas/PhysicalFulfillmentDto",
            },
          },
        });
        expect(
          schemas.DigitalFulfillment?.properties?.downloadUrl,
        ).toMatchObject({
          type: "string",
          format: "uri",
        });
        expect(
          schemas.PhysicalFulfillmentDto?.properties?.weightGrams,
        ).toMatchObject({
          type: "number",
        });

        // 3. GenericType wrapping a UnionType emits clean component refs
        expect(schemas.FulfillmentEnvelope?.properties?.ok).toMatchObject({
          type: "boolean",
        });
        expect(schemas.FulfillmentEnvelope?.properties?.data).toMatchObject({
          $ref: "#/components/schemas/FulfillmentVariant",
        });

        // 4. PartialType(createSchemaDto(...)) emits optional properties with no required fields
        expect(schemas.CreateProductDto?.required).toEqual(
          expect.arrayContaining(["name", "price"]),
        );
        expect(schemas.UpdateProductDto?.properties?.name).toMatchObject({
          type: "string",
        });
        expect(schemas.UpdateProductDto?.properties?.price).toMatchObject({
          type: "integer",
        });
        expect(schemas.UpdateProductDto?.required ?? []).toEqual([]);

        // 5. Runtime ValidationPipe honors PartialType(createSchemaDto(...))
        const okPatch = await app.inject({
          method: "PATCH",
          url: "/products/42",
          payload: { price: "199" },
        });
        expect(okPatch.statusCode).toBe(200);
        expect(okPatch.json()).toEqual({
          id: 42,
          isPartialDto: true,
          patch: { price: 199 },
        });

        const badPatch = await app.inject({
          method: "PATCH",
          url: "/products/42",
          payload: { name: "x" },
        });
        expect(badPatch.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("bridges a guarded + createSchemaDto-validated @Controller via @McpExpose and enforces guards & validation through McpRegistry and MCP client", async () => {
      @Injectable()
      class McpApiKeyGuard implements CanActivate {
        canActivate(context: ExecutionContext): boolean {
          const req = context.switchToHttp().getRequest<Request>();
          return req?.headers?.get("x-api-key") === "mcp-secret-token";
        }
      }

      @Injectable()
      class CatalogStore {
        private nextId = 1;
        readonly items = new Map<
          number,
          { id: number; name: string; price: number; internalCost: number }
        >();

        create(dto: CreateProductDto) {
          const item = {
            id: this.nextId++,
            name: dto.name,
            price: dto.price,
            internalCost: dto.internalCost,
          };
          this.items.set(item.id, item);
          return item;
        }

        update(id: number, patch: UpdateProductDto) {
          const existing = this.items.get(id);
          if (!existing) return null;
          if (patch.name !== undefined) existing.name = patch.name;
          if (patch.price !== undefined) existing.price = patch.price;
          if (patch.internalCost !== undefined) {
            existing.internalCost = patch.internalCost;
          }
          return existing;
        }
      }

      @Controller("/catalog-items")
      @McpExpose()
      @UseGuards(McpApiKeyGuard)
      @UsePipes(new ValidationPipe())
      class CatalogMcpController {
        constructor(private readonly store: CatalogStore) {}

        @Post()
        @McpExpose({ description: "Create a catalog product" })
        create(@Body() dto: CreateProductDto) {
          return {
            item: this.store.create(dto),
            hydratedDto: dto instanceof CreateProductDto,
          };
        }

        @Patch(":id")
        @McpExpose({ description: "Partially update a catalog product" })
        update(
          @Param("id", ParseIntPipe) id: number,
          @Body() dto: UpdateProductDto,
        ) {
          return {
            item: this.store.update(id, dto),
            hydratedPartialDto: dto instanceof UpdateProductDto,
          };
        }
      }

      @Module({
        imports: [
          McpModule.forRoot({
            name: "wishlist-e2e-mcp",
            version: "1.0.0",
          }),
        ],
        controllers: [CatalogMcpController],
        providers: [McpApiKeyGuard, CatalogStore],
      })
      class McpBridgeAppModule {}

      const app = await BunestFactory.create(McpBridgeAppModule, {
        logger: false,
      });
      await app.init();

      try {
        const registry = app.get(McpRegistry);
        const createTool = registry.tools.find(
          (t) => t.name === "catalog_mcp_create",
        );
        const updateTool = registry.tools.find(
          (t) => t.name === "catalog_mcp_update",
        );
        expect(createTool).toBeDefined();
        expect(updateTool).toBeDefined();
        expect(createTool!.options.description).toBe(
          "Create a catalog product",
        );

        // 1. Direct McpRegistry invocation: Guard blocks unauthenticated calls
        await expect(
          createTool!.handler(
            { name: "Mechanical Keyboard", price: 150 },
            makeMcpContext("catalog_mcp_create"),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        // 2. Direct McpRegistry invocation: ValidationPipe + createSchemaDto rejects invalid payload
        await expect(
          createTool!.handler(
            { name: "ab", price: 0 },
            makeMcpContext("catalog_mcp_create", {
              "x-api-key": "mcp-secret-token",
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        // 3. Direct McpRegistry invocation: Valid authenticated call coerces fields, applies defaults & hydrates DTO
        const directCreated = (await createTool!.handler(
          { name: "Mechanical Keyboard", price: "149" },
          makeMcpContext("catalog_mcp_create", {
            "x-api-key": "mcp-secret-token",
          }),
        )) as {
          item: {
            id: number;
            name: string;
            price: number;
            internalCost: number;
          };
          hydratedDto: boolean;
        };
        expect(directCreated).toEqual({
          item: {
            id: 1,
            name: "Mechanical Keyboard",
            price: 149,
            internalCost: 0,
          },
          hydratedDto: true,
        });

        // 4. Direct McpRegistry invocation on PATCH with PartialType(createSchemaDto)
        const directUpdated = (await updateTool!.handler(
          { id: "1", body: { price: "179" } },
          makeMcpContext("catalog_mcp_update", {
            "x-api-key": "mcp-secret-token",
          }),
        )) as {
          item: {
            id: number;
            name: string;
            price: number;
            internalCost: number;
          };
          hydratedPartialDto: boolean;
        };
        expect(directUpdated).toEqual({
          item: {
            id: 1,
            name: "Mechanical Keyboard",
            price: 179,
            internalCost: 0,
          },
          hydratedPartialDto: true,
        });

        // 5. Full MCP HTTP client verification (guard rejection, schema validation rejection, and success)
        const unauthClient = await connectMcpClient(app);
        const blockedCall = await unauthClient.callTool({
          name: "catalog_mcp_create",
          arguments: { name: "Mouse", price: 50 },
        });
        expect(blockedCall.isError).toBe(true);
        expect(blockedCall.content[0]?.text).toContain("Forbidden");
        await unauthClient.close();

        const authClient = await connectMcpClient(app, {
          headers: { "x-api-key": "mcp-secret-token" },
        });
        const badCall = await authClient.callTool({
          name: "catalog_mcp_create",
          arguments: { name: "no", price: -1 },
        });
        expect(badCall.isError).toBe(true);
        expect(badCall.content[0]?.text).toContain("Validation failed");

        const goodCall = await authClient.callTool({
          name: "catalog_mcp_create",
          arguments: { name: "Ergonomic Mouse", price: 89, internalCost: 25 },
        });
        expect(goodCall.isError).toBeUndefined();
        expect(JSON.parse(goodCall.content[0]!.text!)).toEqual({
          item: {
            id: 2,
            name: "Ergonomic Mouse",
            price: 89,
            internalCost: 25,
          },
          hydratedDto: true,
        });
        await authClient.close();
      } finally {
        await app.close();
      }
    });
  });
});
