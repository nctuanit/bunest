import { ClsService, Controller, Inject } from "@bunest/core";
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  type RpcContext,
} from "@bunest/microservices";
import {
  AUDIT_LOG_TOKEN,
  type InventoryReservation,
} from "./orders.types";

export interface AuditEntry {
  orderId: string;
  tenantId?: string;
  correlationId?: string;
  origin?: string;
}

@Controller()
export class InventoryRpcController {
  private seq = 1;

  constructor(
    private readonly cls: ClsService,
    @Inject(AUDIT_LOG_TOKEN) private readonly auditLog: AuditEntry[],
  ) {}

  @MessagePattern("inventory.reserve")
  reserve(
    @Payload() payload: { sku: string; quantity: number },
  ): InventoryReservation {
    return {
      reservationId: `res_${this.seq++}`,
      sku: payload.sku,
      quantity: payload.quantity,
      tenantId: this.cls.get<string>("tenantId"),
      correlationId: this.cls.get<string>("correlationId"),
    };
  }

  @EventPattern("orders.audit")
  onAudit(
    @Payload() payload: { orderId: string },
    @Ctx() ctx: RpcContext,
  ): void {
    this.auditLog.push({
      orderId: payload.orderId,
      tenantId: this.cls.get<string>("tenantId"),
      correlationId: this.cls.get<string>("correlationId"),
      origin:
        typeof ctx.metadata?.["x-origin"] === "string"
          ? ctx.metadata["x-origin"]
          : undefined,
    });
  }

  @EventPattern("orders.poison")
  onPoison(@Payload() payload: { orderId: string }): void {
    throw new Error(`Poison event for order ${payload.orderId}`);
  }
}
