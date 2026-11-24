import { afterAll, beforeAll, describe, it } from "bun:test";
import {
  All,
  Controller,
  Get,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type VersioningOptions,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

@Controller({ path: "cats", version: "1" })
class CatsV1Controller {
  @All()
  all() {
    return "v1";
  }
}

@Controller({ path: "cats", version: "2" })
class CatsV2Controller {
  @All()
  all() {
    return "v2";
  }
}

@Controller("mixed")
class MixedController {
  @Version("1")
  @All()
  all() {
    return "all v1";
  }

  @Version("2")
  @Get()
  get() {
    return "get v2";
  }
}

@Controller({ path: "neutral", version: VERSION_NEUTRAL })
class NeutralController {
  @All()
  all() {
    return "neutral";
  }
}

describeConformance(
  "@All() versioning",
  {
    upstreamPath: "integration/versioning/e2e/all-method-versioning.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010", "ADR-011"],
    notes:
      "Adapted from FastifyAdapter to BunHttpAdapter; POST on @All() returns 201 Created per ADR-010; unmatched HTTP verb on matched versioned path returns 405 + Allow per ADR-011.",
  },
  () => {
    describe.each<
      [string, VersioningOptions, (version: string) => [string, string]]
    >([
      [
        "header",
        { type: VersioningType.HEADER, header: "X-API-Version" },
        (version) => ["X-API-Version", version],
      ],
      [
        "media type",
        { type: VersioningType.MEDIA_TYPE, key: "v=" },
        (version) => ["Accept", `application/json;v=${version}`],
      ],
      [
        "custom",
        {
          type: VersioningType.CUSTOM,
          extractor: (req: Request) => req.headers.get("x-api-version") ?? "",
        },
        (version) => ["X-API-Version", version],
      ],
    ])(
      "@All() versioning (BunHttpAdapter, %s)",
      (_, versioningOptions, versionHeader) => {
        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            controllers: [
              CatsV1Controller,
              CatsV2Controller,
              MixedController,
              NeutralController,
            ],
          }).compile();
          app = moduleRef.createNestApplication({ logger: false });
          app.enableVersioning(versioningOptions);
          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        const send = (
          method: "get" | "post",
          path: string,
          version?: string,
        ) => {
          const req = request(app)[method](path);
          if (version) {
            const [name, value] = versionHeader(version);
            return req.set(name, value);
          }
          return req;
        };

        itAdapted(
          ["ADR-001", "ADR-010"],
          "should route each version to its @All() handler",
          async () => {
            for (const method of ["get", "post"] as const) {
              const expectedStatus = method === "post" ? 201 : 200;
              await send(method, "/cats", "1").expect(expectedStatus, "v1");
              await send(method, "/cats", "2").expect(expectedStatus, "v2");
              await send(method, "/cats", "3").expect(404);
              await send(method, "/cats").expect(404);
            }
          },
          "POST on @All() defaults to 201 Created per ADR-010",
        );

        itAdapted(
          ["ADR-010", "ADR-011"],
          "should keep a @Get() of another version on the same path",
          async () => {
            await send("post", "/mixed", "1").expect(201, "all v1");
            await send("get", "/mixed", "2").expect(200, "get v2");
            // ADR-011: /mixed has GET for version 2, so POST returns 405 Method Not Allowed + Allow header
            await send("post", "/mixed", "2")
              .expect(405)
              .expect("allow", "GET, HEAD");
          },
          "unmatched method for existing version returns 405 + Allow per ADR-011",
        );

        itAdapted(
          "ADR-010",
          "should serve a version-neutral @All() for any version",
          async () => {
            await send("post", "/neutral").expect(201, "neutral");
            await send("post", "/neutral", "1").expect(201, "neutral");
          },
          "POST on @All() defaults to 201 Created per ADR-010",
        );
      },
    );
  },
);
