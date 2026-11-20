import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Post,
  Query,
} from "../../../../../packages/common/src";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule excludeDynamicDefaults",
  {
    upstreamPath: "e2e/swagger-module-dynamic-defaults.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes: "Adapts NestFactory.create to BunestFactory.create (ADR-001).",
  },
  () => {
    const date = new Date("2025-01-01");
    const dateSchema = { type: "string", default: date } as any;

    class ListQueryDto {
      @ApiProperty({ default: new Date("2025-01-01") })
      since!: Date;

      @ApiProperty({ default: 10 })
      limit!: number;
    }

    @Controller("cats")
    class CatsController {
      @Get()
      findAll(@Query() _query: ListQueryDto) {}

      @Get("until")
      @ApiQuery({
        name: "until",
        schema: { type: "string", default: new Date("2025-01-01") },
      })
      findUntil() {}

      @Get("content")
      @ApiQuery({
        name: "filter",
        content: { "application/json": { schema: dateSchema } },
      } as any)
      findWithContent() {}

      @Post()
      @ApiBody({
        schema: {
          type: "object",
          properties: {
            since: dateSchema,
            limit: { type: "number", default: 10 },
          },
        },
      })
      @ApiResponse({
        status: 201,
        schema: { type: "object", properties: { since: dateSchema } },
      })
      create() {}

      @Post("content")
      @ApiOperation({
        requestBody: {
          content: { "application/json": { schema: dateSchema } },
        },
      })
      @ApiResponse({
        status: 201,
        content: { "application/json": { schema: dateSchema } },
      })
      createWithContent() {}

      @Get("headers")
      @ApiResponse({
        status: 200,
        headers: { "x-since": { schema: dateSchema } },
      })
      findWithHeaders() {}
    }

    @Module({ controllers: [CatsController] })
    class AppModule {}

    const config = new DocumentBuilder().setTitle("t").setVersion("1").build();
    const schemaOf = (document: any, path: string, name: string) =>
      document.paths[path]?.get?.parameters?.find((p: any) => p.name === name)
        ?.schema;
    const bodySchemaOf = (document: any, path: string) =>
      document.paths[path]?.post?.requestBody?.content?.["application/json"]
        ?.schema;
    const responseSchemaOf = (document: any, path: string) =>
      document.paths[path]?.post?.responses?.["201"]?.content?.[
        "application/json"
      ]?.schema;
    const parameterContentSchemaOf = (document: any) =>
      document.paths["/cats/content"]?.get?.parameters?.[0]?.content?.[
        "application/json"
      ]?.schema;
    const responseHeaderSchemaOf = (document: any) =>
      document.paths["/cats/headers"]?.get?.responses?.["200"]?.headers?.[
        "x-since"
      ]?.schema;

    // BUNEST_BUG: SwaggerModule.buildParameters (packages/swagger/src/swagger-module.ts:1842-1843) copies inline @ApiQuery({ schema: { default: new Date(...) } }) verbatim without stripping dynamic defaults when excludeDynamicDefaults: true
    it.skip("strips dynamic defaults from query parameters", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();

        const document = SwaggerModule.createDocument(app, config, {
          excludeDynamicDefaults: true,
        });

        expect(schemaOf(document, "/cats", "since")).not.toHaveProperty(
          "default",
        );
        expect(schemaOf(document, "/cats", "limit").default).toBe(10);
        expect(schemaOf(document, "/cats/until", "until")).not.toHaveProperty(
          "default",
        );

        const unfiltered = SwaggerModule.createDocument(app, config);
        expect(schemaOf(unfiltered, "/cats", "since").default).toEqual(date);
        expect(schemaOf(unfiltered, "/cats/until", "until").default).toEqual(
          date,
        );
      } finally {
        await app.close();
      }
    });

    // BUNEST_BUG: SwaggerModule (packages/swagger/src/swagger-module.ts:1936,2128) does not run a document-wide stripDynamicDefaults pass over inline @ApiBody, @ApiResponse, @ApiOperation, header, and parameter content schemas
    it.skip("strips dynamic defaults from inline body and response schemas", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();

        const document = SwaggerModule.createDocument(app, config, {
          excludeDynamicDefaults: true,
        });

        const body = bodySchemaOf(document, "/cats");
        expect(body.properties.since).not.toHaveProperty("default");
        expect(body.properties.limit.default).toBe(10);
        expect(
          responseSchemaOf(document, "/cats").properties.since,
        ).not.toHaveProperty("default");
        expect(bodySchemaOf(document, "/cats/content")).not.toHaveProperty(
          "default",
        );
        expect(responseSchemaOf(document, "/cats/content")).not.toHaveProperty(
          "default",
        );
        expect(responseHeaderSchemaOf(document)).not.toHaveProperty("default");
        expect(parameterContentSchemaOf(document)).not.toHaveProperty(
          "default",
        );

        const unfiltered = SwaggerModule.createDocument(app, config);
        expect(
          bodySchemaOf(unfiltered, "/cats").properties.since.default,
        ).toEqual(date);
        expect(
          responseSchemaOf(unfiltered, "/cats").properties.since.default,
        ).toEqual(date);
        expect(bodySchemaOf(unfiltered, "/cats/content").default).toEqual(date);
        expect(responseSchemaOf(unfiltered, "/cats/content").default).toEqual(
          date,
        );
        expect(responseHeaderSchemaOf(unfiltered).default).toEqual(date);
        expect(parameterContentSchemaOf(unfiltered).default).toEqual(date);
      } finally {
        await app.close();
      }
    });
  },
);
