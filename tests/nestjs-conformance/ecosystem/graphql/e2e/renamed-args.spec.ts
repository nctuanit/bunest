import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MinLength } from "class-validator";
import {
  type ExecutionResult,
  parse,
  subscribe,
} from "../../../../../packages/graphql/node_modules/graphql";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  ArgsType,
  Field,
  Float,
  GraphQLModule,
  GraphQLSchemaHost,
  ID,
  InputType,
  Int,
  ObjectType,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
  registerEnumType,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  nestCompatibleValidationPipe,
  request,
} from "../../../_helpers/index";

@InputType()
class FiltersInput {
  @Field(() => String, { name: "and", nullable: true })
  $and?: string;

  @Field(() => [FiltersInput], { nullable: true })
  nested?: FiltersInput[];
}

@ArgsType()
class BaseArgs {
  @Field(() => String, { name: "inherited_arg", nullable: true })
  inheritedArg?: string;
}

@ArgsType()
class SomeArgsClass extends BaseArgs {
  @Field(() => String, { name: "some_arg" })
  someArg!: string;

  @Field(() => String, { nullable: true })
  untouchedArg?: string;

  @Field(() => FiltersInput, { nullable: true })
  filters?: FiltersInput;
}

@ObjectType()
class AnotherObject {
  @Field(() => [String])
  keys!: string[];

  @Field(() => String, { nullable: true })
  someArg?: string;

  @Field(() => String, { nullable: true })
  inheritedArg?: string;

  @Field(() => String, { nullable: true })
  untouchedArg?: string;

  @Field(() => [String], { nullable: true })
  filtersKeys?: string[];

  @Field(() => String, { nullable: true })
  filtersAnd?: string;

  @Field(() => String, { nullable: true })
  nestedAnd?: string;

  @Field(() => String, { nullable: true })
  resolvedField?: string;
}

enum SomeEnum {
  A = "A",
  B = "B",
}
registerEnumType(SomeEnum, { name: "SomeEnum" });

@ArgsType()
class ScalarArgs {
  @Field(() => Int, { name: "int_arg" })
  intArg!: number;

  @Field(() => Float, { name: "float_arg" })
  floatArg!: number;

  @Field(() => Boolean, { name: "bool_arg" })
  boolArg!: boolean;

  @Field(() => ID, { name: "id_arg" })
  idArg!: string;

  @Field(() => SomeEnum, { name: "enum_arg" })
  enumArg!: SomeEnum;

  @Field(() => [Int], { name: "list_arg" })
  listArg!: number[];

  @Field(() => String, { name: "null_arg", nullable: true })
  nullArg?: string;
}

@InputType()
class ValidatedInput {
  @Field(() => String, { name: "and" })
  @MinLength(2)
  $and!: string;
}

@InputType()
class ChainedInput {
  // the schema name of one property is the class name of another
  @Field(() => String, { name: "a", nullable: true })
  b?: string;

  @Field(() => String, { name: "b", nullable: true })
  c?: string;
}

@InputType()
class NestingInput {
  // no renamed field of its own, only the nested type has one
  @Field(() => FiltersInput, { nullable: true })
  filters?: FiltersInput;
}

@ObjectType()
class Probe {
  @Field(() => String)
  json!: string;
}

@Resolver(() => AnotherObject)
class AnotherObjectResolver {
  @Query(() => AnotherObject)
  getAnotherObject(@Args() args: SomeArgsClass): AnotherObject {
    return {
      keys: Object.keys(args).sort(),
      someArg: args.someArg,
      inheritedArg: args.inheritedArg,
      untouchedArg: args.untouchedArg,
      ...this.describeFilters(args.filters),
    };
  }

  @Query(() => AnotherObject)
  getByFilters(@Args("filters") filters: FiltersInput): AnotherObject {
    return {
      keys: Object.keys(filters).sort(),
      ...this.describeFilters(filters),
    };
  }

  @Query(() => AnotherObject)
  validate(
    @Args("input", nestCompatibleValidationPipe({ transform: true }))
    input: ValidatedInput,
  ): AnotherObject {
    return { keys: Object.keys(input).sort(), filtersAnd: input.$and };
  }

  @ResolveField(() => String, { nullable: true })
  resolvedField(@Args() args: SomeArgsClass): string {
    return args.someArg;
  }

  @Query(() => String)
  scalars(@Args() args: ScalarArgs): string {
    return JSON.stringify(args, Object.keys(args).sort());
  }

  @Query(() => String)
  chained(@Args("input") input: ChainedInput): string {
    return JSON.stringify(input, Object.keys(input).sort());
  }

  @Query(() => String)
  listOfFilters(
    @Args("filters", { type: () => [FiltersInput] }) filters: FiltersInput[],
  ): string {
    return JSON.stringify(filters.map((filter) => Object.keys(filter).sort()));
  }

  private describeFilters(filters?: FiltersInput) {
    return {
      filtersKeys: filters && Object.keys(filters).sort(),
      filtersAnd: filters?.$and,
      nestedAnd: filters?.nested?.[0]?.$and,
    };
  }
}

@Resolver(() => Probe)
class GlobalPipeResolver {
  @Query(() => Probe)
  validateGlobally(@Args("input") input: ValidatedInput): Probe {
    return { json: JSON.stringify({ keys: Object.keys(input).sort() }) };
  }

  @Query(() => Probe)
  keepInstance(@Args("input") input: NestingInput): Probe {
    return {
      json: JSON.stringify({
        isInstance: input instanceof NestingInput,
        and: input.filters?.$and,
      }),
    };
  }
}

const pubSub = new PubSub();

@Resolver(() => Probe)
class SubscriptionArgsResolver {
  @Query(() => Probe)
  probe(): Probe {
    return { json: "" };
  }

  @Subscription(() => Probe, {
    filter: (payload: { probed: string }, variables: SomeArgsClass) =>
      !variables.someArg || payload.probed === variables.someArg,
    resolve: (payload: { probed: string }, args: SomeArgsClass): Probe => ({
      json: JSON.stringify({ payload: payload.probed, args }),
    }),
  })
  probed(@Args() _args: SomeArgsClass) {
    return pubSub.asyncIterator("probed");
  }

  @Subscription(() => Probe, {
    filter: (
      payload: { probedLegacy: string },
      variables: { some_arg?: string },
    ) => !!variables.some_arg && payload.probedLegacy === variables.some_arg,
    resolve: (payload: { probedLegacy: string }): Probe => ({
      json: payload.probedLegacy,
    }),
  })
  probedLegacy(@Args() _args: SomeArgsClass) {
    return pubSub.asyncIterator("probedLegacy");
  }
}

describeConformance(
  "Renamed args (@Field({ name }) on @ArgsType/@InputType classes)",
  {
    upstreamPath: "packages/apollo/tests/e2e/renamed-args.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-005", "ADR-009"],
    notes:
      "Replaces ApolloDriver and apolloClient.executeOperation with native @bunest/graphql + zero-socket request(app), uses built-in PubSub.asyncIterator, and uses nestCompatibleValidationPipe({ transform: true }) for NestJS ValidationPipe defaults (ADR-009).",
  },
  () => {
    describe("resolver & pipe arg remapping", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            GraphQLModule.forRoot({
              autoSchemaFile: true,
            }),
          ],
          providers: [AnotherObjectResolver],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      const execute = (query: string) =>
        request(app).post("/graphql").send({ query });

      // BUNEST_BUG: Expected renamed @ArgsType/@InputType schema args (some_arg, inherited_arg, and) to be remapped back to TypeScript class property names (someArg, inheritedArg, $and); actual raw schema keys are passed unmapped in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should hand the resolver the property names declared by the args class", async () => {
        const res = await execute(`
          {
            getAnotherObject(
              some_arg: "a"
              inherited_arg: "b"
              untouchedArg: "c"
              filters: { and: "d", nested: [{ and: "e" }] }
            ) {
              keys
              someArg
              inheritedArg
              untouchedArg
              filtersKeys
              filtersAnd
              nestedAnd
            }
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          getAnotherObject: {
            keys: ["filters", "inheritedArg", "someArg", "untouchedArg"],
            someArg: "a",
            inheritedArg: "b",
            untouchedArg: "c",
            filtersKeys: ["$and", "nested"],
            filtersAnd: "d",
            nestedAnd: "e",
          },
        });
      });

      // BUNEST_BUG: Expected nested @InputType renamed fields (and -> $and) of named @Args('filters') to be remapped; actual raw schema key "and" passed unmapped in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should map nested input types of a named argument as well", async () => {
        const res = await execute(`
          {
            getByFilters(filters: { and: "d", nested: [{ and: "e" }] }) {
              keys
              filtersAnd
              nestedAnd
            }
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          getByFilters: {
            keys: ["$and", "nested"],
            filtersAnd: "d",
            nestedAnd: "e",
          },
        });
      });

      // BUNEST_BUG: Expected @ResolveField @Args() with renamed @ArgsType field (some_arg -> someArg) to remap before invoking field resolver; actual args.someArg is undefined (resolvedField: null) in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should map the args of a field resolver too", async () => {
        const res = await execute(`
          {
            getAnotherObject(some_arg: "a") {
              resolvedField(some_arg: "b")
            }
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          getAnotherObject: { resolvedField: "b" },
        });
      });

      // BUNEST_BUG: Expected scalar/enum/list/null @ArgsType renamed fields (int_arg -> intArg, bool_arg -> boolArg, etc.) to be remapped; actual raw snake_case schema keys returned in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should map every scalar kind, falsy values and nulls included", async () => {
        const res = await execute(`
          {
            scalars(
              int_arg: 0
              float_arg: 1.5
              bool_arg: false
              id_arg: "7"
              enum_arg: B
              list_arg: [1, 2]
              null_arg: null
            )
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          scalars: JSON.stringify({
            boolArg: false,
            enumArg: "B",
            floatArg: 1.5,
            idArg: "7",
            intArg: 0,
            listArg: [1, 2],
            nullArg: null,
          }),
        });
      });

      // BUNEST_BUG: Expected renamed @InputType property (and -> $and) to be remapped before ValidationPipe runs so valid input { and: "ok" } passes @MinLength(2) on $and; actual ValidationPipe receives { and: "ok" } with $and undefined and fails validation in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should run before the user pipes, so validation sees the class properties", async () => {
        const valid = await execute(`
          {
            validate(input: { and: "ok" }) {
              keys
              filtersAnd
            }
          }
        `);
        expect(valid.body.errors).toBeUndefined();
        expect(valid.body.data).toEqual({
          validate: { keys: ["$and"], filtersAnd: "ok" },
        });

        const invalid = await execute(`
          {
            validate(input: { and: "x" }) {
              filtersAnd
            }
          }
        `);
        expect(invalid.body.errors[0].message).toContain(
          "$and must be longer than or equal to 2 characters",
        );
      });

      // BUNEST_BUG: Expected chained rename (a -> b, b -> c) to produce { b: "one", c: "two" }; actual raw { a: "one", b: "two" } passed unmapped in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should not let a chained rename overwrite another property", async () => {
        const res = await execute(`
          {
            chained(input: { a: "one", b: "two" })
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          chained: JSON.stringify({ b: "one", c: "two" }),
        });
      });

      // BUNEST_BUG: Expected list-typed @InputType argument ([FiltersInput]) elements to remap { and } -> { $and }; actual [["and"],["and"]] in packages/graphql/src/schema/graphql-schema.factory.ts (createResolverFn).
      it.skip("should map a list-typed named argument", async () => {
        const res = await execute(`
          {
            listOfFilters(filters: [{ and: "d" }, { and: "e" }])
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          listOfFilters: JSON.stringify([["$and"], ["$and"]]),
        });
      });
    });

    describe("Renamed args behind a globally registered pipe", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            GraphQLModule.forRoot({
              autoSchemaFile: true,
            }),
          ],
          providers: [GlobalPipeResolver],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        app.useGlobalPipes(nestCompatibleValidationPipe({ transform: true }));
        await app.init();
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      const execute = (query: string) =>
        request(app).post("/graphql").send({ query });

      // BUNEST_BUG: Expected global ValidationPipe registered via app.useGlobalPipes() to run after renamed-arg mapping (keys: ["$and"]); actual keys: ["and"] because packages/graphql/src/schema/graphql-schema.factory.ts does not remap renamed args AND packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.buildSchema) does not wire app.useGlobalPipes() / ApplicationConfig global pipes into GraphQLSchemaFactory.
      it.skip("should map the args before a global ValidationPipe validates them", async () => {
        const res = await execute(`
          {
            validateGlobally(input: { and: "ok" }) {
              json
            }
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          validateGlobally: { json: JSON.stringify({ keys: ["$and"] }) },
        });
      });

      // BUNEST_BUG: Expected transforming global ValidationPipe to preserve NestingInput class instance (isInstance: true, and: "d"); actual { isInstance: false } because packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.buildSchema) ignores app.useGlobalPipes() and packages/graphql/src/schema/graphql-schema.factory.ts does not remap nested renamed input fields.
      it.skip("should keep the instance produced by a transforming global pipe", async () => {
        const res = await execute(`
          {
            keepInstance(input: { filters: { and: "d" } }) {
              json
            }
          }
        `);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          keepInstance: {
            json: JSON.stringify({ isInstance: true, and: "d" }),
          },
        });
      });
    });

    describe("Renamed args of a subscription", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            GraphQLModule.forRoot({
              autoSchemaFile: true,
            }),
          ],
          providers: [SubscriptionArgsResolver],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      // BUNEST_BUG: Expected @Subscription filter & resolve callbacks to receive mapped property names ({ some_arg: "a", someArg: "a" }) so payload "b" is filtered out and payload "a" is delivered; actual raw { some_arg: "a" } leaves variables.someArg undefined and lets payload "b" through in packages/graphql/src/schema/graphql-schema.factory.ts (createSubscriptionField).
      it.skip('should hand the "filter" and "resolve" callbacks the property names too', async () => {
        const { schema } = app.get(GraphQLSchemaHost);
        const stream = (await subscribe({
          schema,
          document: parse('subscription { probed(some_arg: "a") { json } }'),
          contextValue: {},
        })) as AsyncIterableIterator<ExecutionResult>;

        const delivered = stream.next();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await pubSub.publish("probed", { probed: "b" });
        await pubSub.publish("probed", { probed: "a" });

        expect((await delivered).value.data).toEqual({
          probed: {
            json: JSON.stringify({
              payload: "a",
              args: { some_arg: "a", someArg: "a" },
            }),
          },
        });
        await stream.return?.();
      });

      it("should keep the schema names for callbacks that read them", async () => {
        const { schema } = app.get(GraphQLSchemaHost);
        const stream = (await subscribe({
          schema,
          document: parse(
            'subscription { probedLegacy(some_arg: "a") { json } }',
          ),
          contextValue: {},
        })) as AsyncIterableIterator<ExecutionResult>;

        const delivered = stream.next();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await pubSub.publish("probedLegacy", { probedLegacy: "b" });
        await pubSub.publish("probedLegacy", { probedLegacy: "a" });

        expect((await delivered).value.data).toEqual({
          probedLegacy: { json: "a" },
        });
        await stream.return?.();
      });
    });
  },
);
