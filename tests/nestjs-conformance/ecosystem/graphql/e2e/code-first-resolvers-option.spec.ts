import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type CanActivate,
  ForbiddenException,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type SchemaFirstResolversMap,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException("Forbidden resource");
  }
}

@ObjectType()
class Member {
  @Field()
  name!: string;

  @Field()
  displayName!: string;
}

const member = { name: "alice", email: "alice@example.com" };

@Resolver(() => Member)
class MemberResolver {
  @Query(() => Member)
  member() {
    return member;
  }

  @ResolveField(() => String)
  @UseGuards(DenyGuard)
  email() {
    return member.email;
  }
}

function mergeResolverMaps(
  maps: SchemaFirstResolversMap | SchemaFirstResolversMap[],
): SchemaFirstResolversMap {
  const list = Array.isArray(maps) ? maps : [maps];
  const merged: SchemaFirstResolversMap = {};
  for (const map of list) {
    for (const [typeName, fields] of Object.entries(map)) {
      merged[typeName] = { ...(merged[typeName] ?? {}), ...fields };
    }
  }
  return merged;
}

describeConformance(
  'code-first "resolvers" option for a type that has field resolvers',
  {
    upstreamPath:
      "packages/apollo/tests/e2e/code-first-resolvers-option.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo code-first resolvers/transformResolvers option E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    const cases: Array<
      [
        string,
        (
          resolvers: SchemaFirstResolversMap | SchemaFirstResolversMap[],
        ) => SchemaFirstResolversMap | SchemaFirstResolversMap[],
      ]
    > = [
      ["an array", (resolvers) => resolvers],
      ["a single map", (resolvers) => mergeResolverMaps(resolvers)],
    ];

    for (const [label, transformResolvers] of cases) {
      describe(`transformResolvers returns ${label}`, () => {
        @Module({
          imports: [
            GraphQLModule.forRoot({
              autoSchemaFile: true,
              fieldResolverEnhancers: ["guards"],
              transformResolvers,
              resolvers: {
                Member: {
                  displayName: (parent: typeof member) =>
                    parent.name.toUpperCase(),
                },
              },
            }),
          ],
          providers: [MemberResolver, DenyGuard],
        })
        class ResolversOptionModule {}

        let app: BunestApplication;

        beforeAll(async () => {
          const moduleRef = await Test.createTestingModule({
            imports: [ResolversOptionModule],
          }).compile({ logger: false });
          app = moduleRef.createNestApplication({ logger: false });
          await app.init();
        });

        afterAll(async () => {
          await app.close();
        });

        // BUNEST_BUG: Expected `{ member: { displayName: "ALICE" } }` from options.resolvers.Member.displayName; actual returns GraphQL error `Cannot return null for non-nullable field Member.displayName.` because GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts:1232-1580) never applies options.resolvers or options.transformResolvers in code-first mode.
        it.skip("should apply the resolvers of the option", async () => {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ member { displayName } }" })
            .expect(200);
          expect(res.body.errors).toBeUndefined();
          expect(res.body.data).toEqual({
            member: { displayName: "ALICE" },
          });
        });

        it("should keep the guarded field resolvers of the type", async () => {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ member { email } }" })
            .expect(200);
          const { data, errors } = res.body as {
            data: unknown;
            errors?: Array<{ message: string }>;
          };
          expect(data).toBeNull();
          expect(errors?.map((error) => error.message)).toEqual([
            "Forbidden resource",
          ]);
        });
      });
    }
  },
);
