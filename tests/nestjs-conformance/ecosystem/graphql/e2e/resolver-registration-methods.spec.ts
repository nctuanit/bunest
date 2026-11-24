import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type DynamicModule,
  Module,
  type Type,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Resolver()
class CatsResolver {
  @Query(() => String)
  getAnimalName(): string {
    return "cat";
  }
}

@Module({})
class CatsModule {
  static register(
    resolverRegistrationMethod: "useClass" | "useFactory" | "useValue",
    resolver: Type<unknown> = CatsResolver,
    token: string | symbol | Type<unknown> = resolver,
  ): DynamicModule {
    switch (resolverRegistrationMethod) {
      case "useClass":
        return {
          module: CatsModule,
          providers: [
            {
              provide: token,
              useClass: resolver,
            },
          ],
        };

      case "useValue":
        return {
          module: CatsModule,
          providers: [
            {
              provide: token,
              useValue: new resolver(),
            },
          ],
        };

      case "useFactory":
      default:
        return {
          module: CatsModule,
          providers: [
            {
              provide: token,
              useFactory() {
                return new resolver();
              },
            },
          ],
        };
    }
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      includeStacktraceInErrorResponses: false,
      autoSchemaFile: true,
    }),
  ],
})
class ApplicationModule {}

describeConformance(
  "GraphQL - Resolver registration methods",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/resolver-registration-methods.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo resolver registration methods (useClass/useValue/useFactory) E2E to native @bunest/graphql.",
  },
  () => {
    let app: BunestApplication;

    describe("useClass", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [ApplicationModule, CatsModule.register("useClass")],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return the cats result", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: "query {\n  getAnimalName \n}\n",
          })
          .expect(200);

        expect(res.body).toEqual({
          data: {
            getAnimalName: "cat",
          },
        });
      });

      afterEach(async () => {
        await app.close();
      });
    });

    describe("useValue", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [ApplicationModule, CatsModule.register("useValue")],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return the cats result", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: "query {\n  getAnimalName \n}\n",
          })
          .expect(200);

        expect(res.body).toEqual({
          data: {
            getAnimalName: "cat",
          },
        });
      });

      afterEach(async () => {
        await app.close();
      });
    });

    describe("useFactory", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [ApplicationModule, CatsModule.register("useFactory")],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return the cats result", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: "query {\n  getAnimalName \n}\n",
          })
          .expect(200);

        expect(res.body).toEqual({
          data: {
            getAnimalName: "cat",
          },
        });
      });

      afterEach(async () => {
        await app.close();
      });
    });
  },
);
