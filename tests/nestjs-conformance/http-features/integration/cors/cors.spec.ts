import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type CorsOptions,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

@Controller()
class AppController {
  @Get()
  getGlobals() {
    return "";
  }
}

@Module({
  controllers: [AppController],
})
class AppModule {}

describeConformance(
  "CORS E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/cors/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts NestJS static & dynamic CORS E2E tests (enableCors & application options) to BunHttpAdapter native Fetch-spec CORS evaluation.",
  },
  () => {
    const configs: CorsOptions[] = [
      {
        origin: "example.com",
        methods: "GET",
        credentials: true,
        exposedHeaders: ["foo", "bar"],
        allowedHeaders: ["baz", "woo"],
        maxAge: 123,
      },
      {
        origin: "sample.com",
        methods: "GET",
        credentials: true,
        exposedHeaders: ["zoo", "bar"],
        allowedHeaders: ["baz", "foo"],
        maxAge: 321,
      },
    ];

    describe("Dynamic origin callback config", () => {
      describe("enableCors", () => {
        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          app = moduleRef.createNestApplication({ logger: false });

          let requestId = 0;
          app.enableCors({
            origin: async () => {
              const idx = requestId++;
              return idx === 0 ? "example.com" : "sample.com";
            },
            methods: "GET",
            credentials: true,
            exposedHeaders: ["foo", "bar"],
            allowedHeaders: ["baz", "foo"],
            maxAge: 321,
          });

          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        itAdapted(
          ["ADR-001", "ADR-008"],
          "should add cors headers based on the first dynamic origin decision",
          async () => {
            await request(app)
              .get("/")
              .set("Origin", "example.com")
              .expect("access-control-allow-origin", "example.com")
              .expect("vary", /Origin/)
              .expect("access-control-allow-credentials", "true")
              .expect("access-control-expose-headers", "foo,bar");
          },
          "Bunest CorsOptions.origin async callback",
        );

        itAdapted(
          ["ADR-001", "ADR-008"],
          "should add cors preflight headers based on the second dynamic origin decision",
          async () => {
            await request(app)
              .options("/")
              .set("Origin", "sample.com")
              .set("Access-Control-Request-Method", "GET")
              .expect(204)
              .expect("access-control-allow-origin", "sample.com")
              .expect("vary", /Origin/)
              .expect("access-control-allow-credentials", "true")
              .expect("access-control-allow-methods", "GET")
              .expect("access-control-allow-headers", "baz,foo")
              .expect("access-control-max-age", "321")
              .expect("content-length", "0");
          },
          "Fetch-spec preflight requires Origin + Access-Control-Request-Method",
        );
      });

      describe("CorsOptionsDelegate callback parity (enableCors(fn) / { cors: fn })", () => {
        it("should support NestJS CorsOptionsDelegate callback in enableCors()", async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          const app = moduleRef.createNestApplication({ logger: false });
          let requestId = 0;
          const configDelegation = (
            _req: unknown,
            cb: (err: Error | null, options: CorsOptions) => void,
          ) => {
            const config = configs[requestId]!;
            requestId++;
            cb(null, config);
          };
          app.enableCors(configDelegation as unknown as CorsOptions);
          await app.init();

          try {
            await request(app)
              .get("/")
              .expect("access-control-allow-origin", "example.com")
              .expect("vary", "Origin")
              .expect("access-control-allow-credentials", "true")
              .expect("access-control-expose-headers", "foo,bar");

            await request(app)
              .options("/")
              .set("Origin", "sample.com")
              .set("Access-Control-Request-Method", "GET")
              .expect("access-control-allow-origin", "sample.com")
              .expect("access-control-allow-methods", "GET")
              .expect("access-control-allow-headers", "baz,foo")
              .expect("access-control-max-age", "321");
          } finally {
            await app.close();
          }
        });

        it("should support NestJS CorsOptionsDelegate callback in Application Options", async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          let requestId = 0;
          const configDelegation = (
            _req: unknown,
            cb: (err: Error | null, options: CorsOptions) => void,
          ) => {
            const config = configs[requestId]!;
            requestId++;
            cb(null, config);
          };
          const app = moduleRef.createNestApplication({
            logger: false,
            cors: configDelegation as unknown as CorsOptions,
          });
          await app.init();

          try {
            await request(app)
              .get("/")
              .expect("access-control-allow-origin", "example.com")
              .expect("vary", "Origin")
              .expect("access-control-allow-credentials", "true")
              .expect("access-control-expose-headers", "foo,bar");
          } finally {
            await app.close();
          }
        });
      });
    });

    describe("Static config", () => {
      describe("enableCors", () => {
        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          app = moduleRef.createNestApplication({ logger: false });
          app.enableCors(configs[0]);
          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        it("CORS headers", async () => {
          const res = await request(app)
            .get("/")
            .expect("access-control-allow-origin", "example.com")
            .expect("vary", "Origin")
            .expect("access-control-allow-credentials", "true")
            .expect("access-control-expose-headers", "foo,bar");
          expect(res.text).toBe("");
        });
      });

      describe("Application Options", () => {
        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
          }).compile();
          app = moduleRef.createNestApplication({
            logger: false,
            cors: configs[0],
          });
          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        it("CORS headers", async () => {
          const res = await request(app)
            .get("/")
            .expect("access-control-allow-origin", "example.com")
            .expect("vary", "Origin")
            .expect("access-control-allow-credentials", "true")
            .expect("access-control-expose-headers", "foo,bar");
          expect(res.text).toBe("");
        });
      });
    });
  },
);
