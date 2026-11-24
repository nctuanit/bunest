import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  type CanActivate,
  ForbiddenException,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GraphQLModule,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@ObjectType()
class User {
  @Field()
  id!: string;
}

@ObjectType()
class Author extends User {
  @Field()
  bio!: string;
}

@ObjectType()
class StarAuthor extends Author {
  @Field()
  stars!: number;
}

@ObjectType()
class Editor extends User {
  @Field()
  desk!: string;
}

const ada = {
  id: "1",
  bio: "writes books",
  stars: 3,
  desk: "A1",
  email: "ada@example.com",
  ssn: "000-00-0000",
  phone: "555-0100",
};

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException("Forbidden resource");
  }
}

@Resolver(() => User)
class UsersResolver {
  @Query(() => User)
  user(): User {
    return ada;
  }

  @Query(() => Author)
  author(): Author {
    return ada;
  }

  @Query(() => StarAuthor)
  starAuthor(): StarAuthor {
    return ada;
  }

  @Query(() => Editor)
  editor(): Editor {
    return ada;
  }

  @ResolveField(() => String)
  email(@Parent() user: typeof ada): string {
    return `user:${user.email}`;
  }

  @ResolveField(() => String, {
    middleware: [
      () => {
        throw new ForbiddenException("Forbidden resource");
      },
    ],
  })
  ssn(): string {
    return ada.ssn;
  }

  @ResolveField(() => String)
  @UseGuards(DenyGuard)
  phone(): string {
    return ada.phone;
  }
}

@Resolver(() => Author)
class AuthorsResolver {
  @ResolveField(() => String)
  email(@Parent() author: typeof ada): string {
    return `author:${author.email}`;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
      fieldResolverEnhancers: ["guards"],
    }),
  ],
  providers: [UsersResolver, AuthorsResolver, DenyGuard],
})
class TypeInheritanceModule {}

describeConformance(
  "code-first with object types that use inheritance",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/code-first-type-inheritance.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo object type inheritance field resolver E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TypeInheritanceModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    async function expectForbidden(queryStr: string) {
      const res = await request(app)
        .post("/graphql")
        .send({ query: queryStr })
        .expect(200);
      const { data, errors } = res.body as {
        data: unknown;
        errors?: Array<{ message: string }>;
      };
      expect(data).toBeNull();
      expect(errors?.map((error) => error.message)).toEqual([
        "Forbidden resource",
      ]);
    }

    it("should bind the field resolvers of the parent type to its subtypes (nearest ancestor wins)", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              user {
                email
              }
              author {
                email
              }
              starAuthor {
                email
              }
              editor {
                email
              }
            }
          `,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        user: { email: "user:ada@example.com" },
        author: { email: "author:ada@example.com" },
        starAuthor: { email: "author:ada@example.com" },
        editor: { email: "user:ada@example.com" },
      });
    });

    it("should apply the field middleware of the inherited field resolver (user)", () =>
      expectForbidden("{ user { ssn } }"));

    for (const queryName of ["author", "starAuthor", "editor"]) {
      it(`should apply the field middleware of the inherited field resolver (${queryName})`, () =>
        expectForbidden(`{ ${queryName} { ssn } }`));
    }

    it("should apply the guards of the inherited field resolver (user)", () =>
      expectForbidden("{ user { phone } }"));

    for (const queryName of ["author", "starAuthor", "editor"]) {
      it(`should apply the guards of the inherited field resolver (${queryName})`, () =>
        expectForbidden(`{ ${queryName} { phone } }`));
    }
  },
);
