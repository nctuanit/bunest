import {
  Body,
  ClsService,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
} from "@bunest/core";
import {
  InMemoryClientProxy,
  type MicroserviceDeadLetterContext,
} from "@bunest/microservices";
import { Idempotent } from "@bunest/resilience/idempotency";
import {
  AUDIT_LOG_TOKEN,
  DEAD_LETTERS_TOKEN,
  ORDERS_RPC_CLIENT,
  type CreateOrderPayload,
  type InventoryReservation,
} from "./orders.types";
import type { AuditEntry } from "./inventory.rpc-controller";
import { PaymentGatewayService } from "./payments.service";

@Controller("orders")
export class OrdersHttpController {
  public executionCount = 0;

  constructor(
    private readonly cls: ClsService,
    private readonly payments: PaymentGatewayService,
    @Inject(ORDERS_RPC_CLIENT) private readonly rpcClient: InMemoryClientProxy,
    @Inject(AUDIT_LOG_TOKEN) private readonly auditLog: AuditEntry[],
    @Inject(DEAD_LETTERS_TOKEN)
    private readonly deadLetters: MicroserviceDeadLetterContext[],
  ) {}

  @Post()
  @Idempotent({ ttl: "5m" })
  async createOrder(
    @Body() body: CreateOrderPayload,
    @Headers("x-tenant-id") tenantId = "tenant-default",
    @Headers("x-correlation-id") correlationId = "corr-default",
  ) {
    this.executionCount++;
    return this.cls.run(
      async () => {
        const reservation = await this.rpcClient.send<InventoryReservation>(
          "inventory.reserve",
          { sku: body.sku, quantity: body.quantity },
        );

        const payment = body.simulateOutage
          ? await this.payments.chargeWithBreaker(true)
          : await this.payments.chargeWithRetry(body.quantity * 1500);

        const orderId = `ord_${this.executionCount}`;
        await this.rpcClient.emit(
          "orders.audit",
          { orderId },
          { metadata: { "x-origin": "orders-http" } },
        );

        return {
          orderId,
          reservation,
          payment,
        };
      },
      { tenantId, correlationId },
    );
  }

  @Post("poison")
  async emitPoison(@Body() body: { orderId: string }) {
    await this.rpcClient.emit(
      "orders.poison",
      { orderId: body.orderId },
      { metadata: { "x-source": "dead-letter-demo" } },
    );
    return { emitted: true };
  }

  @Get("audit")
  getAuditLog() {
    return this.auditLog;
  }

  @Get("dlq")
  getDeadLetters() {
    return this.deadLetters.map((entry) => ({
      pattern: entry.pattern,
      data: entry.data,
      metadata: entry.metadata,
      errorMessage:
        entry.error instanceof Error ? entry.error.message : String(entry.error),
      transport: entry.transport,
    }));
  }
}
