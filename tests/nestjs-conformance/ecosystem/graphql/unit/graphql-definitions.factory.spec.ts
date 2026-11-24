import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  ensureDir,
  join,
  removePath,
} from "../../../../../packages/core/src";
import { GraphQLDefinitionsFactory } from "../../../../../packages/graphql/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "GraphQLDefinitionsFactory",
  {
    upstreamPath: "packages/graphql/tests/graphql-definitions.factory.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream chokidar mock watch test to Bunest zero-dependency GraphQLDefinitionsFactory (ADR-013).",
  },
  () => {
    let directory: string;

    beforeEach(async () => {
      directory = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `nestjs-graphql-definitions-${crypto.randomUUID()}`,
      );
      await ensureDir(directory);
    });

    afterEach(async () => {
      await removePath(directory, { force: true, recursive: true });
    });

    it("generates class definitions from type path glob patterns", async () => {
      await Bun.write(
        join(directory, "schema.graphql"),
        "type Query { ok: Boolean }",
      );

      const outputPath = join(directory, "graphql.ts");
      const factory = new GraphQLDefinitionsFactory();
      await factory.generate({
        typePaths: [join(directory, "*.graphql")],
        path: outputPath,
        outputAs: "class",
        watch: false,
        debug: false,
      });

      const generated = await Bun.file(outputPath).text();
      expect(generated).toContain("export abstract class IQuery");
      expect(generated).toContain("ok");
    });

    it("watches files resolved from type path glob patterns", async () => {
      const schemaPath = join(directory, "schema.graphql");
      const outputPath = join(directory, "graphql.ts");
      await Bun.write(schemaPath, "type Query { ok: Boolean }");

      const factory = new GraphQLDefinitionsFactory();
      await factory.generate({
        typePaths: [join(directory, "*.graphql")],
        path: outputPath,
        outputAs: "class",
        watch: true,
        debug: false,
      });

      await Bun.write(
        schemaPath,
        "type Query { ok: Boolean, updated: String }",
      );
      await Bun.sleep(150);

      const regenerated = await Bun.file(outputPath).text();
      expect(regenerated).toContain("updated");
    });
  },
);
