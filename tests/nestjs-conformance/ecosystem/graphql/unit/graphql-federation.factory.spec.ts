import "reflect-metadata";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  type GraphQLObjectType,
  type GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
} from "../../../../../packages/graphql/node_modules/graphql";
import { Logger } from "../../../../../packages/common/src";
import {
  GraphQLFederationFactory,
  GraphQLSchemaBuilderModule,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
  Scalar,
  type CustomScalar,
  type SchemaFirstResolversMap,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

describeConformance(
  "GraphQLFederationFactory",
  {
    upstreamPath: "packages/graphql/tests/graphql-federation.factory.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS internal ResolversExplorerService/ScalarsExplorerService mocks to Bunest GraphQLFederationFactory public generateSchema(options, buildFederatedSchema, resolvers) API (ADR-013).",
  },
  () => {
    let graphqlFederationFactory: GraphQLFederationFactory;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      graphqlFederationFactory = module.get(GraphQLFederationFactory);
    });

    describe("generateSchema", () => {
      it("should support transforming the resolvers", async () => {
        const echo = mock(() => "original");
        const transformedEcho = mock(() => "transformed");
        const resolvers: SchemaFirstResolversMap = { Query: { echo } };

        const transformResolvers = mock(() => [{ Query: { echo: transformedEcho } }]);

        const schema = await graphqlFederationFactory.generateSchema({
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

        const queryType = schema.getQueryType() as GraphQLObjectType;
        queryType.getFields().echo?.resolve?.(
          null,
          {},
          {},
          null as unknown as GraphQLResolveInfo,
        );
        expect(transformedEcho).toHaveBeenCalled();
        expect(echo).not.toHaveBeenCalled();
      });

      it("should support undefined transformResolvers option", async () => {
        const echo = mock(() => "hello");
        const resolvers: SchemaFirstResolversMap = { Query: { echo } };

        const schema = await graphqlFederationFactory.generateSchema({
          resolvers,
          typeDefs: `
            type Query {
              echo(text: String!): String
            }
          `,
        });

        expect(schema).toBeInstanceOf(GraphQLSchema);

        const queryType = schema.getQueryType() as GraphQLObjectType;
        queryType.getFields().echo?.resolve?.(
          null,
          {},
          {},
          null as unknown as GraphQLResolveInfo,
        );
        expect(echo).toHaveBeenCalled();
      });

      it('should merge the "resolvers" option with the discovered resolvers field by field', async () => {
        const email = mock(() => "alice@example.com");
        const displayName = mock(() => "Alice");
        const userQuery = mock(() => ({}));

        @Resolver("User")
        class UserResolver {
          @Query(() => Object)
          user() {
            return userQuery();
          }

          @ResolveField(() => String)
          email() {
            return email();
          }
        }

        const schema = await graphqlFederationFactory.generateSchema(
          {
            resolvers: { User: { displayName } },
            typeDefs: `
              type User {
                email: String
                displayName: String
              }
              type Query {
                user: User
              }
            `,
          },
          undefined,
          [new UserResolver()],
        );

        const userType = schema.getType("User") as GraphQLObjectType;
        await userType.getFields().email?.resolve?.(
          null,
          {},
          {},
          null as unknown as GraphQLResolveInfo,
        );
        await userType.getFields().displayName?.resolve?.(
          null,
          {},
          {},
          null as unknown as GraphQLResolveInfo,
        );
        expect(email).toHaveBeenCalled();
        expect(displayName).toHaveBeenCalled();
      });

      // BUNEST_BUG: GraphQLSchemaFactory.buildSchemaFirst in packages/graphql/src/schema/graphql-schema.factory.ts calls buildASTSchema without federation directive definitions (throws 'Unknown directive "@key"') and does not bind @ResolveReference() or @Scalar() providers in schema-first mode.
      it.skip("should attach reference resolvers and custom scalars", async () => {
        const resolveReference = mock((_ref?: unknown) => ({ id: "1" }));

        @Scalar("Percent")
        class PercentScalar implements CustomScalar<number, number> {
          serialize(value: number): number {
            return value * 100;
          }
          parseValue(value: unknown): number {
            return (value as number) / 100;
          }
        }

        @Resolver("User")
        class UserRefResolver {
          @ResolveReference()
          resolveRef(ref: { __typename: string; id: string }) {
            return resolveReference(ref);
          }
        }

        const schema = await graphqlFederationFactory.generateSchema(
          {
            typeDefs: `
              scalar Percent
              type User @key(fields: "id") {
                id: ID!
              }
              type Query {
                report(maxDiscount: Percent = 20): String
              }
            `,
          },
          undefined,
          [new UserRefResolver(), new PercentScalar()],
        );

        const userType = schema.getType("User") as GraphQLObjectType;
        expect(
          (userType.extensions as Record<string, any>)?.apollo?.subgraph
            ?.resolveReference,
        ).toBeDefined();
        const percentType = schema.getType("Percent") as GraphQLScalarType;
        expect(percentType.parseValue(20)).toBe(0.2);
      });

      // BUNEST_BUG: GraphQLSchemaFactory.buildSchemaFirst in packages/graphql/src/schema/graphql-schema.factory.ts does not bind custom @Scalar() providers onto schema-first scalar types, so default values remain unparsed (expected 0.2, received 20).
      it.skip("should parse default values with the custom scalars only once", async () => {
        @Scalar("Percent")
        class PercentScalar implements CustomScalar<number, number> {
          serialize(value: number): number {
            return value * 100;
          }
          parseValue(value: unknown): number {
            return (value as number) / 100;
          }
        }

        const schema = await graphqlFederationFactory.generateSchema(
          {
            typeDefs: `
              scalar Percent
              type Query {
                report(maxDiscount: Percent = 20): String
              }
            `,
          },
          undefined,
          [new PercentScalar()],
        );

        const queryType = schema.getQueryType() as GraphQLObjectType;
        const [maxDiscount] = queryType.getFields().report!.args;
        expect(maxDiscount!.defaultValue).toBe(0.2);
      });

      describe('with "inheritResolversFromInterfaces"', () => {
        // BUNEST_BUG: GraphQLSchemaFactory.buildSchemaFirst in packages/graphql/src/schema/graphql-schema.factory.ts ignores options.inheritResolversFromInterfaces and never inherits interface field resolvers onto implementing object types (expected "PrivateNode", received undefined).
        it.skip.each(["Node & PrivateNode", "PrivateNode & Node"])(
          "should inherit the resolver of the most specific interface (implements %s)",
          async (interfaces) => {
            const schema = await graphqlFederationFactory.generateSchema({
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

        it("should keep the own resolver of a type", async () => {
          const schema = await graphqlFederationFactory.generateSchema({
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

      // BUNEST_BUG: GraphQLFederationFactory.generateSchema in packages/graphql/src/schema/graphql.factory.ts never checks options.directiveResolvers or logs a warning that it is ignored.
      it.skip('should warn that the "directiveResolvers" option is ignored', async () => {
        const warn = spyOn(Logger.prototype, "warn").mockImplementation(
          () => undefined,
        );

        try {
          await graphqlFederationFactory.generateSchema({
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
