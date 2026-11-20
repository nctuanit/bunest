import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  renderSwaggerHtml,
  type OpenAPIObject,
} from "../../../../../../packages/swagger/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

function createBaseDocument(
  overrides: Partial<OpenAPIObject> = {},
): OpenAPIObject {
  return {
    openapi: "3.1.0",
    info: { title: "Test", version: "1.0.0" },
    paths: {},
    ...overrides,
  };
}

describeConformance(
  "renderSwaggerHtml (Swagger UI)",
  {
    upstreamPath: "test/swagger-ui/swagger-ui.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream swagger-ui-dist buildSwaggerHTML/buildSwaggerInitJS tests to Bunest's zero-CDN renderSwaggerHtml() (ADR-001, ADR-013), preserving verbatim $ replacement-pattern safety and query-string URL injection protection.",
  },
  () => {
    describe("buildSwaggerHTML (renderSwaggerHtml)", () => {
      it("inserts the custom site title verbatim", () => {
        const html = renderSwaggerHtml(createBaseDocument(), "/docs-json", {
          customSiteTitle: "My API Docs",
        });

        expect(html).toContain("<title>My API Docs</title>");
      });

      itAdapted(
        "ADR-001",
        'preserves "$" replacement-pattern characters in customSiteTitle',
        () => {
          const title = "Cost $$ & $& Dashboard $1";
          const html = renderSwaggerHtml(createBaseDocument(), "/docs-json", {
            customSiteTitle: title,
          });

          // Bunest HTML-escapes `&` to `&amp;` for XSS safety while preserving `$` patterns verbatim
          expect(html).toContain("<title>Cost $$ &amp; $&amp; Dashboard $1</title>");
        },
        "Bunest escapeHtml escapes `&` to `&amp;` while preserving `$$`, `$&`, `$1` verbatim",
      );

      it('preserves "$" replacement-pattern characters in customCss', () => {
        const css = '.price::after { content: "$$$ $& $1 $`" }';
        const html = renderSwaggerHtml(createBaseDocument(), "/docs-json", {
          customCss: css,
        });

        expect(html).toContain(css);
      });

      it('preserves "$" replacement-pattern characters in inline customJsStr', () => {
        const js = 'console.log("$$ $& $\' total")';
        const html = renderSwaggerHtml(createBaseDocument(), "/docs-json", {
          customJsStr: js,
        });

        expect(html).toContain(`<script>${js}</script>`);
      });

      itAdapted(
        "ADR-001",
        'preserves "$" replacement-pattern characters in customfavIcon url',
        () => {
          const favIcon = "https://example.com/icon.png?v=$$$&a=$1";
          const html = renderSwaggerHtml(createBaseDocument(), "/docs-json", {
            customfavIcon: favIcon,
          });

          // Bunest renders double-quoted HTML attributes and escapes `&` to `&amp;`
          expect(html).toContain(
            '<link rel="icon" href="https://example.com/icon.png?v=$$$&amp;a=$1" />',
          );
        },
        "Bunest renders double-quoted `<link rel=\"icon\" href=\"...\" />` with HTML-escaped `&amp;`",
      );
    });

    describe("buildSwaggerInitJS (embedded spec & swagger-ui preset)", () => {
      it('inserts OpenAPI descriptions with "$" replacement-pattern characters verbatim', () => {
        const description = "Must match `^[a-z][a-z0-9_]{1,63}$` plus $& $' $1 $$";
        const swaggerDoc: OpenAPIObject = {
          openapi: "3.0.0",
          info: { title: "Test", version: "1.0.0" },
          paths: {
            "/pets": {
              get: {
                responses: {
                  "200": {
                    description,
                  },
                },
              },
            },
          },
        };

        const html = renderSwaggerHtml(swaggerDoc, "/docs-json", {
          ui: "swagger-ui",
        });

        const match =
          /<script id="bunest-openapi-spec" type="application\/json">([\s\S]*?)<\/script>/.exec(
            html,
          );
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match![1]!) as OpenAPIObject;
        expect(parsed.paths["/pets"]?.get?.responses["200"]?.description).toBe(
          description,
        );
      });

      itAdapted(
        "ADR-001",
        "does not take the definition url from the query string of the page",
        () => {
          const html = renderSwaggerHtml(
            createBaseDocument(),
            "https://api.example.com/docs-json",
            { ui: "swagger-ui" },
          );

          // The swagger-ui preset embeds the server-configured URL directly and
          // never reads `window.location.search` or `?url=` query parameters.
          expect(html).toContain('url: "https://api.example.com/docs-json"');
          expect(html).not.toContain("location.search");
          expect(html).not.toContain("URLSearchParams");
        },
        "Verified statically against renderSwaggerHtml({ ui: 'swagger-ui' }) output",
      );
    });
  },
);
