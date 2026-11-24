import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BunestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance, itAdapted, request } from "../../../_helpers";
import {
  ApplicationModule,
  FullSwaggerAppModule,
} from "./fixtures/cats-app.fixture";
import { validateOpenApiDocument } from "./fixtures/validate-openapi.helper";

function readQueryParam(req: unknown, name: string): string | undefined {
  const r = req as Request;
  const val = new URL(r.url).searchParams.get(name);
  return val ?? undefined;
}

describeConformance(
  "Swagger HTTP (Express Swagger E2E port)",
  {
    upstreamPath: "e2e/express.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ExpressAdapter + supertest + @apidevtools/swagger-parser + swagger-ui-dist to BunestFactory, zero-socket request(app), structural OpenAPI validation, and Web Standard Request in patchDocumentOnRequest (ADR-001, ADR-013).",
  },
  () => {
    let app: BunestApplication;
    let builder: DocumentBuilder;

    beforeEach(async () => {
      app = await BunestFactory.create(FullSwaggerAppModule, { logger: false });

      builder = new DocumentBuilder()
        .setTitle("Cats example")
        .setDescription("The cats API description")
        .setVersion("1.0")
        .addTag("cats")
        .addBasicAuth()
        .addBearerAuth()
        .addOAuth2()
        .addApiKey()
        .addApiKey({ type: "apiKey" }, "key1")
        .addApiKey({ type: "apiKey" }, "key2")
        .addCookieAuth()
        .addSecurityRequirements("bearer")
        .addSecurityRequirements({ basic: [], cookie: [] })
        .addGlobalParameters({
          name: "x-tenant-id",
          in: "header",
          schema: { type: "string" },
        });
    });

    afterEach(async () => {
      await app.close();
    });

    it("should produce a valid OpenAPI schema", () => {
      const document = SwaggerModule.createDocument(app, builder.build());
      const api = validateOpenApiDocument(document);
      expect(api.info.title).toEqual("Cats example");
      expect(api.info.version).toEqual("1.0");
    });

    it("should fix colons in url", () => {
      const document = SwaggerModule.createDocument(app, builder.build());
      expect(document.paths["/express:colon:another/{prop}"]).toBeDefined();
    });

    it("should setup multiple routes", async () => {
      const document1 = SwaggerModule.createDocument(app, builder.build());
      SwaggerModule.setup("/swagger1", app, document1);

      const document2 = SwaggerModule.createDocument(app, builder.build());
      SwaggerModule.setup("/swagger2", app, document2);

      await app.init();
      expect(app.getHttpAdapter()).toBeDefined();

      const res1 = await request(app).get("/swagger1-json");
      const res2 = await request(app).get("/swagger2-json");
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    describe("served swagger ui", () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument);
        await app.init();
      });

      it("content type of served json document should be valid", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);

        expect(response.status).toEqual(200);
        expect(Object.keys(response.body).length).toBeGreaterThan(0);
      });

      itAdapted(
        "ADR-001",
        "content type of served UI HTML should be available",
        async () => {
          const response = await request(app).get(SWAGGER_RELATIVE_URL);

          expect(response.status).toEqual(200);
          expect(response.headers["content-type"]).toContain("text/html");
        },
        "Bunest serves self-contained HTML UI without swagger-ui-dist static JS bundles (ADR-001)",
      );
    });

    describe("served swagger ui from a custom path under a nested route", () => {
      const SWAGGER_RELATIVE_URL = "/api/docs";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          customCssUrl: "/custom/theme.css",
        });
        await app.init();
      });

      it("should serve UI under the nested route prefix", async () => {
        const response = await request(app).get(SWAGGER_RELATIVE_URL);
        expect(response.status).toEqual(200);
        expect(response.text).toContain("/custom/theme.css");
      });

      it("should serve JSON document under the nested route prefix", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);
        expect(response.status).toEqual(200);
        expect(response.body.info.title).toBe("Cats example");
      });
    });

    describe("disabled Swagger UI but served JSON/YAML definitions", () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          ui: false,
        });
        await app.init();
      });

      it("should serve the JSON definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);

        expect(response.status).toEqual(200);
        expect(Object.keys(response.body).length).toBeGreaterThan(0);
      });

      it("should serve the YAML definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-yaml`);

        expect(response.status).toEqual(200);
        expect(response.text.length).toBeGreaterThan(0);
      });

      it.each([
        "/apidoc",
        "/apidoc/",
        "/apidoc/swagger-ui-bundle.js",
        "/apidoc/swagger-ui-init.js",
      ])('should not serve "%s"', async (file) => {
        const response = await request(app).get(file);

        expect(response.status).toEqual(404);
      });
    });

    describe("disabled Swagger Documents(JSON, YAML) but served Swagger UI", () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          raw: false,
        });
        await app.init();
      });

      it("should not serve the JSON definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);
        expect(response.status).toEqual(404);
      });

      it("should not serve the YAML definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-yaml`);
        expect(response.status).toEqual(404);
      });

      it('should serve Swagger UI at "/apidoc"', async () => {
        const response = await request(app).get(SWAGGER_RELATIVE_URL);
        expect(response.status).toEqual(200);
      });

      it('should serve Swagger UI at "/apidoc/"', async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}/`);
        expect(response.status).toEqual(200);
      });

      it("should not serve pet store spec", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}/api`);
        expect(response.status).toEqual(404);
      });

      it("should not serve the LICENSE file", async () => {
        const response = await request(app).get(
          `${SWAGGER_RELATIVE_URL}/LICENSE`,
        );

        expect(response.status).toEqual(404);
        expect(response.body.statusCode).toBe(404);
      });
    });

    describe("disabled Both Swagger UI AND Swagger Documents(JSON, YAML)", () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          ui: false,
          raw: false,
        });
        await app.init();
      });

      it("should not serve the JSON definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);
        expect(response.status).toEqual(404);
      });

      it("should not serve the YAML definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-yaml`);
        expect(response.status).toEqual(404);
      });

      it.each([SWAGGER_RELATIVE_URL, `${SWAGGER_RELATIVE_URL}/`])(
        'should not serve Swagger UI at "%s"',
        async (url) => {
          const response = await request(app).get(url);
          expect(response.status).toEqual(404);
        },
      );
    });

    describe('Serve only JSON definition when raw is ["json"]', () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          raw: ["json"],
        });
        await app.init();
      });

      it("should serve only the JSON definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);
        expect(response.status).toEqual(200);
        expect(Object.keys(response.body).length).toBeGreaterThan(0);
      });

      it("should not serve the YAML definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-yaml`);
        expect(response.status).toEqual(404);
      });

      it('should serve Swagger UI at "/apidoc"', async () => {
        const response = await request(app).get(SWAGGER_RELATIVE_URL);
        expect(response.status).toEqual(200);
      });

      it('should serve Swagger UI at "/apidoc/"', async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}/`);
        expect(response.status).toEqual(200);
      });
    });

    describe('Serve only YAML definition when raw is ["yaml"]', () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          raw: ["yaml"],
        });
        await app.init();
      });

      it("should serve only the YAML definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-yaml`);
        expect(response.status).toEqual(200);
        expect(response.text.length).toBeGreaterThan(0);
      });

      it("should not serve the JSON definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);
        expect(response.status).toEqual(404);
      });

      it('should serve Swagger UI at "/apidoc"', async () => {
        const response = await request(app).get(SWAGGER_RELATIVE_URL);
        expect(response.status).toEqual(200);
      });

      it('should serve Swagger UI at "/apidoc/"', async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}/`);
        expect(response.status).toEqual(200);
      });
    });

    describe("Serve no definitions when raw is an empty array", () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument, {
          raw: [],
        });
        await app.init();
      });

      it("should not serve the JSON definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-json`);
        expect(response.status).toEqual(404);
      });

      it("should not serve the YAML definition file", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}-yaml`);
        expect(response.status).toEqual(404);
      });

      it('should serve Swagger UI at "/apidoc"', async () => {
        const response = await request(app).get(SWAGGER_RELATIVE_URL);
        expect(response.status).toEqual(200);
      });

      it('should serve Swagger UI at "/apidoc/"', async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}/`);
        expect(response.status).toEqual(200);
      });
    });

    describe("custom documents endpoints", () => {
      const JSON_CUSTOM_URL = "/apidoc-json";
      const YAML_CUSTOM_URL = "/apidoc-yaml";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup("api", app, swaggerDocument, {
          jsonDocumentUrl: JSON_CUSTOM_URL,
          yamlDocumentUrl: YAML_CUSTOM_URL,
          patchDocumentOnRequest: (req, _res, document) => ({
            ...document,
            info: {
              ...document.info,
              description: readQueryParam(req, "description"),
            },
          }),
        });
        await app.init();
      });

      it("json document should be served in the custom url", async () => {
        const response = await request(app).get(JSON_CUSTOM_URL);

        expect(response.status).toEqual(200);
        expect(Object.keys(response.body).length).toBeGreaterThan(0);
      });

      it("patched JSON document should be served", async () => {
        const response = await request(app).get(
          `${JSON_CUSTOM_URL}?description=My%20custom%20description`,
        );

        expect(response.body.info.description).toBe("My custom description");
      });

      it("yaml document should be served in the custom url", async () => {
        const response = await request(app).get(YAML_CUSTOM_URL);

        expect(response.status).toEqual(200);
        expect(response.text.length).toBeGreaterThan(0);
      });

      it("patched YAML document should be served", async () => {
        const response = await request(app).get(
          `${YAML_CUSTOM_URL}?description=My%20custom%20description`,
        );
        expect(response.text).toContain("My custom description");
      });
    });

    describe("async patchDocumentOnRequest", () => {
      const JSON_CUSTOM_URL = "/async-apidoc-json";
      const YAML_CUSTOM_URL = "/async-apidoc-yaml";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup("async-api", app, swaggerDocument, {
          jsonDocumentUrl: JSON_CUSTOM_URL,
          yamlDocumentUrl: YAML_CUSTOM_URL,
          patchDocumentOnRequest: async (req, _res, document) => {
            const description = await Promise.resolve(
              readQueryParam(req, "description"),
            );
            return {
              ...document,
              info: { ...document.info, description },
            };
          },
        });
        await app.init();
      });

      it("async patched JSON document should be served", async () => {
        const response = await request(app).get(
          `${JSON_CUSTOM_URL}?description=Async%20description`,
        );
        expect(response.body.info.description).toBe("Async description");
      });

      it("async patched YAML document should be served", async () => {
        const response = await request(app).get(
          `${YAML_CUSTOM_URL}?description=Async%20description`,
        );
        expect(response.text).toContain("Async description");
      });

      itAdapted(
        "ADR-001",
        "async patched UI HTML should embed the patched document",
        async () => {
          const response = await request(app).get(
            `/async-api?description=Async%20UI%20description`,
          );
          expect(response.status).toBe(200);
          expect(response.text).toContain(
            '"description":"Async UI description"',
          );
        },
        "Bunest embeds the patched OpenAPI JSON directly in the UI HTML page rather than a separate swagger-ui-init.js endpoint",
      );

      it("sync patchDocumentOnRequest still works (backwards compatibility)", async () => {
        const app2 = await BunestFactory.create(ApplicationModule, {
          logger: false,
        });
        try {
          const doc = SwaggerModule.createDocument(app2, builder.build());
          SwaggerModule.setup("compat-api", app2, doc, {
            jsonDocumentUrl: "/compat-json",
            patchDocumentOnRequest: (req, _res, document) => ({
              ...document,
              info: {
                ...document.info,
                description: readQueryParam(req, "description"),
              },
            }),
          });
          await app2.init();

          const response = await request(app2).get(
            "/compat-json?description=Sync%20description",
          );
          expect(response.body.info.description).toBe("Sync description");
        } finally {
          await app2.close();
        }
      });
    });

    describe("custom documents endpoints with global prefix", () => {
      let appGlobalPrefix: BunestApplication;

      const GLOBAL_PREFIX = "/v1";
      const JSON_CUSTOM_URL = "/apidoc-json";
      const YAML_CUSTOM_URL = "/apidoc-yaml";

      beforeEach(async () => {
        appGlobalPrefix = await BunestFactory.create(ApplicationModule, {
          logger: false,
        });
        appGlobalPrefix.setGlobalPrefix(GLOBAL_PREFIX);

        const swaggerDocument = SwaggerModule.createDocument(
          appGlobalPrefix,
          builder.build(),
        );
        SwaggerModule.setup("api", appGlobalPrefix, swaggerDocument, {
          useGlobalPrefix: true,
          jsonDocumentUrl: JSON_CUSTOM_URL,
          yamlDocumentUrl: YAML_CUSTOM_URL,
        });

        await appGlobalPrefix.init();
      });

      afterEach(async () => {
        await appGlobalPrefix.close();
      });

      it("json document should be served in the custom url", async () => {
        const response = await request(appGlobalPrefix).get(
          `${GLOBAL_PREFIX}${JSON_CUSTOM_URL}`,
        );

        expect(response.status).toEqual(200);
        expect(Object.keys(response.body).length).toBeGreaterThan(0);
      });

      it("yaml document should be served in the custom url", async () => {
        const response = await request(appGlobalPrefix).get(
          `${GLOBAL_PREFIX}${YAML_CUSTOM_URL}`,
        );

        expect(response.status).toEqual(200);
        expect(response.text.length).toBeGreaterThan(0);
      });
    });

    describe("API tags", () => {
      it("should auto generate tags for controllers", () => {
        const document = SwaggerModule.createDocument(app, builder.build());
        const api = validateOpenApiDocument(document);
        const getPath = api.paths["/"]?.get;
        expect(getPath?.tags).toEqual(["App"]);
      });
    });

    describe("trailing slash and UI route handling", () => {
      const SWAGGER_RELATIVE_URL = "/apidoc";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );
        SwaggerModule.setup(SWAGGER_RELATIVE_URL, app, swaggerDocument);
        await app.init();
      });

      it("should serve HTML when accessed without trailing slash", async () => {
        const response = await request(app).get(SWAGGER_RELATIVE_URL);
        expect(response.status).toEqual(200);
        expect(response.text).toContain("OpenAPI JSON (/apidoc-json)");
      });

      it("should serve HTML when accessed with trailing slash", async () => {
        const response = await request(app).get(`${SWAGGER_RELATIVE_URL}/`);
        expect(response.status).toEqual(200);
        expect(response.headers["content-type"]).toContain("text/html");
      });

      it("should serve HTML when accessed through index.html", async () => {
        const response = await request(app).get(
          `${SWAGGER_RELATIVE_URL}/index.html`,
        );
        expect(response.status).toEqual(200);
      });

      it("should serve HTML when accessed with trailing slash and query string", async () => {
        const response = await request(app).get(
          `${SWAGGER_RELATIVE_URL}/?urls.primaryName=v2`,
        );
        expect(response.status).toEqual(200);
      });
    });

    describe("custom swagger options", () => {
      const CUSTOM_CSS = "body { background-color: hotpink !important }";
      const CUSTOM_JS = "/foo.js";
      const CUSTOM_JS_STR = 'console.log("foo")';
      const CUSTOM_FAVICON = "/foo.ico";
      const CUSTOM_SITE_TITLE = "Foo";
      const CUSTOM_CSS_URL = "/foo.css";

      beforeEach(async () => {
        const swaggerDocument = SwaggerModule.createDocument(
          app,
          builder.build(),
        );

        SwaggerModule.setup("/custom-docs", app, swaggerDocument, {
          customCss: CUSTOM_CSS,
          customJs: CUSTOM_JS,
          customJsStr: CUSTOM_JS_STR,
          customfavIcon: CUSTOM_FAVICON,
          customSiteTitle: CUSTOM_SITE_TITLE,
          customCssUrl: CUSTOM_CSS_URL,
          patchDocumentOnRequest(req, _res, document) {
            return {
              ...document,
              info: {
                ...document.info,
                description: readQueryParam(req, "description"),
              },
            };
          },
        });

        await app.init();
      });

      it("should contain the custom css string", async () => {
        const response = await request(app).get("/custom-docs");
        expect(response.text).toContain(CUSTOM_CSS);
      });

      it("should source the custom js url", async () => {
        const response = await request(app).get("/custom-docs");
        expect(response.text).toContain(`<script src="${CUSTOM_JS}"></script>`);
      });

      it("should contain the custom js string", async () => {
        const response = await request(app).get("/custom-docs");
        expect(response.text).toContain(CUSTOM_JS_STR);
      });

      it("should contain the custom favicon", async () => {
        const response = await request(app).get("/custom-docs");
        expect(response.text).toContain(
          `<link rel="icon" href="${CUSTOM_FAVICON}" />`,
        );
      });

      it("should contain the custom site title", async () => {
        const response = await request(app).get("/custom-docs");
        expect(response.text).toContain(`<title>${CUSTOM_SITE_TITLE}</title>`);
      });

      it("should include the custom stylesheet", async () => {
        const response = await request(app).get("/custom-docs");
        expect(response.text).toContain(
          `<link rel="stylesheet" href="${CUSTOM_CSS_URL}" />`,
        );
      });

      it("should patch the OpenAPI document", async () => {
        const response = await request(app).get(
          "/custom-docs?description=Custom%20Swagger%20description%20passed%20by%20query%20param",
        );
        expect(response.text).toContain(
          '"description":"Custom Swagger description passed by query param"',
        );
      });

      it("should patch the OpenAPI document based on path param of the swagger prefix", async () => {
        const paramApp = await BunestFactory.create(ApplicationModule, {
          logger: false,
        });
        try {
          const swaggerDocument = SwaggerModule.createDocument(
            paramApp,
            builder.build(),
          );

          SwaggerModule.setup("/:customer", paramApp, swaggerDocument, {
            patchDocumentOnRequest(req, _res, document) {
              const pathname = new URL((req as Request).url).pathname;
              const customer = pathname.split("/").filter(Boolean)[0];
              return {
                ...document,
                info: {
                  ...document.info,
                  description: `${customer}'s API documentation`,
                },
              };
            },
          });

          await paramApp.init();
          const response = await request(paramApp).get("/customer-1");
          expect(response.status).toBe(200);
          expect(response.text).toContain("customer-1's API documentation");
        } finally {
          await paramApp.close();
        }
      });

      it("should not serve the document of another path param value below the swagger prefix", async () => {
        const paramApp = await BunestFactory.create(ApplicationModule, {
          logger: false,
        });
        try {
          const swaggerDocument = SwaggerModule.createDocument(
            paramApp,
            builder.build(),
          );

          SwaggerModule.setup("/docs/:customer", paramApp, swaggerDocument, {
            patchDocumentOnRequest(req, _res, document) {
              const segments = new URL((req as Request).url).pathname
                .split("/")
                .filter(Boolean);
              const customer = segments[1];
              return {
                ...document,
                info: {
                  ...document.info,
                  description: `${customer}'s API documentation`,
                },
              };
            },
          });

          await paramApp.init();
          const ownResponse = await request(paramApp).get("/docs/customer-1");
          const otherResponse = await request(paramApp).get(
            "/docs/customer-1/customer-2",
          );
          expect(ownResponse.status).toBe(200);
          expect(ownResponse.text).toContain("customer-1's API documentation");
          expect(otherResponse.status).toEqual(404);
        } finally {
          await paramApp.close();
        }
      });
    });
  },
);
