export interface CreateOrderPayload {
  sku: string;
  quantity: number;
  simulateOutage?: boolean;
}

export interface InventoryReservation {
  reservationId: string;
  sku: string;
  quantity: number;
  tenantId?: string;
  correlationId?: string;
}

export interface PaymentReceipt {
  chargeId: string;
  status: "charged" | "deferred";
  attempts: number;
}

export const ORDERS_RPC_CLIENT = Symbol("ORDERS_RPC_CLIENT");
export const AUDIT_LOG_TOKEN = Symbol("AUDIT_LOG_TOKEN");
export const DEAD_LETTERS_TOKEN = Symbol("DEAD_LETTERS_TOKEN");
