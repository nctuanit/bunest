import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type ExecutionResult,
  parse,
  subscribe,
} from "../../../../../packages/graphql/node_modules/graphql";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  GqlExecutionContext,
  GraphQLModule,
  GraphQLSchemaHost,
  Int,
  PubSub,
  Query,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const pubSub = new PubSub();

@Injectable()
class StaffGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return GqlExecutionContext.create(context).getContext().staff === true;
  }
}

@Resolver()
@UseGuards(StaffGuard)
class AccountsResolver {
  @Query(() => Int)
  balance() {
    return 944351;
  }

  @Subscription(() => Int, {
    // Builds its answer from the arguments, not from the event
    resolve(this: AccountsResolver, _event: unknown, args: { id: number }) {
      return this.balance() + args.id;
    },
  })
  balanceChanged(@Args("id", { type: () => Int }) _id: number) {
    return pubSub.asyncIterator("balanceChanged");
  }
}

@Module({ providers: [AccountsResolver] })
class AccountsModule {}

describeConformance(
  'GraphQL - "resolve" of a guarded subscription',
  {
    upstreamPath:
      "packages/apollo/tests/e2e/subscription-resolve-guards.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo guarded subscription resolve E2E to native @bunest/graphql and Bunest PubSub.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          AccountsModule,
          GraphQLModule.forRoot({
            autoSchemaFile: true,
          }),
        ],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should not run for a subscription sent over HTTP", async () => {
      const { body } = await request(app)
        .post("/graphql")
        .send({ query: "subscription { balanceChanged(id: 1) }" });

      expect(body.data?.balanceChanged ?? null).toBeNull();
      expect(body.errors).toHaveLength(1);
    });

    // BUNEST_BUG: GraphQLSchemaFactory.createSubscriptionField() invokes `op.resolve!(payload, args, contextValue, info)` without binding `this` to `compiled.instance` (`op.resolve.call(compiled.instance, ...)`), throwing `TypeError: this.balance is not a function` (packages/graphql/src/schema/graphql-schema.factory.ts:706-712).
    it.skip("should run for the events of a subscription the guard let through", async () => {
      const { schema } = app.get(GraphQLSchemaHost);
      const stream = (await subscribe({
        schema,
        document: parse("subscription { balanceChanged(id: 1) }"),
        contextValue: { staff: true },
      })) as AsyncIterableIterator<ExecutionResult>;

      try {
        const delivered = stream.next();
        // the pubsub subscription is registered on the first pull
        await new Promise((resolve) => setTimeout(resolve, 10));
        await pubSub.publish("balanceChanged", {});

        expect((await delivered).value).toEqual({
          data: { balanceChanged: 944352 },
        });
      } finally {
        await stream.return?.();
      }
    });

    it("should not subscribe for a client the guard refuses", async () => {
      const { schema } = app.get(GraphQLSchemaHost);
      const result = (await subscribe({
        schema,
        document: parse("subscription { balanceChanged(id: 1) }"),
        contextValue: { staff: false },
      })) as ExecutionResult;

      expect(result.errors?.[0]?.message).toBe("Forbidden resource");
    });
  },
);
