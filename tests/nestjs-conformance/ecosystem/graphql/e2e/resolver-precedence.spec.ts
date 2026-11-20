import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  type CanActivate,
  Injectable,
  Module,
  type ModuleImport,
  type Type,
  UseGuards,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ObjectType,
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

@ObjectType()
class Account {
  @Field(() => String)
  iban!: string;
}

@Injectable()
class AccountsService {
  findOne() {
    return { iban: "DE89370400440532013000" };
  }
}

// A reusable module bundling an unguarded resolver
@Resolver(() => Account)
class AccountsResolver {
  constructor(protected readonly accountsService: AccountsService) {}

  @Query(() => Account)
  account() {
    return this.accountsService.findOne();
  }
}

@Module({
  providers: [AccountsService, AccountsResolver],
  exports: [AccountsService],
})
class AccountsModule {}

// The application guards the query by overriding it
@Resolver(() => Account)
class SecuredAccountsResolver extends AccountsResolver {
  @UseGuards(DenyGuard)
  @Query(() => Account, { description: "Requires login" })
  override account() {
    return super.account();
  }
}

@Module({
  imports: [AccountsModule],
  providers: [SecuredAccountsResolver],
})
class SecuredAccountsModule {}

// The same overwrite inside one provider: a renamed redeclaration
function BaseResolver<T>(classRef: Type<T>): Type<{ findAll(): unknown }> {
  @Resolver(undefined, { isAbstract: true })
  abstract class BaseResolverHost {
    @Query(() => [classRef], { name: `findAll${classRef.name}` })
    findAll() {
      return [{ iban: "DE89370400440532013000" }];
    }
  }
  return BaseResolverHost as unknown as Type<{ findAll(): unknown }>;
}

@ObjectType()
class Invoice {
  @Field(() => String)
  iban!: string;
}

@Resolver(() => Invoice)
class InvoicesResolver extends BaseResolver(Invoice) {
  @UseGuards(DenyGuard)
  @Query(() => [Invoice], { name: "findAllInvoice" })
  findAllForStaff() {
    return [{ iban: "staff only" }];
  }
}

@Module({ providers: [InvoicesResolver] })
class InvoicesModule {}

describeConformance(
  "GraphQL - Precedence of a resolver over the resolver it extends",
  {
    upstreamPath: "packages/apollo/tests/e2e/resolver-precedence.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo resolver inheritance precedence E2E to native @bunest/graphql and zero-socket Bun HTTP requests.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (imports: ModuleImport[]) => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          GraphQLModule.forRoot({
            autoSchemaFile: true,
          }),
          ...imports,
        ],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    };

    const query = (gqlQuery: string) =>
      request(app!).post("/graphql").send({ query: gqlQuery });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it.each([
      ["after", [SecuredAccountsModule]],
      ["before", [AccountsModule, SecuredAccountsModule]],
    ] as const)(
      "should serve the guarded override when the base resolver is scanned %s it",
      async (_, imports) => {
        await createApp([...imports]);

        const { body } = await query("{ account { iban } }");
        expect(body.data).toBeNull();
        expect(body.errors[0].message).toBe("Forbidden resource");
      },
    );

    it("should serve a redeclaration over the method it replaces", async () => {
      await createApp([InvoicesModule]);

      const { body } = await query("{ findAllInvoice { iban } }");
      expect(body.data).toBeNull();
      expect(body.errors[0].message).toBe("Forbidden resource");
    });
  },
);
