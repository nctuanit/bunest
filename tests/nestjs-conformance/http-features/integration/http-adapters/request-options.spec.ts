import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Ip,
  Module,
  Query,
  Req,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

@Controller()
class RequestOptionsController {
  @Get("client")
  client(@Ip() ip: string, @Req() req: Request) {
    const url = new URL(req.url);
    return {
      ip,
      protocol: url.protocol.replace(/:$/, ""),
      hostname: url.hostname,
    };
  }

  @Get("search")
  search(@Query() query: unknown) {
    return query;
  }
}

@Module({ controllers: [RequestOptionsController] })
class RequestOptionsModule {}

const FORWARDED = {
  "X-Forwarded-For": "203.0.113.7",
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": "example.com",
};

const QUERY = "filter[where][name]=John&item[]=1&item[]=2";

describeConformance(
  "Adapter options for requests (BunHttpAdapter trustProxy & query parsing)",
  {
    upstreamPath: "integration/http-adapters/e2e/request-options.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Adapts NestJS trustProxy & query parser options E2E tests to BunHttpAdapter native trustProxy and URLSearchParams flat query parsing.",
  },
  () => {
    let app: BunestApplication;

    afterEach(async () => {
      await app?.close();
    });

    itAdapted(
      "ADR-001",
      "should read the client IP forwarded by a trusted loopback proxy via @Ip()",
      async () => {
        const modRef = await Test.createTestingModule({
          imports: [RequestOptionsModule],
        }).compile();
        app = modRef.createNestApplication({
          logger: false,
          trustProxy: ["loopback"],
        });
        await app.listen(0, "127.0.0.1");

        const res = await fetch(`${app.getUrl()}client`, {
          headers: FORWARDED,
        });
        const body = (await res.json()) as {
          ip: string;
          protocol: string;
          hostname: string;
        };
        expect(body.ip).toBe("203.0.113.7");
      },
      "Bunest @Ip() reads X-Forwarded-For when trustProxy includes 'loopback'",
    );

    itAdapted(
      "ADR-001",
      "should ignore the X-Forwarded-* headers by default",
      async () => {
        const modRef = await Test.createTestingModule({
          imports: [RequestOptionsModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.listen(0, "127.0.0.1");

        const res = await fetch(`${app.getUrl()}client`, {
          headers: FORWARDED,
        });
        const body = (await res.json()) as {
          ip: string;
          protocol: string;
          hostname: string;
        };
        expect(body.ip).toBe("127.0.0.1");
        expect(body.protocol).toBe("http");
        expect(body.hostname).toBe("127.0.0.1");
      },
      "Default trustProxy is disabled so server.requestIP(req) returns loopback IP",
    );

    it("should leave the query string flat by default", async () => {
      const modRef = await Test.createTestingModule({
        imports: [RequestOptionsModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      await app.init();

      const res = await request(app).get(`/search?${QUERY}`).expect(200);
      expect(res.body).toEqual({
        "filter[where][name]": "John",
        "item[]": ["1", "2"],
      });
    });

    itAdapted(
      "ADR-001",
      "should support numeric hop-count trustProxy for multi-proxy X-Forwarded-For chains",
      async () => {
        const modRef = await Test.createTestingModule({
          imports: [RequestOptionsModule],
        }).compile();
        app = modRef.createNestApplication({
          logger: false,
          trustProxy: 2,
        });
        await app.init();

        const res = await request(app)
          .get("/client")
          .set("X-Forwarded-For", "198.51.100.1, 203.0.113.7, 10.0.0.1")
          .expect(200);
        expect(res.body.ip).toBe("203.0.113.7");
      },
      "Bunest trustProxy supports boolean, hop count number, and CIDR/loopback allowlist",
    );
  },
);
