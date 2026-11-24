import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  ensureDir,
  join,
  removePath,
} from "../../../../../packages/core/src";
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
      directory = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `nestjs-graphql-types-${crypto.randomUUID()}`,
      );
      await ensureDir(directory);
    });

    afterEach(async () => {
      await removePath(directory, { force: true, recursive: true });
    });

    it("loads type definitions from glob patterns", async () => {
      await Bun.write(
        join(directory, "cat.graphql"),
        "type Cat { id: ID!, name: String! }",
      );
      await Bun.write(
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
