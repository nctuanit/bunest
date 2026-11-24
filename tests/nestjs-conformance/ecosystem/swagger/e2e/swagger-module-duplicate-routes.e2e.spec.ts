import { expect, it } from "bun:test";
import { Controller, Get, Module } from "../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiBearerAuth,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule handlers sharing a path and method",
  {
    upstreamPath: "e2e/swagger-module-duplicate-routes.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapts Express/Fastify NestFactory to BunestFactory with routeConflictPolicy: 'warn' (ADR-001, ADR-011).",
  },
  () => {
    @Controller("patterns")
    class PatternsController {
      @Get("wildcard-first/:path")
      @ApiBearerAuth()
      protectedParam() {}

      @Get("wildcard-first/*path")
      openWildcard() {}

      @Get("wildcard-last/:path")
      openParam() {}

      @Get("wildcard-last/*path")
      @ApiBearerAuth()
      protectedWildcard() {}

      @Get("legacy-wildcard/:path")
      @ApiBearerAuth()
      protectedLegacyParam() {}

      @Get("legacy-wildcard/*")
      openLegacyWildcard() {}

      @Get("group-first/:id")
      @ApiBearerAuth()
      protectedRequired() {}

      @Get("group-first{/:id}")
      openOptional() {}

      @Get("group-last/:id")
      openRequired() {}

      @Get("group-last{/:id}")
      @ApiBearerAuth()
      protectedOptional() {}

      @Get("single/:id")
      @ApiBearerAuth()
      single() {}
    }

    @Controller("regexps")
    class RegexpsController {
      @Get("first/:ref(^\\d+)")
      @ApiBearerAuth()
      protectedFirst() {}

      @Get("first/:ref")
      openLast() {}

      @Get("last/:ref")
      openFirst() {}

      @Get("last/:ref(^\\d+)")
      @ApiBearerAuth()
      protectedLast() {}
    }

    @Module({ controllers: [PatternsController] })
    class AppModule {}

    @Module({ controllers: [RegexpsController] })
    class RegexpAppModule {}

    const bearer = [{ bearer: [] }];
    const config = new DocumentBuilder().addBearerAuth().build();

    it("keeps the security requirements of every route pattern", async () => {
      const app = await BunestFactory.create(AppModule, {
        logger: false,
        routeConflictPolicy: "warn",
      });
      try {
        await app.init();
        const document = SwaggerModule.createDocument(app, config);

        const cases: Array<[string, string]> = [
          ["/patterns/wildcard-first/{path}", "openWildcard"],
          ["/patterns/wildcard-last/{path}", "protectedWildcard"],
          ["/patterns/legacy-wildcard/{path}", "openLegacyWildcard"],
          ["/patterns/group-first/{id}", "openOptional"],
          ["/patterns/group-last/{id}", "protectedOptional"],
          ["/patterns/single/{id}", "single"],
        ];
        for (const [path, handler] of cases) {
          expect(document.paths[path]?.get).toMatchObject({
            operationId: `PatternsController_${handler}`,
            security: bearer,
          });
        }
      } finally {
        await app.close();
      }
    });

    it("keeps the security requirements of every inline regexp", async () => {
      const app = await BunestFactory.create(RegexpAppModule, {
        logger: false,
        routeConflictPolicy: "warn",
      });
      try {
        await app.init();
        const document = SwaggerModule.createDocument(app, config);

        expect(document.paths["/regexps/first/{ref}"]?.get).toMatchObject({
          operationId: "RegexpsController_openLast",
          security: bearer,
        });
        expect(document.paths["/regexps/last/{ref}"]?.get).toMatchObject({
          operationId: "RegexpsController_protectedLast",
          security: bearer,
        });
      } finally {
        await app.close();
      }
    });
  },
);
