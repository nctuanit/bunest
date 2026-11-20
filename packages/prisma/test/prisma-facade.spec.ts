import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UseFilters,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  DEFAULT_PRISMA_CONNECTION,
  InjectPrisma,
  InjectPrismaService,
  PRISMA_CLIENT,
  PrismaClientExceptionFilter,
  PrismaModule,
  PrismaService,
  PrismaServiceBase,
  getPrismaOptionsToken,
  getPrismaServiceToken,
  getPrismaToken,
  isPrismaClientKnownRequestError,
  mapPrismaErrorToHttp,
  type PrismaClientLike,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
} from "../src";

class FakePrismaClient implements PrismaClientLike<FakePrismaClient> {
  public connected = 0;
  public disconnected = 0;
  public items: string[] = [];

  async $connect(): Promise<void> {
    this.connected++;
  }

  async $disconnect(): Promise<void> {
    this.disconnected++;
  }

  async $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T> {
    const snapshot = [...this.items];
    try {
      return await fn(this);
    } catch (err) {
      this.items = snapshot;
      throw err;
    }
  }
}

function makePrismaError(code: string, message: string) {
  return Object.assign(new Error(message), {
    code,
    clientVersion: "6.0.0",
  });
}

describe("@bunest/prisma drop-in facade (PrismaModule, PrismaService & PrismaClientExceptionFilter)", () => {
  it("exports all tokens, helpers, PrismaService, and PrismaClientExceptionFilter", () => {
    expect(DEFAULT_PRISMA_CONNECTION).toBe("default");
    expect(PRISMA_CLIENT).toBe(getPrismaToken("default"));
    expect(getPrismaServiceToken()).toBe("bunest:prisma:service:default");
    expect(getPrismaOptionsToken()).toBe("bunest:prisma:options:default");
    expect(PrismaService).toBe(PrismaServiceBase);
    expect(PrismaModule).toBeDefined();
    expect(PrismaClientExceptionFilter).toBeDefined();
    expect(typeof InjectPrisma).toBe("function");
    expect(typeof InjectPrismaService).toBe("function");
    expect(typeof mapPrismaErrorToHttp).toBe("function");

    expect(isPrismaClientKnownRequestError(makePrismaError("P2002", "Unique failed"))).toBe(
      true,
    );
    expect(isPrismaClientKnownRequestError(new Error("plain"))).toBe(false);
    expect(mapPrismaErrorToHttp(makePrismaError("P2002", "dup"))?.getStatus()).toBe(409);
  });

  it("wires PrismaModule.forRoot(), PrismaModule.forRootAsync(), @Inject(PRISMA_CLIENT), @InjectPrisma(), and PrismaService", async () => {
    const client = new FakePrismaClient();

    @Injectable()
    class UsersRepo {
      constructor(
        @Inject(PRISMA_CLIENT) public readonly byConst: FakePrismaClient,
        @InjectPrisma() public readonly byDecorator: FakePrismaClient,
        public readonly prismaService: PrismaService<FakePrismaClient>,
        @InjectPrismaService() public readonly byServiceDecorator: PrismaService<FakePrismaClient>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [PrismaModule.forRoot({ client })],
      providers: [UsersRepo],
    }).compile();

    await mod.init();
    try {
      const repo = mod.get(UsersRepo);
      expect(repo.byConst).toBe(client);
      expect(repo.byDecorator).toBe(client);
      expect(repo.prismaService).toBe(repo.byServiceDecorator);
      expect(client.connected).toBe(1);

      await repo.prismaService.transaction(async (tx) => {
        tx.items.push("user-1");
        expect(repo.prismaService.isInTransaction()).toBe(true);
      });
      expect(client.items).toEqual(["user-1"]);
    } finally {
      await mod.close();
    }
    expect(client.disconnected).toBe(1);

    // forRootAsync with useClass
    const asyncClient = new FakePrismaClient();

    @Injectable()
    class PrismaCfgFactory implements PrismaOptionsFactory<FakePrismaClient> {
      createPrismaOptions(): PrismaModuleOptions<FakePrismaClient> {
        return { client: asyncClient };
      }
    }

    const asyncMod = await Test.createTestingModule({
      imports: [PrismaModule.forRootAsync({ useClass: PrismaCfgFactory })],
    }).compile();

    await asyncMod.init();
    try {
      expect(asyncClient.connected).toBe(1);
      expect(asyncMod.get(PRISMA_CLIENT)).toBe(asyncClient);
      expect(asyncMod.get(PrismaService)).toBeInstanceOf(PrismaService);
    } finally {
      await asyncMod.close();
    }
    expect(asyncClient.disconnected).toBe(1);
  });

  it("maps Prisma error codes to HTTP responses in PrismaClientExceptionFilter (default + custom mapping)", async () => {
    @Controller("/items")
    @UseFilters(PrismaClientExceptionFilter)
    class ItemsController {
      @Get("conflict")
      conflict(): never {
        throw makePrismaError("P2002", "Unique constraint failed on email");
      }

      @Get("not-found")
      notFound(): never {
        throw makePrismaError("P2025", "Record to update not found");
      }

      @Get("bad-request")
      badRequest(): never {
        throw makePrismaError("P2003", "Foreign key constraint failed");
      }

      @Get("unavailable")
      unavailable(): never {
        throw makePrismaError("P2024", "Timed out fetching connection from pool");
      }

      @Get("http-passthrough")
      httpPassthrough(): never {
        throw new NotFoundException("Normal HTTP 404");
      }

      @Get("custom-map")
      @UseFilters(
        new PrismaClientExceptionFilter({
          P2002: {
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            errorMessage: "Duplicate entry rejected",
          },
          P2099: HttpStatus.GONE,
        }),
      )
      customMap(): never {
        throw makePrismaError("P2002", "Raw Prisma\nmultiline message");
      }

      @Get("custom-numeric")
      @UseFilters(new PrismaClientExceptionFilter({ P2099: HttpStatus.GONE }))
      customNumeric(): never {
        throw makePrismaError("P2099", "Resource\npermanently removed");
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [ItemsController],
    }).compile();

    const client = mod.createTestClient();
    try {
      const rConflict = await client.get("/items/conflict");
      expect(rConflict.status).toBe(409);

      const rNotFound = await client.get("/items/not-found");
      expect(rNotFound.status).toBe(404);

      const rBadReq = await client.get("/items/bad-request");
      expect(rBadReq.status).toBe(400);

      const rUnavail = await client.get("/items/unavailable");
      expect(rUnavail.status).toBe(503);

      const rHttp = await client.get("/items/http-passthrough");
      expect(rHttp.status).toBe(404);
      expect((await rHttp.json<{ message: string }>()).message).toBe(
        "Normal HTTP 404",
      );

      const rCustom = await client.get("/items/custom-map");
      expect(rCustom.status).toBe(422);
      expect((await rCustom.json<{ message: string }>()).message).toBe(
        "Duplicate entry rejected",
      );

      const rNum = await client.get("/items/custom-numeric");
      expect(rNum.status).toBe(410);
      expect((await rNum.json<{ message: string }>()).message).toBe(
        "Resource permanently removed",
      );
    } finally {
      await mod.close();
    }
  });
});
