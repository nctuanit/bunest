import "reflect-metadata";
import { afterEach } from "bun:test";
import {
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "../../../../../packages/common/src";
import {
  APP_INTERCEPTOR,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

const RETURN_VALUE = "test";

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

  @Get("async")
  async asyncGreeting(): Promise<string> {
    return this.helloService.greeting();
  }

  @Get("stream")
  streamGreeting(): Promise<string> {
    return Promise.resolve(this.helloService.greeting());
  }
}

@Module({
  controllers: [HelloController],
  providers: [HelloService],
})
class AppModule {}

@Injectable()
export class OverrideInterceptor implements BunestInterceptor {
  intercept(_context: ExecutionContext, _next: CallHandler) {
    return RETURN_VALUE;
  }
}

@Injectable()
export class TransformInterceptor implements BunestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const data = await next.handle();
    return { data };
  }
}

@Injectable()
export class StatusInterceptor implements BunestInterceptor {
  constructor(private readonly statusCode: number) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const ctx = context.switchToHttp();
    const res = ctx.getResponse();
    res.status(this.statusCode);
    const data = await next.handle();
    return { data };
  }
}

@Injectable()
export class HeaderInterceptor implements BunestInterceptor {
  constructor(private readonly headers: Record<string, string>) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const ctx = context.switchToHttp();
    const res = ctx.getResponse();
    for (const key in this.headers) {
      if (Object.hasOwn(this.headers, key)) {
        res.header(key, this.headers[key]!);
      }
    }
    const data = await next.handle();
    return { data };
  }
}

function createTestModule(interceptor: BunestInterceptor) {
  return Test.createTestingModule({
    imports: [AppModule],
    providers: [
      {
        provide: APP_INTERCEPTOR,
        useValue: interceptor,
      },
    ],
  }).compile();
}

describeConformance(
  "Interceptors",
  {
    upstreamPath: "integration/hello-world/e2e/interceptors.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008", "ADR-010"],
    notes:
      "Adapts RxJS Observable interceptors (of/pipe/map) to Bunest Promise onion interceptors (async/await next.handle()).",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    itAdapted("ADR-008", "should transform response (sync)", async () => {
      app = (
        await createTestModule(new OverrideInterceptor())
      ).createNestApplication({ logger: false });
      await app.init();

      await request(app).get("/hello").expect(200, RETURN_VALUE);
    });

    itAdapted("ADR-008", "should map response", async () => {
      app = (
        await createTestModule(new TransformInterceptor())
      ).createNestApplication({ logger: false });
      await app.init();

      await request(app).get("/hello").expect(200, { data: "Hello world!" });
    });

    itAdapted("ADR-008", "should map response (async)", async () => {
      app = (
        await createTestModule(new TransformInterceptor())
      ).createNestApplication({ logger: false });
      await app.init();

      await request(app)
        .get("/hello/stream")
        .expect(200, { data: "Hello world!" });
    });

    itAdapted("ADR-008", "should map response (stream)", async () => {
      app = (
        await createTestModule(new TransformInterceptor())
      ).createNestApplication({ logger: false });
      await app.init();

      await request(app)
        .get("/hello/async")
        .expect(200, { data: "Hello world!" });
    });

    itAdapted(
      ["ADR-008", "ADR-010"],
      "should modify response status",
      async () => {
        app = (
          await createTestModule(new StatusInterceptor(400))
        ).createNestApplication({ logger: false });
        await app.init();

        await request(app).get("/hello").expect(400, { data: "Hello world!" });
      },
    );

    itAdapted(
      ["ADR-008", "ADR-010"],
      "should modify Authorization header",
      async () => {
        const customHeaders = {
          Authorization: "jwt",
        };

        app = (
          await createTestModule(new HeaderInterceptor(customHeaders))
        ).createNestApplication({ logger: false });
        await app.init();

        await request(app)
          .get("/hello")
          .expect(200)
          .expect("Authorization", "jwt");
      },
    );
  },
);
