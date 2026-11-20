import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  GraphQLError,
  GraphQLScalarType,
  Kind,
} from "../../../../../packages/graphql/node_modules/graphql";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  GraphQLModule,
  Int,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

function parseDay(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new GraphQLError(`Day cannot represent ${JSON.stringify(value)}`);
  }
  return new Date(value);
}

const DayScalar = new GraphQLScalarType({
  name: "Day",
  serialize: (value: unknown) => (value as Date).toISOString().slice(0, 10),
  parseValue: parseDay,
  parseLiteral: (ast) => parseDay(ast.kind === Kind.STRING ? ast.value : null),
});

function parsePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GraphQLError(
      `PositiveInt cannot represent ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const PositiveIntScalar = new GraphQLScalarType({
  name: "PositiveInt",
  serialize: parsePositiveInt,
  parseValue: parsePositiveInt,
  parseLiteral: (ast) =>
    parsePositiveInt(ast.kind === Kind.INT ? Number(ast.value) : null),
});

@Resolver()
class ScalarsResolver {
  @Query(() => Date)
  nextDay(@Args("day") day: Date): Date {
    return new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }

  @Query(() => Int)
  double(
    @Args("amount", { type: () => PositiveIntScalar }) amount: number,
  ): number {
    return amount * 2;
  }

  @Query(() => PositiveIntScalar)
  negative(): number {
    return -5;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: true,
      buildSchemaOptions: { scalarsMap: [{ type: Date, scalar: DayScalar }] },
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [ScalarsResolver],
})
class CustomScalarsFederationModule {}

describeConformance(
  "Federation - custom scalars of the code-first schema",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-custom-scalars.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver custom scalars E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CustomScalarsFederationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    async function execute(query: string) {
      const res = await request(app).post("/graphql").send({ query });
      return res.body as {
        data?: Record<string, unknown> | null;
        errors?: Array<{ message: string }>;
      };
    }

    it('should parse and serialize values through the scalar from "scalarsMap"', async () => {
      const result = await execute(`{ nextDay(day: "2020-01-31") }`);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ nextDay: "2020-02-01" });
    });

    it('should reject values the scalar from "scalarsMap" does not accept', async () => {
      const result = await execute(`{ nextDay(day: "1") }`);
      expect(result.errors?.[0]?.message).toBe('Day cannot represent "1"');
    });

    it("should reject values a directly referenced scalar does not accept", async () => {
      const result = await execute(`{ double(amount: -1000) }`);
      expect(result.errors?.[0]?.message).toBe(
        "PositiveInt cannot represent -1000",
      );
    });

    it("should serialize values through a directly referenced scalar", async () => {
      const result = await execute(`{ negative }`);
      expect(result.errors?.[0]?.message).toBe(
        "PositiveInt cannot represent -5",
      );
    });
  },
);
