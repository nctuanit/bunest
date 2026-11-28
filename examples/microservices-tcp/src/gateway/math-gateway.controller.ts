import { BadRequestException, Body, Controller, Inject, Post } from "@bunest/core";
import { RpcException, type ClientProxy } from "@bunest/microservices";
import { MATH_SERVICE } from "../math/math.constants";

@Controller("math")
export class MathGatewayController {
  constructor(@Inject(MATH_SERVICE) private readonly client: ClientProxy) {}

  @Post("sum")
  async sum(@Body() body: { numbers: number[] }) {
    try {
      const result = await this.client.send<number>(
        { cmd: "sum" },
        body?.numbers ?? [],
      );
      return { operation: "sum", result };
    } catch (err) {
      if (err instanceof RpcException) {
        const raw = err.getError();
        throw new BadRequestException(
          typeof raw === "string" ? raw : (raw as Record<string, unknown>),
        );
      }
      throw err;
    }
  }

  @Post("multiply")
  async multiply(@Body() body: { numbers: number[] }) {
    try {
      const result = await this.client.send<number>(
        { cmd: "multiply" },
        body?.numbers ?? [],
      );
      return { operation: "multiply", result };
    } catch (err) {
      if (err instanceof RpcException) {
        const raw = err.getError();
        throw new BadRequestException(
          typeof raw === "string" ? raw : (raw as Record<string, unknown>),
        );
      }
      throw err;
    }
  }

  @Post("notify")
  async notify(@Body() body: { operation: string; values: number[] }) {
    await this.client.emit("math.computed", body);
    return { emitted: true };
  }
}
