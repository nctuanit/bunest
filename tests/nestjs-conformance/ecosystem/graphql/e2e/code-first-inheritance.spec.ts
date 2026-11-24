import { afterEach, beforeEach, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  GraphQLModule,
  InputType,
  Int,
  Mutation,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@InputType()
class MyArgs {
  @Field()
  public myInput!: number;
}

@Resolver(undefined, { isAbstract: true })
abstract class MyBaseResolver {
  @Query(() => Int)
  public myQuery(): number {
    return 10;
  }

  @Mutation(() => Int)
  public myMutation(
    @Args({ type: () => MyArgs, name: "input" }) args: MyArgs,
  ): number {
    return args.myInput;
  }
}

@Resolver()
class MyResolver extends MyBaseResolver {}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
    }),
  ],
  providers: [MyResolver],
})
class MyModule {}

describeConformance(
  "code-first with a resolver that uses inheritance",
  {
    upstreamPath: "packages/apollo/tests/e2e/code-first-inheritance.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo resolver inheritance E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MyModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    function createTest(runLabel: string) {
      it(`resolver inherits schema from its' parent class (${runLabel})`, async () => {
        const mutation = `
          mutation MyTest {
            myMutation(input: { myInput: 5 })
          }
        `;
        const res = await request(app)
          .post("/graphql")
          .send({ query: mutation })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          myMutation: 5,
        });
      });
    }

    createTest("run 1");
    createTest("run 2");
  },
);
