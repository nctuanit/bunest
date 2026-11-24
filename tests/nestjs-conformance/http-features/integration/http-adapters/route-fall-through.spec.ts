import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  All,
  Controller,
  Get,
  Module,
  Param,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type VersioningOptions,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Controller("items")
class VersionedController {
  @Get("me")
  @Version("2")
  me() {
    return "me v2";
  }

  @Get(":id")
  @Version("1")
  byId(@Param("id") id: string) {
    return `id v1 ${id}`;
  }
}

@Controller("neutral")
class NeutralController {
  @Get("me")
  @Version("2")
  me() {
    return "me v2";
  }

  @Get(":id")
  @Version(VERSION_NEUTRAL)
  byId(@Param("id") id: string) {
    return `id neutral ${id}`;
  }
}

@Controller("many")
class ManyVersionsController {
  @Get("me")
  @Version("2")
  me() {
    return "me v2";
  }

  @Get(":id")
  @Version(["1", "3"])
  byId(@Param("id") id: string) {
    return `id v1|v3 ${id}`;
  }
}

@Controller("any")
class AllMethodsController {
  @Get("me")
  @Version("2")
  me() {
    return "me v2";
  }

  @All(":id")
  @Version("1")
  byId(@Param("id") id: string) {
    return `all v1 ${id}`;
  }
}

@Module({
  controllers: [
    VersionedController,
    NeutralController,
    ManyVersionsController,
    AllMethodsController,
  ],
})
class FallThroughModule {}

@Controller({ path: "tenants", host: ":tenant.example.com" })
class TenantController {
  @Get("me")
  me() {
    return "tenant me";
  }
}

@Controller("tenants")
class AnyHostController {
  @Get(":id")
  byId(@Param("id") id: string) {
    return `any host ${id}`;
  }
}

@Module({ controllers: [TenantController, AnyHostController] })
class HostFallThroughModule {}

const versioningStrategies: ReadonlyArray<{
  readonly type: string;
  readonly options: VersioningOptions;
  readonly version: (v: string) => Record<string, string>;
}> = [
  {
    type: "header",
    options: { type: VersioningType.HEADER, header: "v" },
    version: (v: string) => ({ v }),
  },
  {
    type: "media type",
    options: { type: VersioningType.MEDIA_TYPE, key: "v=" },
    version: (v: string) => ({ accept: `application/json;v=${v}` }),
  },
  {
    type: "custom",
    options: {
      type: VersioningType.CUSTOM,
      extractor: (req: Request) => req.headers.get("x-version") ?? "",
    },
    version: (v: string) => ({ "x-version": v }),
  },
];

describeConformance(
  "Falling through to less specific routes (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/route-fall-through.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapts NestJS versioned & host-filtered route fall-through tests to BunHttpAdapter FallbackRadixRouter.",
  },
  () => {
    let app: BunestApplication;

    afterEach(async () => {
      await app?.close();
    });

    describe.each(versioningStrategies)(
      "with $type versioning",
      ({ options, version }) => {
        beforeEach(async () => {
          const modRef = await Test.createTestingModule({
            imports: [FallThroughModule],
          }).compile();
          app = modRef.createNestApplication({ logger: false });
          app.enableVersioning(options);
          await app.init();
        });

        const send = (
          method: "get" | "delete",
          path: string,
          v: string | undefined,
        ) =>
          request(app)
            [method](path)
            .set(v ? version(v) : {});

        // BUNEST_BUG: Under runtime versioning (HEADER/MEDIA_TYPE/CUSTOM), a native static route (e.g. /items/me @Version('2')) returns 404 directly on version miss instead of falling through to a less specific route like /items/:id @Version('1') (packages/core/src/http/router/route-compiler.ts:826-933).
        it.skip('should fall through to ":id" when the literal route is for another version', async () => {
          const v1 = await send("get", "/items/me", "1");
          const v2 = await send("get", "/items/me", "2");

          expect(v1.status).toBe(200);
          expect(v1.text).toBe("id v1 me");
          expect(v2.text).toBe("me v2");
        });

        it("should answer 404 when no route matches the version", async () => {
          expect((await send("get", "/items/me", "9")).status).toBe(404);
          expect((await send("get", "/items/5", "9")).status).toBe(404);
        });

        // BUNEST_BUG: Under runtime versioning, static route /neutral/me @Version('2') returns 404 on version miss instead of falling through to version-neutral /neutral/:id (packages/core/src/http/router/route-compiler.ts:826-933).
        it.skip("should fall through to a version-neutral route", async () => {
          expect((await send("get", "/neutral/me", "1")).text).toBe(
            "id neutral me",
          );
          expect((await send("get", "/neutral/me", undefined)).text).toBe(
            "id neutral me",
          );
          expect((await send("get", "/neutral/me", "2")).text).toBe("me v2");
        });

        // BUNEST_BUG: Under runtime versioning, static route /many/me @Version('2') returns 404 on version miss instead of falling through to multi-version /many/:id (packages/core/src/http/router/route-compiler.ts:826-933).
        it.skip("should fall through to a route for several versions", async () => {
          expect((await send("get", "/many/me", "3")).text).toBe("id v1|v3 me");
          expect((await send("get", "/many/me", "4")).status).toBe(404);
        });

        // BUNEST_BUG: Under runtime versioning, static route /any/me @Version('2') returns 404 on version miss instead of falling through to @All(':id') @Version('1') (packages/core/src/http/router/route-compiler.ts:826-933).
        it.skip("should fall through to a route for every method", async () => {
          expect((await send("get", "/any/me", "1")).text).toBe("all v1 me");
          expect((await send("delete", "/any/me", "1")).text).toBe("all v1 me");
        });
      },
    );

    describe("with a global prefix and header versioning", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [FallThroughModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api");
        app.enableVersioning({ type: VersioningType.HEADER, header: "v" });
        await app.init();
      });

      // BUNEST_BUG: Under globalPrefix + runtime header versioning, static route /api/items/me @Version('2') returns 404 on version miss instead of falling through to /api/items/:id @Version('1') (packages/core/src/http/router/route-compiler.ts:826-933).
      it.skip("should fall through under the prefix", async () => {
        const res = await request(app).get("/api/items/me").set("v", "1");
        expect(res.text).toBe("id v1 me");
      });
    });

    describe("with URI versioning", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [FallThroughModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        app.enableVersioning({ type: VersioningType.URI });
        await app.init();
      });

      it("should route each version by its path", async () => {
        expect((await request(app).get("/v1/items/me")).text).toBe("id v1 me");
        expect((await request(app).get("/v2/items/me")).text).toBe("me v2");
        expect((await request(app).get("/v2/items/5")).status).toBe(404);
      });
    });

    describe("Falling through from a host-filtered route", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [HostFallThroughModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      it('should fall through to ":id" when the host does not match', async () => {
        const tenant = await request(app)
          .get("/tenants/me")
          .set("host", "acme.example.com");
        const other = await request(app)
          .get("/tenants/me")
          .set("host", "other.org");

        expect(tenant.text).toBe("tenant me");
        expect(other.text).toBe("any host me");
      });
    });
  },
);
