import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  HostParam,
  Injectable,
  Module,
  Param,
  type ArgumentMetadata,
  type PipeTransform,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Injectable()
class HelloUsersService {
  findById(id: string) {
    return { id };
  }
}

@Injectable()
class HelloUserByIdPipe implements PipeTransform<string> {
  constructor(private readonly usersService: HelloUsersService) {}

  transform(value: string, _metadata: ArgumentMetadata) {
    return this.usersService.findById(value);
  }
}

@Controller("hello")
class HelloController {
  @Get("local-pipe/:id")
  localPipe(@Param("id", HelloUserByIdPipe) user: unknown): unknown {
    return user;
  }
}

@Module({
  controllers: [HelloController],
  providers: [HelloUsersService],
})
class HelloModule {}

@Injectable()
class HostUsersService {
  findById(id: string) {
    return { id, host: true };
  }
}

@Injectable()
class HostUserByIdPipe implements PipeTransform<string> {
  constructor(private readonly usersService: HostUsersService) {}

  transform(value: string, _metadata: ArgumentMetadata) {
    return this.usersService.findById(value);
  }
}

@Controller({
  path: "host",
  host: ":tenant.example.com",
})
class HostController {
  @Get("local-pipe/:id")
  localPipe(
    @Param("id", HostUserByIdPipe) user: Record<string, unknown>,
    @HostParam("tenant") tenant: string,
  ): Record<string, unknown> {
    return { ...user, tenant };
  }
}

@Module({
  controllers: [HostController],
  providers: [HostUsersService],
})
class HostModule {}

@Module({
  imports: [HelloModule, HostModule],
})
class AppModule {}

describeConformance(
  "Local pipes (default adapter)",
  {
    upstreamPath: "integration/hello-world/e2e/local-pipes.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("host=example.com should execute locally injected pipe by HelloController", async () => {
      await request(app).get("/hello/local-pipe/1").expect(200).expect({
        id: "1",
      });
    });

    it("host=host.example.com should execute locally injected pipe by HostController", async () => {
      await request(app)
        .get("/host/local-pipe/1")
        .set("Host", "acme.example.com")
        .expect(200)
        .expect({
          id: "1",
          host: true,
          tenant: "acme",
        });
    });

    it("should return 404 for mismatched host", async () => {
      const res = await request(app).get("/host/local-pipe/1").expect(404);
      expect(res.body).toMatchObject({
        error: "Not Found",
        message: "Cannot GET /host/local-pipe/1",
        statusCode: 404,
      });
    });
  },
);
