import { Injectable, Module } from "@bunest/core";
import {
  WorkerHandler,
  bootstrapWorkerApplication,
  defineWorkerContract,
  type WorkerTaskContext,
} from "../../../src/workers";

export const DiMultiplyContract = defineWorkerContract<
  { readonly x: number; readonly y: number },
  { readonly product: number; readonly workerId: string }
>("di-multiply");

@Injectable()
class MultiplierService {
  multiply(x: number, y: number): number {
    return x * y;
  }
}

@Injectable()
class MathWorkerHandlers {
  constructor(private readonly multiplier: MultiplierService) {}

  @WorkerHandler(DiMultiplyContract)
  compute(
    input: { readonly x: number; readonly y: number },
    ctx: WorkerTaskContext,
  ) {
    return {
      product: this.multiplier.multiply(input.x, input.y),
      workerId: ctx.workerId,
    };
  }

  @WorkerHandler("ping-di")
  ping(msg: string): string {
    return `di:${msg}`;
  }
}

@Module({
  providers: [MultiplierService, MathWorkerHandlers],
})
class DiWorkerModule {}

export default bootstrapWorkerApplication(DiWorkerModule);
