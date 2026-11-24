import { afterEach, describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  type CanActivate,
  type DynamicModule,
  Injectable,
  Module,
  type ModuleImport,
  type Provider,
  Scope,
  type Type,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Resolver()
class CatsResolver {
  @Query(() => String)
  getAnimalName(): string {
    return "cat";
  }
}

@Resolver()
class GuardedCatsResolver {
  @UseGuards(DenyGuard)
  @Query(() => String)
  getGuardedAnimalName(): string {
    return "guarded cat";
  }
}

@Resolver()
class InstanceGuardedCatsResolver {
  @UseGuards(new DenyGuard())
  @Query(() => String)
  getGuardedAnimalName(): string {
    return "guarded cat";
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

@Injectable({ scope: Scope.REQUEST })
class RequestScopedDenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

describeConformance(
  "GraphQL - Enhancers of the resolver registration methods",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/resolver-registration-enhancers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Adapts @nestjs/apollo resolver registration enhancers E2E to native @bunest/graphql and zero-socket Bun HTTP requests.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (
      imports: ModuleImport[],
      providers: Provider[] = [],
    ) => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule, ...imports],
        providers,
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      return app;
    };

    const query = (gqlQuery: string) =>
      request(app!).post("/graphql").send({ query: gqlQuery });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    describe("enhancers referenced by class", () => {
      it('should run them for a resolver registered with "useClass"', async () => {
        await (
          await createApp([
            CatsModule.register("useClass", GuardedCatsResolver),
          ])
        ).init();

        const { body } = await query("{ getGuardedAnimalName }");
        expect(body.data).toBeNull();
        expect(body.errors[0].message).toBe("Forbidden resource");
      });

      // BUNEST_BUG: GraphQLSchemaFactory.compileMethod() resolves class enhancers via moduleRef.get/create even for useFactory/useValue resolvers instead of refusing bootstrap when Nest did not register the class enhancer on the provider (packages/graphql/src/schema/graphql-schema.factory.ts:275-288).
      it.skip.each(["useFactory", "useValue"] as const)(
        'should refuse to start with a resolver registered with "%s"',
        async (method) => {
          await createApp([CatsModule.register(method, GuardedCatsResolver)]);

          await expect(app!.init()).rejects.toThrow(
            'The "GuardedCatsResolver.getGuardedAnimalName" GraphQL handler of the "GuardedCatsResolver" provider references "DenyGuard" by class, but Nest did not register this enhancer for the provider, so it would never run.',
          );
        },
      );

      it('should run enhancer instances for a resolver registered with "useFactory"', async () => {
        await (
          await createApp([
            CatsModule.register("useFactory", InstanceGuardedCatsResolver),
          ])
        ).init();

        const { body } = await query("{ getGuardedAnimalName }");
        expect(body.data).toBeNull();
        expect(body.errors[0].message).toBe("Forbidden resource");
      });
    });

    describe("request-scoped global guards", () => {
      const globalGuard: Provider = {
        provide: APP_GUARD,
        useClass: RequestScopedDenyGuard,
      };

      // BUNEST_BUG: GraphQLService.buildSchema() only discovers APP_FILTER multi-providers and ignores APP_GUARD (including request-scoped global guards), so RequestScopedDenyGuard never runs for GraphQL resolvers (packages/graphql/src/driver/graphql-http.handler.ts:258-290).
      it.skip.each([
        ["as a class", CatsResolver],
        ['with "useClass" under another token', "CATS_RESOLVER"],
      ] as const)(
        "should run them for a resolver registered %s",
        async (_, token) => {
          await (
            await createApp(
              [CatsModule.register("useClass", CatsResolver, token)],
              [globalGuard],
            )
          ).init();

          const { body } = await query("{ getAnimalName }");
          expect(body.data).toBeNull();
          expect(body.errors[0].message).toBe("Forbidden resource");
        },
      );

      // BUNEST_BUG: GraphQLService.buildSchema() does not validate non-entry useFactory/useValue resolver providers against request-scoped global APP_GUARD enhancers at startup (packages/graphql/src/driver/graphql-http.handler.ts:224-290).
      it.skip.each(["useFactory", "useValue"] as const)(
        'should refuse to start with a resolver registered with "%s" under another token',
        async (method) => {
          await createApp(
            [CatsModule.register(method, CatsResolver, "CATS_RESOLVER")],
            [globalGuard],
          );

          await expect(app!.init()).rejects.toThrow(
            'The "CATS_RESOLVER" provider of the "CatsModule" module hosts GraphQL handlers but is not an entry provider, so the request or transient-scoped global enhancer "RequestScopedDenyGuard" would not run for them.',
          );
        },
      );
    });
  },
);
