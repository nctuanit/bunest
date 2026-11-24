import { afterAll, beforeAll, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@ObjectType()
class Reading {
  @Field(() => ID)
  id!: string;

  @Field()
  capturedAt!: Date;
}

@Resolver(() => Reading)
class ReadingResolver {
  @Query(() => Reading)
  reading(): Reading {
    const r = new Reading();
    r.id = "1";
    r.capturedAt = new Date(0);
    return r;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: true,
      buildSchemaOptions: { dateScalarMode: "timestamp" },
    }),
  ],
  providers: [ReadingResolver],
})
class TimestampFederationModule {}

describeConformance(
  'Federation - Timestamp scalar (dateScalarMode: "timestamp")',
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-timestamp-scalar.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver Timestamp scalar E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TimestampFederationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("should serialize a Date field through the Timestamp scalar in the federated schema", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              reading {
                id
                capturedAt
              }
            }
          `,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const data = res.body.data as {
        reading: { id: string; capturedAt: number };
      };
      expect(data.reading.id).toBe("1");
      expect(data.reading.capturedAt).toBe(0);
    });
  },
);
