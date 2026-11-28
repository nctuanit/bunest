import { Controller } from "@bunest/core";
import {
  Ctx,
  GrpcContext,
  GrpcException,
  GrpcMethod,
  GrpcStatus,
  GrpcStreamMethod,
  Payload,
} from "@bunest/microservices";
import type { FindManyRequest, Hero, HeroById } from "./hero.interface";

@Controller()
export class HeroGrpcController {
  private readonly items: Hero[] = [
    { id: 1, name: "John", power: 80 },
    { id: 2, name: "Doe", power: 95 },
    { id: 3, name: "Valkyrie", power: 120 },
  ];

  @GrpcMethod("HeroService", "FindOne")
  findOne(@Payload() data: HeroById, @Ctx() ctx: GrpcContext): Hero {
    const requestId = ctx.getMetadata().get("x-request-id") ?? "none";
    ctx.setResponseMetadata("x-handled-by", "hero-grpc-node");
    ctx.setResponseMetadata("x-echo-request-id", requestId);

    const hero = this.items.find((item) => item.id === data.id);
    if (!hero) {
      throw new GrpcException(
        GrpcStatus.NOT_FOUND,
        `Hero #${data.id} not found`,
      );
    }
    return hero;
  }

  @GrpcStreamMethod("HeroService", "FindMany")
  async *findMany(@Payload() data: FindManyRequest): AsyncGenerator<Hero> {
    const minPower = data?.minPower ?? 0;
    for (const hero of this.items) {
      if (hero.power >= minPower) {
        yield hero;
      }
    }
  }
}
