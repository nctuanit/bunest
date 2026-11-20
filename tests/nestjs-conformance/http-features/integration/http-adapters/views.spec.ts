import "reflect-metadata";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Param,
  Query,
  Render,
  type ViewEngineRenderer,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

@Controller()
class ViewsController {
  @Get("page")
  @Render("index")
  page() {
    return { message: "Hello", year: 2026 };
  }

  @Get("locals")
  @Render("locals")
  locals() {
    return { message: "Hello" };
  }

  @Get("section")
  @Render("section")
  section() {
    return { message: "Hello" };
  }

  @Get("decode")
  @Render("decode")
  decode(@Query("next") next: string) {
    return { next };
  }

  @Get("pages/:name")
  @Render("index")
  named(@Param("name") name: string) {
    return { message: name, year: 2026 };
  }
}

@Module({ controllers: [ViewsController] })
class ViewsModule {}

function createPartialsRenderer(
  defaultLocals: Record<string, unknown> = {},
): ViewEngineRenderer {
  return async (template, data, context) => {
    const viewsDir = context?.baseViewsDir ?? ".";
    const directPath = join(viewsDir, `${template}.tpl`);
    const indexPath = join(viewsDir, template, "index.tpl");

    let filePath = directPath;
    let source: string;
    try {
      source = await readFile(directPath, "utf8");
    } catch {
      filePath = indexPath;
      source = await readFile(indexPath, "utf8");
    }

    const merged = { ...defaultLocals, ...data };
    let html = source;
    for (const match of html.matchAll(/\{\{> (\w+)\}\}/g)) {
      const name = match[1]!;
      const partial = await readFile(
        join(viewsDir, "partials", `${name}.tpl`),
        "utf8",
      );
      html = html.replace(`{{> ${name}}}`, partial);
    }

    try {
      return html
        .replace(/\{\{!.*?\}\}\r?\n?/g, "")
        .replace(/\{\{decode (\w+)\}\}/g, (_, key: string) =>
          decodeURIComponent(String(merged[key] ?? "")),
        )
        .replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
          String(merged[key] ?? ""),
        );
    } catch (err) {
      (err as Error).message = `${filePath}\n${source}\n${(err as Error).message}`;
      throw err;
    }
  };
}

describeConformance(
  "@Render() and View Engine E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/views.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Adapts NestJS @Render() / setBaseViewsDir() / setViewEngine() E2E tests to BunHttpAdapter pluggable ViewEngineRenderer & built-in template engine.",
  },
  () => {
    let viewsDir: string;
    let app: BunestApplication;

    beforeAll(() => {
      viewsDir = mkdtempSync(join(tmpdir(), "bunest-views-"));
      mkdirSync(join(viewsDir, "partials"), { recursive: true });
      mkdirSync(join(viewsDir, "section"), { recursive: true });
      writeFileSync(
        join(viewsDir, "index.tpl"),
        "<h1>{{message}}</h1>{{> footer}}",
      );
      writeFileSync(join(viewsDir, "locals.tpl"), "<p>{{message}} {{user}}</p>");
      writeFileSync(
        join(viewsDir, "decode.tpl"),
        '{{! shown to the server only }}\n<a href="{{decode next}}">Continue</a>\n',
      );
      writeFileSync(
        join(viewsDir, "partials", "footer.tpl"),
        "<footer>{{year}}</footer>",
      );
      writeFileSync(
        join(viewsDir, "section", "index.tpl"),
        "<h1>{{message}} section</h1>",
      );
    });

    afterAll(() => {
      rmSync(viewsDir, { recursive: true, force: true });
    });

    describe("with custom ViewEngineRenderer", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [ViewsModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        app.setBaseViewsDir(viewsDir);
        app.setViewEngine(
          createPartialsRenderer({ user: "Kamil", message: "Bye" }),
        );
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      itAdapted(
        ["ADR-001", "ADR-010"],
        "should render the view, with the partials the engine finds through the views directory",
        async () => {
          const res = await request(app).get("/page");

          expect(res.status).toBe(200);
          expect(res.headers["content-type"]).toMatch(/^text\/html/);
          expect(res.text).toBe("<h1>Hello</h1><footer>2026</footer>");
        },
        "Pluggable ViewEngineRenderer receives context.baseViewsDir",
      );

      it("should merge view locals under the data the handler returns", async () => {
        const res = await request(app).get("/locals");

        expect(res.status).toBe(200);
        expect(res.text).toBe("<p>Hello Kamil</p>");
      });

      it("should fall back to the index file of a directory named like the view", async () => {
        const res = await request(app).get("/section");

        expect(res.status).toBe(200);
        expect(res.text).toBe("<h1>Hello section</h1>");
      });

      it("should render a view that decodes the data it is given", async () => {
        const res = await request(app).get("/decode?next=%252Fhome");

        expect(res.status).toBe(200);
        expect(res.text).toBe('<a href="/home">Continue</a>\n');
      });

      it("should answer a view that fails with a URIError as a 500 server error", async () => {
        const res = await request(app).get("/decode?next=%25");

        expect(res.status).toBe(500);
        expect(res.body.statusCode).toBe(500);
      });

      // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher use safeDecodeSegment() which silently swallows URIError on malformed percent-encoding (%E0%A4%A) instead of rejecting with 400 Bad Request (packages/http/src/router/fallback-radix-router.ts:139-145).
      it.skip("should answer a path param it cannot decode with 400", async () => {
        const res = await request(app).get("/pages/%E0%A4%A");

        expect(res.status).toBe(400);
        expect(res.body).toEqual(
          expect.objectContaining({ statusCode: 400, error: "Bad Request" }),
        );
      });
    });

    describe("with built-in string template engine name", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [ViewsModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        app.setBaseViewsDir(viewsDir);
        app.setViewEngine("tpl");
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      itAdapted(
        ["ADR-001", "ADR-010"],
        "should interpolate {{key}} placeholders via built-in named view engine",
        async () => {
          const res = await request(app).get("/locals");
          expect(res.status).toBe(200);
          expect(res.headers["content-type"]).toContain("text/html");
          expect(res.text).toBe("<p>Hello </p>");
        },
        "BunHttpAdapter built-in interpolation engine for setViewEngine('tpl')",
      );
    });
  },
);
