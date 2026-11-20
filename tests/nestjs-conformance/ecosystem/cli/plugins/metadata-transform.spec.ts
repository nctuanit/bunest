import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bunestMetadataPlugin,
  generateMetadataFile,
  transformControllerMetadataSource,
  transformDtoMetadataSource,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "Metadata Printer & Source Transforms",
  {
    upstreamPath:
      "nest-cli/test/lib/compiler/plugins/plugin-metadata-printer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS PluginMetadataPrinter specs to Bunest's `generateMetadataFile`, `transformDtoMetadataSource`, `transformControllerMetadataSource`, and `bunestMetadataPlugin`.",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-metaprint-"));
      mkdirSync(join(tmpDir, "src"), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("metadata.ts printing semantics", () => {
      it("writes the default metadata.ts file with eslint-disable header and async default export", async () => {
        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        expect(res.outputPath).toBe(join(tmpDir, "src", "metadata.ts"));
        const onDisk = readFileSync(res.outputPath, "utf8");
        expect(onDisk.startsWith("/* eslint-disable */")).toBe(true);
        expect(onDisk).toContain("export default async () => {");
        expect(onDisk).toContain('"@nestjs/swagger"');
        expect(onDisk).toContain("models:");
        expect(onDisk).toContain("controllers:");
      });

      // BUNEST_BUG: BunestMetadataPluginOptions lacks a `filename` option and generateMetadataFile() hardcodes `join(outDir, "metadata.ts")` (packages/cli/src/plugins/metadata.plugin.ts:2053)
      it.skip("honours a custom filename option when writing static metadata", async () => {
        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
          ...({ filename: "custom.ts" } as Record<string, unknown>),
        });
        expect(res.outputPath).toBe(join(tmpDir, "src", "custom.ts"));
      });

      it("propagates extracted models and controllers into the printed metadata tree", async () => {
        writeFileSync(
          join(tmpDir, "src", "foo.dto.ts"),
          `export class FooDto { bar!: string; }\n`,
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "src", "foo.controller.ts"),
          `export class FooController {\n  /** Get foo */\n  @Get()\n  foo(): string { return "foo"; }\n}\n`,
          "utf8",
        );

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        expect(res.code).toContain('"@nestjs/swagger"');
        expect(res.code).toContain('import("./foo.dto")');
        expect(res.code).toContain('"FooDto"');
        expect(res.code).toContain('"bar"');
        expect(res.code).toContain('import("./foo.controller")');
        expect(res.code).toContain('"FooController"');
        expect(res.code).toContain('"foo"');
      });

      it("overwrites metadata.ts when existing bytes on disk differ", async () => {
        const target = join(tmpDir, "src", "metadata.ts");
        writeFileSync(target, "/* stale */\n", "utf8");

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        const updated = readFileSync(res.outputPath, "utf8");
        expect(updated).not.toBe("/* stale */\n");
        expect(updated.startsWith("/* eslint-disable */")).toBe(true);
      });

      // BUNEST_BUG: generateMetadataFile() unconditionally calls `Bun.write(outputPath, code)` without comparing existing file bytes, causing unnecessary mtime churn in watch workflows (packages/cli/src/plugins/metadata.plugin.ts:2190)
      it.skip("skips writing metadata.ts when existing bytes on disk are identical", async () => {
        const first = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });
        const oldDate = new Date("2020-01-01T00:00:00.000Z");
        utimesSync(first.outputPath, oldDate, oldDate);
        const beforeMtime = statSync(first.outputPath).mtimeMs;

        await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        const afterMtime = statSync(first.outputPath).mtimeMs;
        expect(afterMtime).toBe(beforeMtime);
      });
    });

    describe("DTO & controller AST source transforms and Bun.build plugin", () => {
      itAdapted(
        ["ADR-001", "ADR-002"],
        "transforms DTO class-validator, class-transformer, parameterProperties, readonly, const enum, and GraphQL metadata",
        () => {
          const src = `
export const enum Status {
  OPEN = "open",
  CLOSED = "closed",
}

export class TicketDto {
  /** Ticket title */
  @Expose({ name: "ticket_title" })
  @IsNotEmpty()
  @MaxLength(100)
  readonly title!: string;

  @Exclude()
  internalHash!: string;

  @IsInt()
  @IsPositive()
  priority: number = 1;

  status!: Status;

  constructor(public readonly tenantId: string) {}
}
`;
          const res = transformDtoMetadataSource(src, "ticket.dto.ts", {
            swagger: true,
            graphql: true,
            classValidatorShim: true,
            classTransformerShim: true,
            parameterProperties: true,
            readonly: true,
          });

          expect(res.modified).toBe(true);
          const props = new Map(
            res.classes[0]!.properties.map((p) => [p.name, p]),
          );
          expect(props.has("internalHash")).toBe(false);
          expect(props.get("title")).toMatchObject({
            aliasName: "ticket_title",
            isReadonly: true,
            description: "Ticket title",
            constraints: { minLength: 1, maxLength: 100 },
          });
          expect(props.get("priority")).toMatchObject({
            defaultValue: 1,
            constraints: { typeOverride: '"integer"', minimum: 1 },
          });
          expect(props.get("status")?.enumLiterals).toEqual(["open", "closed"]);
          expect(props.get("tenantId")?.isReadonly).toBe(true);
          expect(res.code).toContain(
            'Symbol.for("bunest:swagger:api_properties")',
          );
          expect(res.code).toContain('Symbol.for("bunest:graphql:fields")');

          // Exclusive classTransformerShim includes ONLY @Expose() properties
          const excl = transformDtoMetadataSource(src, "ticket.dto.ts", {
            classTransformerShim: "exclusive",
          });
          expect(excl.classes[0]?.properties.map((p) => p.name)).toEqual([
            "title",
          ]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        "transforms controller methods respecting @HttpCode, skipAutoHttpCode, and custom controllerKeyOfComment",
        () => {
          const src = `
export class OrdersController {
  /** Create order */
  @Post()
  create(): string { return "ok"; }

  /** Delete order */
  @Delete()
  @HttpCode(204)
  remove(): void {}
}
`;
          const res = transformControllerMetadataSource(
            src,
            "orders.controller.ts",
            { controllerKeyOfComment: "description" },
          );
          expect(res.modified).toBe(true);
          expect(res.controllers[0]?.methods).toEqual([
            {
              name: "create",
              httpMethod: "POST",
              status: 201,
              summary: "Create order",
              returnTypeExpr: "String",
              isArray: false,
            },
            {
              name: "remove",
              httpMethod: "DELETE",
              status: 204,
              summary: "Delete order",
              returnTypeExpr: undefined,
              isArray: false,
            },
          ]);
          expect(res.code).toContain('"description": "Create order"');

          const skipped = transformControllerMetadataSource(
            src,
            "orders.controller.ts",
            { skipAutoHttpCode: true },
          );
          expect(skipped.controllers[0]?.methods[0]?.status).toBeUndefined();
          expect(skipped.controllers[0]?.methods[1]?.status).toBe(204);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        "integrates with Bun.build({ plugins: [bunestMetadataPlugin()] }) to register runtime Reflect metadata",
        async () => {
          writeFileSync(
            join(tmpDir, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                experimentalDecorators: true,
                emitDecoratorMetadata: true,
              },
            }),
            "utf8",
          );
          writeFileSync(
            join(tmpDir, "src", "note.dto.ts"),
            `export class NoteDto {\n  /** Note body */\n  body!: string;\n}\n`,
            "utf8",
          );

          const buildOut = await Bun.build({
            entrypoints: [join(tmpDir, "src", "note.dto.ts")],
            outdir: join(tmpDir, "dist"),
            target: "bun",
            format: "esm",
            plugins: [bunestMetadataPlugin({ swagger: true })],
          });
          expect(buildOut.success).toBe(true);

          const built = (await import(
            `${pathToFileURL(buildOut.outputs[0]!.path).href}?t=${Date.now()}`
          )) as { NoteDto: Function };
          const props = Reflect.getOwnMetadata(
            Symbol.for("bunest:swagger:api_properties"),
            built.NoteDto,
          ) as Array<Record<string, unknown>>;
          expect(props).toEqual([
            {
              propertyKey: "body",
              type: String,
              required: true,
              description: "Note body",
            },
          ]);
        },
      );
    });
  },
);
