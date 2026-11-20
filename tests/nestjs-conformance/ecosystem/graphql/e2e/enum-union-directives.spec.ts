import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Directive,
  type EnumValueConfigOptions,
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  Resolver,
  createUnionType,
  registerEnumType,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

enum Visibility {
  PUBLIC = "PUBLIC",
  PRIVATE = "PRIVATE",
}

registerEnumType(Visibility, {
  name: "Visibility",
  description: "Visibility of a resource",
  directives: ['@tag(name: "visibility")'],
  valuesMap: {
    PUBLIC: {
      directives: ['@tag(name: "public")'],
    } as EnumValueConfigOptions,
  },
});

@ObjectType()
@Directive('@key(fields: "id")')
class Article {
  @Field(() => ID)
  id!: string;
}

@ObjectType()
@Directive('@key(fields: "id")')
class Video {
  @Field(() => ID)
  id!: string;
}

const Media = createUnionType({
  name: "Media",
  types: () => [Article, Video] as const,
  directives: ['@tag(name: "media")'],
});

@Resolver()
class DirectivesResolver {
  @Query(() => Visibility)
  visibility(): Visibility {
    return Visibility.PUBLIC;
  }

  @Query(() => Media)
  latest(): Article | Video {
    return { id: "1" } as Article;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: true,
      autoSchemaFile: true,
      buildSchemaOptions: {
        orphanedTypes: [Article, Video],
      },
    }),
  ],
  providers: [DirectivesResolver],
})
class DirectivesAppModule {}

describeConformance(
  "Code-first - directives on enums and unions (e2e)",
  {
    upstreamPath: "packages/apollo/tests/e2e/enum-union-directives.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo federation enum/enum-value/union directive emission E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DirectivesAppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    // BUNEST_BUG: Expected `_service.sdl` to emit `@tag(name: "visibility")` on enum Visibility, `@tag(name: "public")` on PUBLIC, and `@tag(name: "media")` on union Media; actual SDL omits all enum/enum-value/union directives because registerEnumType (packages/graphql/src/decorators/type.decorators.ts:102-118) ignores directives/valuesMap.directives, getOrCreateUnionType (packages/graphql/src/schema/graphql-schema.factory.ts:906-921) ignores ref.directives, and federation printSchema (:1549) does not print AST directives.
    it.skip("should emit enum, enum-value and union directives in the subgraph SDL", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              _service {
                sdl
              }
            }
          `,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      const sdl = (res.body.data as { _service: { sdl: string } })._service
        .sdl;

      expect(sdl).toMatch(/enum Visibility[^{]*@tag\(name: "visibility"\)/);
      expect(sdl).toMatch(/PUBLIC @tag\(name: "public"\)/);
      expect(sdl).not.toMatch(/PRIVATE[^\n]*@tag/);
      expect(sdl).toMatch(/union Media[^=]*@tag\(name: "media"\)/);
    });
  },
);
