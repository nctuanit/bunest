import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type CanActivate,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  type FieldMiddleware,
  GraphQLModule,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Injectable()
class StaffGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

const mask: FieldMiddleware = async (_ctx, next) => {
  const value: string = await next();
  return `**** ${value.slice(-4)}`;
};

// An ordinary (billing) object type named like the root subscription type
@ObjectType()
class Subscription {
  @Field(() => String)
  plan!: string;

  @Field(() => String)
  cardNumber!: string;
}

@Resolver(() => Subscription)
class SubscriptionResolver {
  @Query(() => Subscription)
  currentSubscription() {
    return { plan: "pro", cardNumber: "4111111111111111" };
  }

  @UseGuards(StaffGuard)
  @ResolveField(() => String)
  cardNumber(@Parent() subscription: Subscription) {
    return subscription.cardNumber;
  }
}

// An ordinary object type named like the root mutation type
@ObjectType()
class Mutation {
  @Field(() => String)
  patientName!: string;
}

@Resolver(() => Mutation)
class MutationResolver {
  @Query(() => Mutation)
  lastMutation() {
    return { patientName: "stored" };
  }

  @ResolveField(() => String, { middleware: [mask] })
  patientName(@Parent() mutation: Mutation) {
    return `${mutation.patientName} 12345678`;
  }
}

@Module({ providers: [SubscriptionResolver, MutationResolver] })
class BillingModule {}

describeConformance(
  "GraphQL - Object types named like a root type",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/root-type-named-object-types.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo root-type-named object types E2E (Subscription/Mutation object types with guards & field middleware) to native @bunest/graphql.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          BillingModule,
          GraphQLModule.forRoot({
            autoSchemaFile: true,
            // no "fieldResolverEnhancers": the guard above has to run anyway
          }),
        ],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    const query = (gqlQuery: string) =>
      request(app).post("/graphql").send({ query: gqlQuery });

    it('should run the guarded field resolver of a type named "Subscription"', async () => {
      const { body } = await query(
        "{ currentSubscription { plan cardNumber } }",
      );

      expect(body.data).toBeNull();
      expect(body.errors[0].message).toBe("Forbidden resource");
    });

    it('should run the field middleware of a type named "Mutation"', async () => {
      const { body } = await query("{ lastMutation { patientName } }");

      expect(body).toEqual({
        data: { lastMutation: { patientName: "**** 5678" } },
      });
    });
  },
);
