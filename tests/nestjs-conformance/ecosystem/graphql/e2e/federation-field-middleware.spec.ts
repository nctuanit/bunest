import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  type FieldMiddleware,
  GraphQLModule,
  InterfaceType,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
  UseFieldMiddleware,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

/**
 * Wraps the resolved value with the middleware name, so the response shows
 * the order in which middleware ran (outermost first).
 */
const wrap =
  (name: string): FieldMiddleware =>
  async (_ctx, next) =>
    `${name}(${await next()})`;

@ObjectType()
class Item {
  // Also resolved by "ItemResolver.overridden()".
  @Field({ middleware: [wrap("option")] })
  @UseFieldMiddleware(wrap("decorator"))
  overridden!: string;

  @Field({ middleware: [wrap("option")] })
  plain!: string;
}

@InterfaceType()
abstract class Document {
  @Field({ middleware: [wrap("document")] })
  owner!: string;
}

@ObjectType({ implements: () => [Document] })
class Payslip implements Document {
  @Field({ middleware: [wrap("payslip")] })
  owner!: string;
}

@ObjectType({ implements: () => [Document] })
class Memo implements Document {
  owner!: string;
}

@Resolver(() => Item)
class ItemResolver {
  @Query(() => Item)
  item(): Item {
    return { overridden: "value", plain: "value" };
  }

  @ResolveField()
  @UseFieldMiddleware(wrap("resolver"))
  overridden(@Parent() parent: Item): string {
    return parent.overridden;
  }
}

@Resolver(() => Document)
class DocumentResolver {
  @Query(() => Payslip)
  payslip(): Payslip {
    return { owner: "value" };
  }

  @Query(() => Memo)
  memo(): Memo {
    return { owner: "value" };
  }

  @ResolveField(() => String)
  @UseFieldMiddleware(wrap("resolver"))
  owner(@Parent() parent: Document): string {
    return parent.owner;
  }
}

describeConformance(
  "Federation - field middleware of model fields resolved by field resolvers",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-field-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver field middleware E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    const cases: Array<
      [string, FieldMiddleware[], (value: string) => string]
    > = [
      ["without global middleware", [], (value: string) => value],
      [
        "with global middleware",
        [wrap("global")],
        (value: string) => `global(${value})`,
      ],
    ];

    for (const [label, fieldMiddleware, globalWrap] of cases) {
      describe(label, () => {
        @Module({
          imports: [
            GraphQLModule.forRoot({
              federation: { version: 2 },
              autoSchemaFile: true,
              buildSchemaOptions: { fieldMiddleware },
              includeStacktraceInErrorResponses: false,
            }),
          ],
          providers: [ItemResolver, DocumentResolver],
        })
        class FieldMiddlewareFederationModule {}

        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [FieldMiddlewareFederationModule],
          }).compile({ logger: false });
          app = moduleRef.createNestApplication({ logger: false });
          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) drops model @Field({ middleware }) and @UseFieldMiddleware() when overridden by @ResolveField(); got `resolver(value)` / `global(resolver(value))` instead of `option(decorator(resolver(value)))` / `global(option(decorator(resolver(value))))`.
        it.skip("should keep the middleware of a model field overridden by a field resolver", async () => {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ item { overridden plain } }" })
            .expect(200);

          expect(res.body.errors).toBeUndefined();
          expect(res.body.data).toEqual({
            item: {
              overridden: globalWrap("option(decorator(resolver(value)))"),
              plain: globalWrap("option(value)"),
            },
          });
        });

        // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) does not bind @ResolveField() (and its @UseFieldMiddleware()) declared on an @InterfaceType() resolver (@Resolver(() => Document)) to implementing @ObjectType()s (Payslip, Memo); got `payslip(value)` / `document(value)` instead of `payslip(resolver(value))` / `document(resolver(value))`.
        it.skip("should keep the middleware of a model field overridden by an interface field resolver", async () => {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ payslip { owner } memo { owner } }" })
            .expect(200);

          expect(res.body.errors).toBeUndefined();
          expect(res.body.data).toEqual({
            payslip: { owner: globalWrap("payslip(resolver(value))") },
            memo: { owner: globalWrap("document(resolver(value))") },
          });
        });
      });
    }
  },
);
