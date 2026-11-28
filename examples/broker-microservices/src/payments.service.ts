import { Injectable } from "@bunest/core";
import { CircuitBreaker, Fallback, Retry } from "@bunest/resilience";
import type { PaymentReceipt } from "./orders.types";

@Injectable()
export class PaymentGatewayService {
  private transientRemaining = 1;
  public chargeAttempts = 0;

  reset(transientFailures = 1): void {
    this.transientRemaining = transientFailures;
    this.chargeAttempts = 0;
  }

  @Retry({
    attempts: 3,
    backoff: { delay: 5, factor: 1, jitter: "none" },
  })
  async chargeWithRetry(amountCents: number): Promise<PaymentReceipt> {
    this.chargeAttempts++;
    if (this.transientRemaining > 0) {
      this.transientRemaining--;
      throw new Error(`Transient PSP timeout on attempt ${this.chargeAttempts}`);
    }
    return {
      chargeId: `chg_${amountCents}_${this.chargeAttempts}`,
      status: "charged",
      attempts: this.chargeAttempts,
    };
  }

  @Fallback("deferPayment")
  @CircuitBreaker({
    name: "psp-breaker",
    minimumCalls: 2,
    failureRateThreshold: 50,
    openDuration: "5s",
  })
  async chargeWithBreaker(shouldFail: boolean): Promise<PaymentReceipt> {
    if (shouldFail) {
      throw new Error("Upstream PSP unavailable");
    }
    return {
      chargeId: "chg_live",
      status: "charged",
      attempts: 1,
    };
  }

  deferPayment(): PaymentReceipt {
    return {
      chargeId: "chg_deferred_queue",
      status: "deferred",
      attempts: 0,
    };
  }
}
