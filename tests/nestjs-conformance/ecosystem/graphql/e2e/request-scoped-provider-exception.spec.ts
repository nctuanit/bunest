import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GraphQLError } from "../../../../../packages/graphql/src";
import {
  APP_FILTER,
  Catch,
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
  UseFilters,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type GqlExceptionFilter,
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers/index";

class ProviderCreationException extends Error {}
class ConstructorException extends Error {}

@Catch(ProviderCreationException)
class GlobalCreationFilter implements GqlExceptionFilter {
  catch() {
    return new GraphQLError("caught by global filter");
  }
}

@Catch(ConstructorException)
class ResolverCreationFilter implements GqlExceptionFilter {
  catch() {
    return new GraphQLError("caught by resolver filter");
  }
}

@Injectable({ scope: Scope.REQUEST })
class FailingService {
  constructor(@Inject(REQUEST) _req: unknown) {
    throw new ConstructorException("constructor failed");
  }
}

@Resolver()
class SingletonLeakResolver {
  constructor(@Inject("FAILING_FACTORY") _failing: unknown) {}

  @Query(() => Boolean)
  viaFactory(): boolean {
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
@Resolver()
class FactoryResolver {
  constructor(@Inject("FAILING_FACTORY") _failing: unknown) {}

  @Query(() => Boolean)
  viaFactory(): boolean {
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
@Resolver()
@UseFilters(ResolverCreationFilter)
class ConstructorResolver {
  constructor(_failing: FailingService) {}

  @Query(() => Boolean)
  viaConstructor(): boolean {
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
@Resolver()
class UnfilteredResolver {
  constructor(@Inject("UNFILTERED_FACTORY") _failing: unknown) {}

  @Query(() => Boolean)
  viaUnfiltered(): boolean {
    return true;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
    }),
  ],
  providers: [
    {
      provide: "FAILING_FACTORY",
      scope: Scope.REQUEST,
      inject: [REQUEST],
      useFactory: () => {
        throw new ProviderCreationException("factory failed");
      },
    },
    {
      provide: "UNFILTERED_FACTORY",
      scope: Scope.REQUEST,
      useFactory: () => {
        throw new Error("no filter for this one");
      },
    },
    FailingService,
    UnfilteredResolver,
    FactoryResolver,
    ConstructorResolver,
    { provide: APP_FILTER, useClass: GlobalCreationFilter },
  ],
})
class AppModule {}

describeConformance(
  "Request-scoped provider creation errors (#1069)",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/request-scoped-provider-exception.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Under ADR-012, singleton resolvers injecting Scope.REQUEST providers fail fast with ScopeLeakException unless explicitly marked @Injectable({ scope: Scope.REQUEST }). Tests both ADR-012 fail-fast enforcement and explicit request-scoped resolver error routing.",
  },
  () => {
    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException when a singleton @Resolver injects a Scope.REQUEST provider without opting into Scope.REQUEST",
      async () => {
        @Module({
          imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
          providers: [
            {
              provide: "FAILING_FACTORY",
              scope: Scope.REQUEST,
              useFactory: () => true,
            },
            SingletonLeakResolver,
          ],
        })
        class LeakyModule {}

        await expectScopeLeak(async () => {
          const mod = await Test.createTestingModule({
            imports: [LeakyModule],
          }).compile({ logger: false });
          await mod.close();
        });
      },
    );

    describe("with explicit @Injectable({ scope: Scope.REQUEST }) resolvers", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterAll(async () => {
        if (app) {
          await app.close();
        }
      });

      it("routes a request-scoped factory error through global filters", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ viaFactory }" });
        expect(res.body.data).toBeNull();
        expect(res.body.errors[0].message).toBe("caught by global filter");
      });

      it("routes a request-scoped constructor error through resolver filters", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ viaConstructor }" });
        expect(res.body.data).toBeNull();
        expect(res.body.errors[0].message).toBe("caught by resolver filter");
      });

      it("keeps the original error when no filter matches", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ viaUnfiltered }" });
        expect(res.body.data).toBeNull();
        expect(res.body.errors[0].message).toBe("no filter for this one");
      });
    });
  },
);
