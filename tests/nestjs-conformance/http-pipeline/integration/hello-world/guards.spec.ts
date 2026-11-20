import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  UnauthorizedException,
  type CanActivate,
} from "../../../../../packages/common/src";
import {
  APP_GUARD,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers";

@Injectable()
class HelloService {
  greeting(): string {
    return "Hello world!";
  }
}

@Controller("hello")
class HelloController {
  constructor(private readonly helloService: HelloService) {}

  @Get()
  @Header("Authorization", "Bearer")
  greeting(): string {
    return this.helloService.greeting();
  }
}

@Module({
  controllers: [HelloController],
  providers: [HelloService],
})
class AppModule {}

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    const x = true;
    if (x) {
      throw new UnauthorizedException();
    }
    return false;
  }
}

function createTestModule(guard: CanActivate) {
  return Test.createTestingModule({
    imports: [AppModule],
    providers: [
      {
        provide: APP_GUARD,
        useValue: guard,
      },
    ],
  }).compile();
}

describeConformance(
  "Guards",
  {
    upstreamPath: "integration/hello-world/e2e/guards.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("should prevent access (unauthorized)", async () => {
      const moduleRef = await createTestModule(new AuthGuard());
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      await request(app)
        .get("/hello")
        .expect(401)
        .expect(({ body }) => {
          expect(body.message).toBe("Unauthorized");
          expect(body.statusCode).toBe(401);
        });
    });

    it("should allow access when guard returns true", async () => {
      const allowGuard: CanActivate = { canActivate: () => true };
      const moduleRef = await createTestModule(allowGuard);
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      await request(app).get("/hello").expect(200).expect("Hello world!");
    });
  },
);
