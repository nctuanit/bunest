import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { parse } from "../../../../../packages/graphql/node_modules/graphql";
import { GraphQLAstExplorer } from "../../../../../packages/graphql/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "GraphQLAstExplorer",
  {
    upstreamPath: "packages/graphql/tests/graphql-ast.explorer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts graphql-tag `gql` to graphql `parse()` and ts-morph SourceFile AST checks to Bunest zero-dep GeneratedSourceFile text output (ADR-013).",
  },
  () => {
    describe("explore", () => {
      // BUNEST_BUG: GraphQLAstExplorer.toObjectTypeDefinitionStructure in packages/graphql/src/schema/graphql-ast.explorer.ts emits non-root object fields with arguments as methods ("weight(unit: string): number | Promise<number>;") instead of required properties ("weight: number;") because line 212 checks (isRootType || hasArgs).
      it.skip("should mark non-nullable fields with arguments as required", async () => {
        const astExplorer = new GraphQLAstExplorer();

        const document = parse(`
          type Cat {
            id: Int!
            name: String!
            weight(unit: String!): Int!
          }

          type Query {
            cat(id: ID!): Cat
          }
        `);

        const sourceFile = await astExplorer.explore(
          document,
          "/dev/null",
          "interface",
          {},
        );

        const text = sourceFile.getFullText();
        const catMatch = /export interface Cat \{([\s\S]*?)\}/.exec(text);
        expect(catMatch).not.toBeNull();
        // In NestJS, non-root object fields with arguments emit a required property `weight: number;`
        expect(catMatch![1]).toMatch(/\bweight:\s*number;/);
        expect(catMatch![1]).not.toMatch(/\bweight\?:/);
      });

      it("should keep root resolver fields required when skipResolverArgs is true", async () => {
        const astExplorer = new GraphQLAstExplorer();

        const document = parse(`
          type User {
            id: ID!
            email: String!
          }

          type Mutation {
            signIn(login: String!, password: String!): User!
            signUp: User!
          }
        `);

        const sourceFile = await astExplorer.explore(
          document,
          "/dev/null",
          "interface",
          { skipResolverArgs: true },
        );

        const text = sourceFile.getFullText();
        const mutationMatch = /export interface IMutation \{([\s\S]*?)\}/.exec(
          text,
        );
        expect(mutationMatch).not.toBeNull();
        expect(mutationMatch![1]).toMatch(/\bsignIn:\s*User;/);
        expect(mutationMatch![1]).not.toMatch(/\bsignIn\?:/);
        expect(mutationMatch![1]).toMatch(/\bsignUp:\s*User;/);
        expect(mutationMatch![1]).not.toMatch(/\bsignUp\?:/);
      });

      it("should not emit descriptions as TSDoc comments by default", async () => {
        const astExplorer = new GraphQLAstExplorer();

        const document = parse(`
          """
          A feline animal.
          """
          type Cat {
            """
            The name of the cat.
            """
            name: String!
          }
        `);

        const sourceFile = await astExplorer.explore(
          document,
          "/dev/null",
          "interface",
          {},
        );

        expect(sourceFile.getFullText()).not.toContain("A feline animal.");
        expect(sourceFile.getFullText()).not.toContain("The name of the cat.");
      });

      // BUNEST_BUG: GraphQLAstExplorer.toEnumDefinitionStructure in packages/graphql/src/schema/graphql-ast.explorer.ts ignores emitDescriptions and never emits TSDoc comments for enum types or enum values (missing "/** The available colors. */" and "/** The color red. */").
      it.skip('should emit descriptions as TSDoc comments when "emitDescriptions" is enabled', async () => {
        const astExplorer = new GraphQLAstExplorer();

        const document = parse(`
          """
          A feline animal.
          """
          type Cat {
            """
            The name of the cat.
            """
            name: String!
          }

          """
          The available colors.
          """
          enum Color {
            """
            The color red.
            """
            RED
          }
        `);

        const sourceFile = await astExplorer.explore(
          document,
          "/dev/null",
          "interface",
          { emitDescriptions: true },
        );
        const text = sourceFile.getFullText();

        expect(text).toContain("/** A feline animal. */");
        expect(text).toContain("/** The name of the cat. */");
        expect(text).toContain("/** The available colors. */");
        expect(text).toContain("/** The color red. */");
      });

      it("should escape comment terminators in emitted descriptions", async () => {
        const astExplorer = new GraphQLAstExplorer();

        const document = parse(`
          type Query {
            """
            Runs on the cron schedule */5 * * * *.
            """
            jobs: [String!]!
          }
        `);

        const sourceFile = await astExplorer.explore(
          document,
          "/dev/null",
          "interface",
          { emitDescriptions: true },
        );
        const text = sourceFile.getFullText();

        // Verify valid TypeScript syntax with Bun's native transpiler
        const transpiler = new Bun.Transpiler({ loader: "ts" });
        expect(() => transpiler.transformSync(text)).not.toThrow();
        expect(text).toContain(
          "/** Runs on the cron schedule *\\/5 * * * *. */",
        );
      });

      // BUNEST_BUG: GraphQLAstExplorer.toObjectTypeDefinitionStructure in packages/graphql/src/schema/graphql-ast.explorer.ts skips __typename on root object types because line 202 guards with "&& !isRootType" (IQuery missing "__typename?: 'Query';").
      it.skip('should emit the GraphQL type name as the "__typename" value', async () => {
        const astExplorer = new GraphQLAstExplorer();

        const document = parse(`
          type Cat {
            id: Int!
          }

          type Query {
            cat: Cat
          }
        `);

        const sourceFile = await astExplorer.explore(
          document,
          "/dev/null",
          "interface",
          {
            emitTypenameField: true,
            typeName: (name: string) => `${name}Schema`,
          },
        );

        const text = sourceFile.getFullText();
        const catSchemaMatch = /export interface CatSchema \{([\s\S]*?)\}/.exec(
          text,
        );
        const queryMatch = /export interface IQuery \{([\s\S]*?)\}/.exec(text);

        expect(catSchemaMatch).not.toBeNull();
        expect(catSchemaMatch![1]).toContain("__typename?: 'Cat';");
        expect(queryMatch).not.toBeNull();
        expect(queryMatch![1]).toContain("__typename?: 'Query';");
      });
    });
  },
);
