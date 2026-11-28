import { Controller } from "@bunest/core";
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
  type RpcContext,
} from "@bunest/microservices";

export interface MathAuditEvent {
  readonly operation: string;
  readonly values: number[];
  readonly transport: string;
}

@Controller()
export class MathRpcController {
  public readonly auditLog: MathAuditEvent[] = [];

  @MessagePattern({ cmd: "sum" })
  accumulate(@Payload() data: number[]): number {
    if (!Array.isArray(data) || data.length === 0) {
      throw new RpcException({
        code: "EMPTY_INPUT",
        message: "Provide at least one number to sum",
      });
    }
    return data.reduce((acc, n) => acc + n, 0);
  }

  @MessagePattern({ cmd: "multiply" })
  multiply(@Payload() data: number[]): number {
    if (!Array.isArray(data) || data.length === 0) {
      throw new RpcException({
        code: "EMPTY_INPUT",
        message: "Provide at least one number to multiply",
      });
    }
    return data.reduce((acc, n) => acc * n, 1);
  }

  @EventPattern("math.computed")
  handleComputed(
    @Payload() data: { operation: string; values: number[] },
    @Ctx() ctx: RpcContext,
  ): void {
    this.auditLog.push({
      operation: data.operation,
      values: data.values,
      transport: String(ctx.transport),
    });
  }
}
