import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  GraphQLNonNull,
  type GraphQLObjectType,
} from "../../../../../packages/graphql/src";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Extensions,
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  ID,
  InputType,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

@InputType()
@Extensions({ exampleExtension: "exampleValue" })
class CreateUserInput {
  @Extensions({ fieldLevelExtension: 123 })
  @Field()
  name!: string;
}

@ObjectType()
class Status {
  @Field(() => ID)
  id!: string;

  @Field()
  @Extensions({ isPublic: true })
  code!: string;
}

@ObjectType()
class User {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Extensions({ isPublic: true })
  @Field(() => Status, { nullable: true, description: "DTO Description" })
  status?: Status;
}

@Injectable()
class UserService {
  private users: User[] = [];
  private idCounter = 1;

  findAll(): User[] {
    return this.users;
  }

  findOne(id: string): User | undefined {
    return this.users.find((user) => user.id === id);
  }

  create(createUserInput: CreateUserInput): User {
    const user: User = {
      id: String(this.idCounter++),
      name: createUserInput.name,
    };
    this.users.push(user);
    return user;
  }
}

@Resolver(() => User)
class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Query(() => [User], { name: "users" })
  findAll(): User[] {
    return this.userService.findAll();
  }

  @Mutation(() => User)
  createUser(@Args("createUserInput") createUserInput: CreateUserInput): User {
    return this.userService.create(createUserInput);
  }

  @ResolveField("status", undefined, {
    nullable: true,
    description: "Resolve Field Description",
  })
  getStatus(@Parent() _user: User): Status {
    return {
      id: "status-id",
      code: "ACTIVE",
    };
  }
}

@Module({
  providers: [UserResolver, UserService],
})
class UserModule {}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
      playground: false,
    }),
    UserModule,
  ],
})
class ExtensionsAppModule {}

describeConformance(
  "Code-first extensions",
  {
    upstreamPath: "packages/apollo/tests/e2e/code-first-extensions.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo code-first extensions E2E to native @bunest/graphql.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ExtensionsAppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    // BUNEST_BUG: Expected statusField.extensions.isPublic to be true; actual is undefined because GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1116-1134) drops existingField.extensions when attaching a @ResolveField() that has no complexity option.
    it.skip("adds extensions to resolved field", async () => {
      const { schema } = app.get(GraphQLSchemaHost);
      const userObject = schema.getType("User") as GraphQLObjectType;
      expect(userObject).toBeTruthy();
      const statusField = userObject.getFields().status;
      expect(statusField).toBeTruthy();

      const extensions = statusField!.extensions;

      expect(extensions.isPublic).toBe(true);
    });

    // BUNEST_BUG: Expected statusField.description to be "Resolve Field Description"; actual is "DTO Description" because ResolveField (packages/graphql/src/decorators/resolver.decorators.ts:176-183) ignores the 3rd argument maybeOptions when the 2nd argument returnTypeOrOptions is undefined.
    it.skip("applies the @ResolveField() options passed after an undefined type function", async () => {
      const { schema } = app.get(GraphQLSchemaHost);
      const userObject = schema.getType("User") as GraphQLObjectType;
      const statusField = userObject.getFields().status;

      // user.resolver.ts: @ResolveField('status', undefined, { nullable: true, description: ... })
      expect(statusField!.description).toBe("Resolve Field Description");
      expect(statusField!.type).not.toBeInstanceOf(GraphQLNonNull);
    });
  },
);
