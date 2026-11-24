import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  Controller,
  Get,
  Header,
  HostParam,
  Injectable,
  Module,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

function createStringStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

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
  streamGreeting(): ReadableStream<Uint8Array> {
    return createStringStream(this.helloService.greeting());
  }
}

@Module({
  controllers: [HelloController],
  providers: [HelloService],
})
class HelloModule {}

@Injectable()
class HostService {
  greeting(): string {
    return "Host Greeting!";
  }
}

@Controller({
  path: "host",
  host: ":tenant.example.com",
})
class HostController {
  constructor(private readonly hostService: HostService) {}

  @Get()
  @Header("Authorization", "Bearer")
  greeting(@HostParam("tenant") tenant: string): string {
    return `${this.hostService.greeting()} tenant=${tenant}`;
  }

  @Get("async")
  async asyncGreeting(@HostParam("tenant") tenant: string): Promise<string> {
    return `${this.hostService.greeting()} tenant=${tenant}`;
  }

  @Get("stream")
  streamGreeting(
    @HostParam("tenant") tenant: string,
  ): ReadableStream<Uint8Array> {
    return createStringStream(
      `${this.hostService.greeting()} tenant=${tenant}`,
    );
  }
}

@Module({
  controllers: [HostController],
  providers: [HostService],
})
class HostModule {}

@Injectable()
class HostArrayService {
  greeting(): string {
    return "Host Greeting!";
  }
}

@Controller({
  path: "host-array",
  host: [":tenant.example1.com", ":tenant.example2.com"],
})
class HostArrayController {
  constructor(private readonly hostService: HostArrayService) {}

  @Get()
  @Header("Authorization", "Bearer")
  greeting(@HostParam("tenant") tenant: string): string {
    return `${this.hostService.greeting()} tenant=${tenant}`;
  }

  @Get("async")
  async asyncGreeting(@HostParam("tenant") tenant: string): Promise<string> {
    return `${this.hostService.greeting()} tenant=${tenant}`;
  }

  @Get("stream")
  streamGreeting(
    @HostParam("tenant") tenant: string,
  ): ReadableStream<Uint8Array> {
    return createStringStream(
      `${this.hostService.greeting()} tenant=${tenant}`,
    );
  }
}

@Module({
  controllers: [HostArrayController],
  providers: [HostArrayService],
})
class HostArrayModule {}

@Module({
  imports: [HelloModule, HostModule, HostArrayModule],
})
class AppModule {}

describeConformance(
  "Hello world (default adapter)",
  {
    upstreamPath: "integration/hello-world/e2e/hello-world.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts Observable stream endpoint to native Web ReadableStream on BunHttpAdapter (zero RxJS).",
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

    for (const { host, path, greeting } of [
      {
        host: "example.com",
        path: "/hello",
        greeting: "Hello world!",
      },
      {
        host: "acme.example.com",
        path: "/host",
        greeting: "Host Greeting! tenant=acme",
      },
      {
        host: "acme.example1.com",
        path: "/host-array",
        greeting: "Host Greeting! tenant=acme",
      },
      {
        host: "acme.example2.com",
        path: "/host-array",
        greeting: "Host Greeting! tenant=acme",
      },
    ]) {
      describe(`host=${host}`, () => {
        describe("/GET", () => {
          it(`should return "${greeting}"`, async () => {
            await request(app)
              .get(path)
              .set("Host", host)
              .expect(200)
              .expect(greeting);
          });

          it("should attach response header", async () => {
            await request(app)
              .get(path)
              .set("Host", host)
              .expect(200)
              .expect("Authorization", "Bearer");
          });
        });

        it(`/GET (Promise/async) returns "${greeting}"`, async () => {
          await request(app)
            .get(`${path}/async`)
            .set("Host", host)
            .expect(200)
            .expect(greeting);
        });

        itAdapted(
          ["ADR-008", "ADR-010"],
          `/GET (ReadableStream) "${greeting}"`,
          async () => {
            await request(app)
              .get(`${path}/stream`)
              .set("Host", host)
              .expect(200)
              .expect(greeting);
          },
          "Web ReadableStream replaces RxJS Observable",
        );
      });
    }
  },
);
