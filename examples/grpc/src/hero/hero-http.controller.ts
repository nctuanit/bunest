import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from "@bunest/core";
import {
  GrpcClientProxy,
  GrpcException,
  GrpcMetadata,
  GrpcStatus,
} from "@bunest/microservices";
import { HERO_GRPC_CLIENT, type Hero, type HeroById } from "./hero.interface";

@Controller("hero")
export class HeroHttpController {
  constructor(
    @Inject(HERO_GRPC_CLIENT)
    private readonly grpcClient: GrpcClientProxy,
  ) {}

  @Get(":id")
  async getHero(
    @Param("id", ParseIntPipe) id: number,
    @Headers("x-request-id") requestId?: string,
  ) {
    const metadata = new GrpcMetadata(
      requestId ? { "x-request-id": requestId } : undefined,
    );
    try {
      const res = await this.grpcClient.callWithMetadata<Hero, HeroById>(
        "HeroService",
        "FindOne",
        { id },
        { metadata },
      );
      return {
        hero: res.data,
        handledBy: res.metadata.get("x-handled-by"),
        echoRequestId: res.metadata.get("x-echo-request-id"),
      };
    } catch (err) {
      if (err instanceof GrpcException && err.code === GrpcStatus.NOT_FOUND) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Get()
  async listHeroes(@Query("minPower") minPowerParam?: string) {
    const minPower = minPowerParam ? Number(minPowerParam) : 0;
    const heroes: Hero[] = [];
    for await (const hero of this.grpcClient.stream<Hero>(
      "HeroService",
      "FindMany",
      { minPower },
    )) {
      heroes.push(hero);
    }
    return { heroes };
  }
}
