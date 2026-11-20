import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphQLTypesLoader } from "../../../../../packages/graphql/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "GraphQLTypesLoader",
  {
    upstreamPath: "packages/graphql/tests/graphql-types.loader.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "nestjs-graphql-types-"));
    });

    afterEach(async () => {
      await rm(directory, { force: true, recursive: true });
    });

    it("loads type definitions from glob patterns", async () => {
      await writeFile(
        join(directory, "cat.graphql"),
        "type Cat { id: ID!, name: String! }",
      );
      await writeFile(
        join(directory, "query.graphql"),
        "type Query { cat: Cat }",
      );

      const loader = new GraphQLTypesLoader();
      const typeDefs = await loader.mergeTypesByPaths(
        join(directory, "*.graphql"),
      );

      expect(typeDefs).toContain("type Query");
      expect(typeDefs).toContain("type Cat");
    });
  },
);
