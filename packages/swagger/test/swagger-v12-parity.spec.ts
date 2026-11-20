import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { Body, Controller, Get, Module, Param, Post } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  ApiAmbiguousResponse,
  ApiBody,
  ApiCallbacks,
  ApiContinueResponse,
  ApiDefaultGetter,
  ApiEarlyhintsResponse,
  ApiExpectationFailedResponse,
  ApiFailedDependencyResponse,
  ApiFoundResponse,
  ApiHeader,
  ApiHttpVersionNotSupportedResponse,
  ApiIAmATeapotResponse,
  ApiIncludeEndpoint,
  ApiLengthRequiredResponse,
  ApiLink,
  ApiMisdirectedResponse,
  ApiNonAuthoritativeInformationResponse,
  ApiNotModifiedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPartialContentResponse,
  ApiPaymentRequiredResponse,
  ApiPermanentRedirectResponse,
  ApiPreconditionRequiredResponse,
  ApiProcessingResponse,
  ApiProperty,
  ApiProxyAuthenticationRequiredResponse,
  ApiQuery,
  ApiRequestedRangeNotSatisfiableResponse,
  ApiResetContentResponse,
  ApiResponse,
  ApiResponseProperty,
  ApiSchema,
  ApiSeeOtherResponse,
  ApiSwitchingProtocolsResponse,
  ApiTags,
  ApiTemporaryRedirectResponse,
  ApiUriTooLongResponse,
  ApiWebhook,
  DECORATORS,
  DECORATORS_PREFIX,
  DeepPartialType,
  DocumentBuilder,
  SwaggerModule,
  defaultStandardSchemaConverter,
  generateSchema,
  getSchemaPath,
  renderSwaggerHtml,
  serializeToYaml,
  type OpenAPIObject,
  type StandardJSONSchemaV1,
} from "../src/index";

enum OrderState {
  OPEN = "open",
  CLOSED = "closed",
}

@ApiSchema({ name: "CustomOrderModel", description: "Represents a customer order" })
class OrderDto {
  @ApiResponseProperty({ format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" })
  id!: string;

  @ApiProperty({
    enum: OrderState,
    enumName: "OrderStateEnum",
    enumSchema: { description: "Lifecycle state of an order" },
    "x-enumNames": ["OPEN", "CLOSED"],
  })
  state!: OrderState;

  @ApiProperty({
    type: String,
    link: () => CustomerDto,
    description: "Owning customer ID",
  })
  customerId!: string;

  @ApiProperty({
    type: "object",
    properties: {
      sku: { type: "string", minLength: 3 },
      qty: { type: "integer", minimum: 1 },
    },
    required: ["sku", "qty"],
    discriminator: { propertyName: "sku" },
    xml: { name: "lineItem", wrapped: true },
    contentEncoding: "utf-8",
    contentMediaType: "application/json",
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({
    default: () => new Date().toISOString(),
    example: { a: { b: { c: "deep" } } },
  })
  createdAt!: string;
}

class CustomerDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  name!: string;
}

class NestedAddressDto {
  @ApiProperty()
  street!: string;

  @ApiProperty()
  city!: string;
}

class DeepProfileDto {
  @ApiProperty()
  username!: string;

  @ApiProperty({ type: NestedAddressDto })
  primaryAddress!: NestedAddressDto;

  @ApiProperty({ type: [NestedAddressDto] })
  otherAddresses!: NestedAddressDto[];
}

class DeepPartialProfileDto extends DeepPartialType(DeepProfileDto) {}

class WebhookPayloadDto {
  @ApiProperty()
  eventId!: string;

  @ApiProperty()
  orderId!: string;
}

class QueryFilterDto {
  @ApiProperty({ description: "Search term" })
  q!: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 100 })
  limit?: number;
}

describe("@bunest/swagger v12 API Parity", () => {
  test("exports canonical DECORATORS constants and all 24 additional HTTP status Api*Response shorthands", async () => {
    expect(DECORATORS_PREFIX).toBe("swagger");
    expect(DECORATORS.API_OPERATION).toBe("swagger/apiOperation");
    expect(DECORATORS.API_SCHEMA).toBe("swagger/apiSchema");
    expect(DECORATORS.API_WEBHOOK).toBe("swagger/apiWebhook");
    expect(DECORATORS.API_LINK).toBe("swagger/apiLink");

    @Controller("/statuses")
    class StatusesController {
      @Get("1xx")
      @ApiContinueResponse()
      @ApiSwitchingProtocolsResponse()
      @ApiProcessingResponse()
      @ApiEarlyhintsResponse()
      informational() {
        return {};
      }

      @Get("2xx-3xx")
      @ApiNonAuthoritativeInformationResponse()
      @ApiResetContentResponse()
      @ApiPartialContentResponse()
      @ApiAmbiguousResponse()
      @ApiFoundResponse()
      @ApiSeeOtherResponse()
      @ApiNotModifiedResponse()
      @ApiTemporaryRedirectResponse()
      @ApiPermanentRedirectResponse()
      successAndRedirect() {
        return {};
      }

      @Get("4xx-5xx")
      @ApiPaymentRequiredResponse()
      @ApiProxyAuthenticationRequiredResponse()
      @ApiLengthRequiredResponse()
      @ApiUriTooLongResponse()
      @ApiRequestedRangeNotSatisfiableResponse()
      @ApiExpectationFailedResponse()
      @ApiIAmATeapotResponse()
      @ApiMisdirectedResponse()
      @ApiFailedDependencyResponse()
      @ApiPreconditionRequiredResponse()
      @ApiHttpVersionNotSupportedResponse()
      errors() {
        return {};
      }
    }

    @Module({ controllers: [StatusesController] })
    class StatusModule {}

    const app = await BunestFactory.create(StatusModule, { logger: false });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Statuses").build(),
      );
      expect(Object.keys(doc.paths["/statuses/1xx"]?.get?.responses ?? {})).toEqual(
        expect.arrayContaining(["100", "101", "102", "103"]),
      );
      expect(Object.keys(doc.paths["/statuses/2xx-3xx"]?.get?.responses ?? {})).toEqual(
        expect.arrayContaining(["203", "205", "206", "300", "302", "303", "304", "307", "308"]),
      );
      expect(Object.keys(doc.paths["/statuses/4xx-5xx"]?.get?.responses ?? {})).toEqual(
        expect.arrayContaining(["402", "407", "411", "414", "416", "417", "418", "421", "424", "428", "505"]),
      );
    } finally {
      await app.close();
    }
  });

  test("supports @ApiSchema, @ApiResponseProperty, @ApiWebhook, @ApiCallbacks, @ApiLink, @ApiDefaultGetter, @ApiTags(options), and expanded DocumentBuilder", async () => {
    expect(getSchemaPath(OrderDto)).toBe("#/components/schemas/CustomOrderModel");

    @ApiTags({ name: "Orders", parent: "Commerce", kind: "nav" })
    @Controller("/orders")
    class OrdersController {
      @Get(":id")
      @ApiOperation({
        summary: "Get order",
        servers: [{ url: "https://orders.example.com" }],
      })
      @ApiParam({
        name: "id",
        style: "simple",
        explode: false,
        extensions: { "x-param-source": "url" },
      })
      @ApiQuery({ type: QueryFilterDto })
      @ApiQuery({
        name: "sort",
        minLength: 2,
        maxLength: 30,
        pattern: "^[a-z]+$",
        allowEmptyValue: false,
        extensions: { "x-indexed": true },
      })
      @ApiHeader({
        name: "X-Correlation-Id",
        allowReserved: false,
        extensions: { "x-trace": true },
      })
      @ApiCallbacks({
        name: "onOrderUpdated",
        callbackUrl: "{$request.body#/callbackUrl}",
        method: "post",
        requestBody: { type: WebhookPayloadDto },
        expectedResponse: { status: 200, description: "Callback acknowledged" },
      })
      @ApiOkResponse({
        type: OrderDto,
        summary: "Order found",
        examples: {
          sample: { summary: "Sample order", value: { id: "ord_1" } },
        },
      })
      getOrder(@Param("id") id: string): OrderDto {
        return { id } as OrderDto;
      }

      @Post("hooks/created")
      @ApiWebhook("orderCreated")
      @ApiBody({
        type: WebhookPayloadDto,
        encoding: { eventId: { contentType: "text/plain" } },
      })
      onOrderCreated(@Body() payload: WebhookPayloadDto) {
        return payload;
      }
    }

    @Controller("/customers")
    class CustomersController {
      @Get(":customerId")
      @ApiDefaultGetter(CustomerDto, "customerId")
      @ApiLink({ from: OrderDto, fromField: "id", routeParam: "orderId" })
      @ApiOkResponse({ type: CustomerDto })
      getCustomer(@Param("customerId") customerId: string): CustomerDto {
        return { id: customerId, name: "Ada" };
      }
    }

    @Module({ controllers: [OrdersController, CustomersController] })
    class CommerceModule {}

    const app = await BunestFactory.create(CommerceModule, { logger: false });
    try {
      const config = new DocumentBuilder()
        .setTitle("Commerce API")
        .setOpenAPIVersion("3.1.0")
        .setBasePath("/legacy")
        .addCookieAuth("session_id")
        .addOAuth2({
          flows: {
            clientCredentials: {
              tokenUrl: "https://auth.example.com/token",
              scopes: { "orders:read": "Read orders" },
            },
          },
        })
        .addExtension("x-api-tier", "enterprise", "root")
        .addExtension("x-logo", { url: "https://bunest.dev/logo.png" }, "info")
        .addGlobalParameters({
          name: "X-Global-Region",
          in: "header",
          required: false,
          schema: { type: "string" },
        })
        .addGlobalResponse({
          status: 500,
          description: "Unexpected server error",
        })
        .addSecurityRequirements("oauth2", ["orders:read"])
        .build();

      const doc = SwaggerModule.createDocument(app, config, {
        excludeDynamicDefaults: true,
        exampleMaxDepth: 1,
      });

      expect(doc.openapi).toBe("3.1.0");
      expect(doc["x-api-tier"]).toBe("enterprise");
      expect(doc.info["x-logo"]).toEqual({ url: "https://bunest.dev/logo.png" });
      expect(doc.security).toEqual([{ oauth2: ["orders:read"] }]);
      expect(doc.components?.securitySchemes?.cookie).toMatchObject({
        type: "apiKey",
        in: "cookie",
        name: "session_id",
      });
      expect(doc.components?.securitySchemes?.oauth2).toMatchObject({
        type: "oauth2",
      });

      // Rich tag object merged into document.tags
      expect(doc.tags).toEqual(
        expect.arrayContaining([
          { name: "Orders", parent: "Commerce", kind: "nav" },
        ]),
      );

      // @ApiSchema custom name & description + @ApiResponseProperty readOnly + named enum + excludeDynamicDefaults + exampleMaxDepth
      const orderSchema = doc.components?.schemas?.CustomOrderModel;
      expect(orderSchema?.description).toBe("Represents a customer order");
      expect(orderSchema?.properties?.id).toMatchObject({
        readOnly: true,
        format: "uuid",
      });
      expect(orderSchema?.properties?.state).toEqual({
        $ref: "#/components/schemas/OrderStateEnum",
      });
      expect(doc.components?.schemas?.OrderStateEnum).toMatchObject({
        type: "string",
        enum: ["open", "closed"],
        "x-enumNames": ["OPEN", "CLOSED"],
        description: "Lifecycle state of an order",
      });
      expect(orderSchema?.properties?.createdAt).not.toHaveProperty("default");
      expect((orderSchema?.properties?.createdAt as { example?: unknown })?.example).toEqual({
        a: {},
      });

      // @ApiWebhook moves route to document.webhooks instead of document.paths
      expect(doc.paths["/orders/hooks/created"]).toBeUndefined();
      expect(doc.webhooks?.orderCreated?.post?.requestBody?.content["application/json"]?.encoding).toEqual({
        eventId: { contentType: "text/plain" },
      });

      // Global params, global response, @ApiCallbacks, @ApiLink + @ApiDefaultGetter
      const getOrderOp = doc.paths["/orders/{id}"]?.get;
      expect(getOrderOp?.servers).toEqual([{ url: "https://orders.example.com" }]);
      expect(getOrderOp?.parameters?.some((p) => p.name === "X-Global-Region")).toBe(true);
      expect(getOrderOp?.parameters?.some((p) => p.name === "q" && p.in === "query")).toBe(true);
      expect(getOrderOp?.parameters?.find((p) => p.name === "sort")?.schema).toMatchObject({
        minLength: 2,
        maxLength: 30,
        pattern: "^[a-z]+$",
      });
      expect(getOrderOp?.callbacks?.onOrderUpdated).toBeDefined();
      expect(getOrderOp?.responses["500"]?.description).toBe("Unexpected server error");
      expect(getOrderOp?.responses["200"]?.summary).toBe("Order found");
      expect(getOrderOp?.responses["200"]?.links).toEqual({
        CustomersController_getCustomer_from_id: {
          operationId: "CustomersController_getCustomer",
          parameters: { orderId: "$response.body#/id" },
        },
        CustomersController_getCustomer_from_customerId: {
          operationId: "CustomersController_getCustomer",
          parameters: { customerId: "$response.body#/customerId" },
        },
      });
    } finally {
      await app.close();
    }
  });

  test("supports DeepPartialType, standalone generateSchema, StandardSchemaConverter, onlyIncludeDecoratedEndpoints, autoTagControllers, ignoreGlobalPrefix, and loadPluginMetadata", async () => {
    // 1. Standalone generateSchema + DeepPartialType
    const generated = generateSchema(DeepPartialProfileDto, {
      PreExisting: { type: "string" },
    });
    expect(generated.schemas.PreExisting).toEqual({ type: "string" });
    expect(generated.schema.required).toBeUndefined();
    expect(generated.schema.properties?.primaryAddress).toEqual({
      $ref: "#/components/schemas/DeepPartialNestedAddressDto",
    });
    expect(generated.schema.properties?.otherAddresses).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/DeepPartialNestedAddressDto" },
    });
    expect(generated.schemas.DeepPartialNestedAddressDto?.required).toBeUndefined();
    expect(generated.schemas.DeepPartialNestedAddressDto?.properties?.city).toMatchObject({
      type: "string",
    });

    // 2. Built-in zero-dep Standard JSON Schema v1 (`~standard.jsonSchema`)
    const stdUserSchema: StandardJSONSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "bunest-test",
        jsonSchema: {
          input: () => ({
            type: "object",
            properties: { email: { type: "string", format: "email" } },
            required: ["email"],
          }),
          output: () => ({
            type: "object",
            properties: {
              id: { type: "string" },
              role: { $ref: "#/$defs/Role" },
            },
            $defs: {
              Role: { type: "string", enum: ["admin", "user"] },
            },
          }),
        },
      },
    };
    const converted = defaultStandardSchemaConverter(stdUserSchema, {
      schemaType: "output",
    });
    expect(converted?.schema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        role: { $ref: "#/components/schemas/Role" },
      },
    });
    expect(converted?.components).toEqual({
      Role: { type: "string", enum: ["admin", "user"] },
    });

    // 3. loadPluginMetadata + onlyIncludeDecoratedEndpoints + autoTagControllers + ignoreGlobalPrefix + StandardSchema response
    class PluginHydratedDto {}

    @Controller("/plugin-demo")
    class PluginDemoController {
      @Get("included")
      @ApiIncludeEndpoint()
      @ApiResponse({ status: 200, standardSchema: stdUserSchema, description: "Standard schema user" })
      includedHandler() {
        return {};
      }

      @Get("not-included")
      excludedByDefault() {
        return {};
      }

      @Get("hydrated")
      @ApiIncludeEndpoint()
      hydratedHandler() {
        return {};
      }
    }

    await SwaggerModule.loadPluginMetadata(async () => ({
      "@nestjs/swagger": {
        models: [
          [
            Promise.resolve({ PluginHydratedDto }),
            {
              PluginHydratedDto: {
                title: { type: String, required: true, description: "Hydrated title" },
                count: { type: Number, required: false },
              },
            },
          ],
        ],
        controllers: [
          [
            Promise.resolve({ PluginDemoController }),
            {
              PluginDemoController: {
                hydratedHandler: {
                  summary: "Hydrated summary from metadata.ts",
                  type: PluginHydratedDto,
                },
              },
            },
          ],
        ],
      },
    }));

    @Module({ controllers: [PluginDemoController] })
    class PluginDemoModule {}

    const app = await BunestFactory.create(PluginDemoModule, {
      logger: false,
      globalPrefix: "api",
    });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Plugin Demo").build(),
        {
          ignoreGlobalPrefix: true,
          autoTagControllers: false,
          onlyIncludeDecoratedEndpoints: true,
        },
      );

      // ignoreGlobalPrefix stripped `/api`, onlyIncludeDecoratedEndpoints skipped `not-included`
      expect(doc.paths["/plugin-demo/included"]?.get).toBeDefined();
      expect(doc.paths["/plugin-demo/not-included"]).toBeUndefined();
      expect(doc.paths["/api/plugin-demo/included"]).toBeUndefined();

      // autoTagControllers: false -> no auto tags
      expect(doc.paths["/plugin-demo/included"]?.get?.tags).toBeUndefined();

      // Standard Schema response + $defs merged into components.schemas
      expect(
        doc.paths["/plugin-demo/included"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({
        type: "object",
        properties: {
          id: { type: "string" },
          role: { $ref: "#/components/schemas/Role" },
        },
      });
      expect(doc.components?.schemas?.Role).toEqual({
        type: "string",
        enum: ["admin", "user"],
      });

      // Plugin metadata hydrated both controller operation and DTO schema!
      expect(doc.paths["/plugin-demo/hydrated"]?.get?.summary).toBe(
        "Hydrated summary from metadata.ts",
      );
      expect(doc.components?.schemas?.PluginHydratedDto?.properties?.title).toMatchObject({
        type: "string",
        description: "Hydrated title",
      });
    } finally {
      await app.close();
    }
  });

  test("serves zero-dep YAML, supports raw/swaggerUiEnabled/patchDocumentOnRequest/factory/custom assets", async () => {
    @Controller("/items")
    class ItemsController {
      @Get()
      list() {
        return [];
      }
    }

    @Module({ controllers: [ItemsController] })
    class YamlAppModule {}

    // 1. YAML serializer unit & Bun.YAML.parse round-trip check
    //    (reserved words, numeric strings, multiline, leading-space multiline, trailing blank lines, array multiline)
    const yamlInput = {
      openapi: "3.1.0",
      info: {
        title: "Demo: API",
        version: "1.0.0",
        description: "Line 1\nLine 2",
      },
      paths: {
        "/items": {
          get: {
            description: "  leading-space\nsecond line",
            summary: "trailing-blank-lines\n\n",
            responses: {
              "200": {
                description: "true",
                summary: "single-trailing-newline\n",
              },
            },
          },
        },
      },
      tags: [{ name: "Items", description: "\n  indented-after-blank\nnormal" }],
      "x-notes": ["  array-leading-space\nline2", "plain\n\n"],
    };
    const yamlStr = serializeToYaml(yamlInput);
    expect(yamlStr).toContain("openapi: 3.1.0");
    expect(yamlStr).toContain('title: "Demo: API"');
    expect(yamlStr).toContain('"200":');
    expect(yamlStr).toContain('description: "true"');
    expect(yamlStr).toContain("description: |-\n    Line 1\n    Line 2");
    expect(yamlStr).toContain("|2-");
    expect(yamlStr).toContain("|+");
    if (typeof (Bun as unknown as { YAML?: { parse?: (s: string) => unknown } }).YAML?.parse === "function") {
      const roundTripped = (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(yamlStr);
      expect(roundTripped).toEqual(yamlInput);
    }

    // 2. Full setup with YAML, patchDocumentOnRequest, explorer, customCssUrl/customJs/customJsStr/customfavIcon
    const app = await BunestFactory.create(YamlAppModule, { logger: false });
    try {
      const factory = (): OpenAPIObject =>
        SwaggerModule.createDocument(
          app,
          new DocumentBuilder().setTitle("Dynamic YAML API").build(),
        );

      SwaggerModule.setup("/docs", app, factory, {
        yamlDocumentUrl: "/spec.yaml",
        explorer: true,
        customfavIcon: "/favicon.ico",
        customCssUrl: ["/theme.css"],
        customJs: "/extra.js",
        customJsStr: "window.__READY__ = true;</script><bad>",
        patchDocumentOnRequest: (req, _res, doc) => {
          const tenant = (req as Request).headers.get("x-tenant") ?? "default";
          return {
            ...doc,
            info: { ...doc.info, title: `${doc.info.title} (${tenant})` },
          };
        },
      });

      const yamlRes = await app.fetch(
        new Request("http://localhost/spec.yaml", {
          headers: { "x-tenant": "acme" },
        }),
      );
      expect(yamlRes.status).toBe(200);
      expect(yamlRes.headers.get("content-type")).toContain("text/yaml");
      const yamlBody = await yamlRes.text();
      expect(yamlBody).toContain("title: Dynamic YAML API (acme)");

      const htmlRes = await app.fetch(
        new Request("http://localhost/docs", {
          headers: { "x-tenant": "acme" },
        }),
      );
      expect(htmlRes.status).toBe(200);
      const html = await htmlRes.text();
      expect(html).toContain('href="/spec.yaml"');
      expect(html).toContain('href="/favicon.ico"');
      expect(html).toContain('href="/theme.css"');
      expect(html).toContain('src="/extra.js"');
      expect(html).toContain("explorer-filter");
      expect(html).not.toContain("</script><bad>");
      expect(html).toContain("Dynamic YAML API (acme)");
    } finally {
      await app.close();
    }

    // 3. swaggerUiEnabled: false + raw: ["yaml"] disables HTML & JSON routes cleanly
    const appYamlOnly = await BunestFactory.create(YamlAppModule, {
      logger: false,
    });
    try {
      const doc = SwaggerModule.createDocument(
        appYamlOnly,
        new DocumentBuilder().setTitle("YAML Only").build(),
      );
      SwaggerModule.setup("/docs", appYamlOnly, doc, {
        swaggerUiEnabled: false,
        raw: ["yaml"],
      });

      expect((await appYamlOnly.fetch(new Request("http://localhost/docs"))).status).toBe(404);
      expect((await appYamlOnly.fetch(new Request("http://localhost/docs-json"))).status).toBe(404);
      const yamlRes = await appYamlOnly.fetch(new Request("http://localhost/docs-yaml"));
      expect(yamlRes.status).toBe(200);
      expect(await yamlRes.text()).toContain("title: YAML Only");

      // Also verify renderSwaggerHtml swagger-ui preset forwards urls/validatorUrl/swaggerOptions
      const preset = renderSwaggerHtml(doc, "/docs-json", {
        ui: "swagger-ui",
        validatorUrl: "https://validator.swagger.io/validator",
        urls: [{ name: "v1", url: "/v1-json" }],
        swaggerOptions: { persistAuthorization: true },
      });
      expect(preset).toContain("persistAuthorization");
      expect(preset).toContain("validator.swagger.io");
      expect(preset).toContain("/v1-json");
    } finally {
      await appYamlOnly.close();
    }
  });
});
