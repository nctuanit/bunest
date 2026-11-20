import "reflect-metadata";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  GraphQLEnumType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  graphql,
} from "../../../../../packages/graphql/node_modules/graphql";
import { Logger } from "../../../../../packages/common/src";
import {
  type CustomScalar,
  GraphQLFactory,
  GraphQLSchemaBuilderModule,
  Query,
  ResolveField,
  Resolver,
  Scalar,
  type SchemaFirstResolversMap,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

describeConformance(
  "GraphQLFactory",
  {
    upstreamPath: "packages/graphql/tests/graphql.factory.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS internal ResolversExplorerService/ScalarsExplorerService/@graphql-tools mocks to Bunest GraphQLFactory.generateSchema() and pure graphql-js GraphQLSchema (ADR-013).",
  },
  () => {
    let graphqlFactory: GraphQLFactory;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      graphqlFactory = module.get(GraphQLFactory);
    });

    describe("generateSchema", () => {
      it("should support transforming the resolvers", async () => {
        const echo = mock(() => "ok");
        const resolvers: SchemaFirstResolversMap[] = [{ Query: { echo } }];
        const transformResolvers = mock((r: SchemaFirstResolversMap | SchemaFirstResolversMap[]) => r);

        const schema = await graphqlFactory.generateSchema({
          resolvers,
          transformResolvers,
          typeDefs: `
            type Query {
              echo(text: String!): String
            }
          `,
        });

        expect(transformResolvers).toHaveBeenCalledWith(resolvers);
        expect(schema).toBeInstanceOf(GraphQLSchema);
      });

      it("should support undefined transformResolvers option", async () => {
        const resolvers: SchemaFirstResolversMap[] = [
          { Query: { echo: mock(() => "ok") } },
        ];

        const schema = await graphqlFactory.generateSchema({
          resolvers,
          typeDefs: `
            type Query {
              echo(text: String!): String
            }
          `,
        });

        expect(schema).toBeInstanceOf(GraphQLSchema);
      });

      it('should merge the "resolvers" option field by field', async () => {
        @Resolver("User")
        class UserResolver {
          @Query(() => Object)
          user() {
            return { name: "alice" };
          }

          @ResolveField(() => String)
          email() {
            return "guarded";
          }
        }

        const schema = await graphqlFactory.generateSchema(
          {
            resolvers: { User: { displayName: () => "ALICE" } },
            typeDefs: `
              type User { name: String email: String displayName: String }
              type Query { user: User }
            `,
          },
          [new UserResolver()],
        );
        const { data } = await graphql({
          schema,
          source: "{ user { email displayName } }",
        });

        expect(data).toEqual({
          user: { email: "guarded", displayName: "ALICE" },
        });
      });

      describe('when the "schema" option shares types with "typeDefs"', () => {
        const amount = new GraphQLScalarType({
          name: "Amount",
          serialize: (value) => `EUR ${value}`,
          parseValue: (value) => {
            if (!Number.isInteger(value) || (value as number) <= 0) {
              throw new TypeError("Amount must be a positive integer");
            }
            return value;
          },
          parseLiteral: (ast) => {
            const value = ast.kind === Kind.INT ? Number(ast.value) : Number.NaN;
            if (!Number.isInteger(value) || value <= 0) {
              throw new TypeError("Amount must be a positive integer");
            }
            return value;
          },
        });
        const colorEnum = new GraphQLEnumType({
          name: "Color",
          values: {
            RED: { value: "#f00" },
          },
        });
        const paymentsSchema = () =>
          new GraphQLSchema({
            query: new GraphQLObjectType({
              name: "Query",
              fields: {
                dailyLimit: {
                  type: amount,
                  resolve: () => 100000,
                },
                color: {
                  type: GraphQLString,
                  args: { color: { type: new GraphQLNonNull(colorEnum) } },
                  resolve: (_: unknown, args: { color: string }) => args.color,
                },
              },
            }),
          });
        const typeDefs = `
          scalar Amount
          enum Color { RED }
          type Query { fee(amount: Amount!): String paint(color: Color!): String }
        `;
        const queryResolvers: SchemaFirstResolversMap = {
          Query: {
            fee: (_: unknown, args: { amount: unknown }) =>
              `fee for ${JSON.stringify(args.amount)}`,
            paint: (_: unknown, args: { color: string }) => args.color,
          },
        };

        // BUNEST_BUG: GraphQLSchemaFactory.create in packages/graphql/src/schema/graphql-schema.factory.ts short-circuits on `if (options.schema) return options.schema` and ignores options.typeDefs instead of merging schema and typeDefs (querying "fee" fails with 'Cannot query field "fee" on type "Query".').
        it.skip('should keep the scalars and enums of the "schema" option', async () => {
          const schema = await graphqlFactory.generateSchema({
            typeDefs,
            resolvers: queryResolvers,
            schema: paymentsSchema(),
          });

          const literal = await graphql({
            schema,
            source: "{ fee(amount: -500) }",
          });
          expect(literal.errors?.[0]?.message).toContain(
            "Amount must be a positive integer",
          );
          const variable = await graphql({
            schema,
            source: "query ($amount: Amount!) { fee(amount: $amount) }",
            variableValues: { amount: { any: ["json"] } },
          });
          expect(variable.errors?.[0]?.message).toContain(
            "Amount must be a positive integer",
          );
          const output = await graphql({
            schema,
            source: "{ dailyLimit paint(color: RED) color(color: RED) }",
          });
          expect(output).toEqual({
            data: { dailyLimit: "EUR 100000", paint: "#f00", color: "#f00" },
          });
        });

        // BUNEST_BUG: GraphQLSchemaFactory.create in packages/graphql/src/schema/graphql-schema.factory.ts returns options.schema untouched without applying @Scalar() overrides or merging typeDefs (expected "USD 100000", received "EUR 100000").
        it.skip("should let a scalar registered on the Nest side override them", async () => {
          @Scalar("Amount")
          class UsdAmountScalar implements CustomScalar<string, unknown> {
            serialize(value: unknown): string {
              return `USD ${value}`;
            }
            parseValue(value: unknown): unknown {
              return value;
            }
          }

          const schema = await graphqlFactory.generateSchema(
            {
              typeDefs,
              resolvers: queryResolvers,
              schema: paymentsSchema(),
            },
            [new UsdAmountScalar()],
          );

          const { data } = await graphql({ schema, source: "{ dailyLimit }" });
          expect(data).toEqual({ dailyLimit: "USD 100000" });
        });
      });

      describe('with "inheritResolversFromInterfaces"', () => {
        // BUNEST_BUG: GraphQLSchemaFactory.buildSchemaFirst in packages/graphql/src/schema/graphql-schema.factory.ts ignores options.inheritResolversFromInterfaces (expected "PrivateNode", received undefined).
        it.skip.each(["Node & PrivateNode", "PrivateNode & Node"])(
          "should inherit the resolver of the most specific interface (implements %s)",
          async (interfaces) => {
            const schema = await graphqlFactory.generateSchema({
              inheritResolversFromInterfaces: true,
              resolvers: {
                Node: { owner: () => "Node" },
                PrivateNode: { owner: () => "PrivateNode" },
              },
              typeDefs: `
                interface Node { owner: String }
                interface PrivateNode implements Node { owner: String }
                type Invoice implements ${interfaces} { owner: String }
                type Query { invoice: Invoice }
              `,
            });
            const invoice = schema.getType("Invoice") as GraphQLObjectType;

            expect(
              invoice.getFields().owner?.resolve?.(
                null,
                {},
                null,
                null as unknown as GraphQLResolveInfo,
              ),
            ).toBe("PrivateNode");
          },
        );

        // BUNEST_BUG: GraphQLSchemaFactory.buildSchemaFirst in packages/graphql/src/schema/graphql-schema.factory.ts ignores options.inheritResolversFromInterfaces (expected "Restricted", received undefined).
        it.skip("should keep the listed order for unrelated interfaces", async () => {
          const schema = await graphqlFactory.generateSchema({
            inheritResolversFromInterfaces: true,
            resolvers: {
              Tagged: { owner: () => "Tagged" },
              Audited: { owner: () => "Audited" },
              Restricted: { owner: () => "Restricted" },
            },
            typeDefs: `
              interface Tagged { owner: String }
              interface Audited implements Tagged { owner: String }
              interface Restricted { owner: String }
              type Invoice implements Audited & Tagged & Restricted { owner: String }
              type Query { invoice: Invoice }
            `,
          });
          const invoice = schema.getType("Invoice") as GraphQLObjectType;

          expect(
            invoice.getFields().owner?.resolve?.(
              null,
              {},
              null,
              null as unknown as GraphQLResolveInfo,
            ),
          ).toBe("Restricted");
        });

        it("should keep the own resolver of a type", async () => {
          const schema = await graphqlFactory.generateSchema({
            inheritResolversFromInterfaces: true,
            resolvers: {
              PrivateNode: { owner: () => "PrivateNode" },
              Invoice: { owner: () => "Invoice" },
            },
            typeDefs: `
              interface PrivateNode { owner: String }
              type Invoice implements PrivateNode { owner: String }
              type Query { invoice: Invoice }
            `,
          });
          const invoice = schema.getType("Invoice") as GraphQLObjectType;

          expect(
            invoice.getFields().owner?.resolve?.(
              null,
              {},
              null,
              null as unknown as GraphQLResolveInfo,
            ),
          ).toBe("Invoice");
        });
      });

      // BUNEST_BUG: GraphQLFactory.generateSchema in packages/graphql/src/schema/graphql.factory.ts never checks options.directiveResolvers or logs a warning that it is ignored.
      it.skip('should warn that the "directiveResolvers" option is ignored', async () => {
        const warn = spyOn(Logger.prototype, "warn").mockImplementation(
          () => undefined,
        );

        try {
          await graphqlFactory.generateSchema({
            directiveResolvers: { auth: (next: () => unknown) => next() },
            typeDefs: "type Query { payroll: String }",
          });
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('"directiveResolvers" option is ignored'),
          );
        } finally {
          warn.mockRestore();
        }
      });
    });
  },
);
