import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  type CanActivate,
  type DynamicModule,
  Injectable,
  Module,
  UseGuards,
  applyDecorators,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type Enhancer,
  Field,
  type FieldMiddleware,
  GraphQLModule,
  InterfaceType,
  ObjectType,
  Parent,
  PartialType,
  Query,
  ResolveField,
  Resolver,
  UseFieldMiddleware,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const executionLog: string[] = [];

const wrap =
  (name: string): FieldMiddleware =>
  async (_ctx, next) =>
    `${name}(${await next()})`;

const logged =
  (name: string): FieldMiddleware =>
  async (_ctx, next) => {
    executionLog.push(name);
    return next();
  };

@Injectable()
class LoggingGuard implements CanActivate {
  canActivate(): boolean {
    executionLog.push("guard");
    return true;
  }
}

function ComposedField() {
  return applyDecorators(Field(), UseFieldMiddleware(wrap("composed")));
}

@ObjectType()
class Item {
  @UseFieldMiddleware(wrap("above"))
  @Field()
  above!: string;

  @Field()
  @UseFieldMiddleware(wrap("below"))
  below!: string;

  @Field({ middleware: [wrap("option")] })
  @UseFieldMiddleware(wrap("first"), wrap("second"))
  combined!: string;

  @UseFieldMiddleware(wrap("upper"))
  @UseFieldMiddleware(wrap("lower"))
  @Field()
  stacked!: string;

  @ComposedField()
  composed!: string;

  // Also resolved by "ItemResolver.overridden()".
  @Field({ middleware: [wrap("option")] })
  @UseFieldMiddleware(wrap("decorator"))
  overridden!: string;

  @Field()
  plain!: string;
}

@ObjectType()
class PartialItem extends PartialType(Item, ObjectType) {}

@InterfaceType()
abstract class BaseItem {
  @Field({ middleware: [wrap("base")] })
  owner!: string;
}

@InterfaceType()
abstract class INamedItem extends BaseItem {
  @Field()
  name!: string;
}

@ObjectType({ implements: () => INamedItem })
class NamedItem extends INamedItem {}

const item = (): Item => ({
  above: "value",
  below: "value",
  combined: "value",
  stacked: "value",
  composed: "value",
  overridden: "value",
  plain: "value",
});

@InterfaceType()
abstract class Document {
  @Field({ middleware: [wrap("document")] })
  owner!: string;
}

@ObjectType({ implements: () => [Document] })
class Payslip implements Document {
  @Field({ middleware: [wrap("payslip")] })
  owner!: string;
}

@ObjectType({ implements: () => [Document] })
class Memo implements Document {
  owner!: string;
}

@Resolver(() => Document)
class DocumentResolver {
  @Query(() => Payslip)
  payslip(): Payslip {
    return { owner: "value" };
  }

  @Query(() => Memo)
  memo(): Memo {
    return { owner: "value" };
  }

  @ResolveField(() => String)
  @UseFieldMiddleware(wrap("resolver"))
  owner(@Parent() parent: Document): string {
    return parent.owner;
  }
}

@Resolver(() => Item)
class ItemResolver {
  @Query(() => Item)
  item(): Item {
    return item();
  }

  @Query(() => PartialItem)
  partialItem(): PartialItem {
    return item();
  }

  @Query(() => NamedItem)
  namedItem(): NamedItem {
    return { owner: "value", name: "value" };
  }

  @UseFieldMiddleware(wrap("above"))
  @ResolveField(() => String)
  resolvedAbove(@Parent() _parent: Item): string {
    return "value";
  }

  @ResolveField(() => String)
  @UseFieldMiddleware(wrap("below"))
  resolvedBelow(@Parent() _parent: Item): string {
    return "value";
  }

  @ResolveField(() => String, { middleware: [wrap("option")] })
  @UseFieldMiddleware(wrap("first"), wrap("second"))
  resolvedCombined(@Parent() _parent: Item): string {
    return "value";
  }

  @ResolveField(() => String)
  @UseFieldMiddleware(wrap("fast"))
  resolvedFast(): string {
    return "value";
  }

  @ResolveField()
  @UseFieldMiddleware(wrap("resolver"))
  overridden(@Parent() parent: Item): string {
    return parent.overridden;
  }

  @ResolveField(() => String)
  @UseGuards(LoggingGuard)
  @UseFieldMiddleware(logged("middleware"))
  resolvedGuarded(@Parent() _parent: Item): string {
    executionLog.push("resolver");
    return "value";
  }
}

interface FieldMiddlewareAppOptions {
  globalMiddleware?: boolean;
  fieldResolverEnhancers?: Enhancer[];
}

@Module({})
class FieldMiddlewareAppModule {
  static forRoot(options: FieldMiddlewareAppOptions = {}): DynamicModule {
    return {
      module: FieldMiddlewareAppModule,
      imports: [
        GraphQLModule.forRoot({
          autoSchemaFile: true,
          fieldResolverEnhancers: options.fieldResolverEnhancers,
          buildSchemaOptions: options.globalMiddleware
            ? { fieldMiddleware: [wrap("global")] }
            : undefined,
        }),
      ],
      providers: [ItemResolver, DocumentResolver, LoggingGuard],
    };
  }
}

async function createApp(
  options?: FieldMiddlewareAppOptions,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [FieldMiddlewareAppModule.forRoot(options)],
  }).compile({ logger: false });
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

async function query(app: BunestApplication, source: string) {
  const { body } = await request(app)
    .post("/graphql")
    .send({ query: source })
    .expect(200);
  expect(body.errors).toBeUndefined();
  return body.data;
}

describeConformance(
  "@UseFieldMiddleware()",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/code-first-field-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo @UseFieldMiddleware() E2E suite to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    describe("without global middleware", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await createApp();
      });

      afterAll(async () => {
        await app.close();
      });

      it("should apply middleware to property fields in any decorator order", async () => {
        const data = await query(
          app,
          "{ item { above below combined stacked composed plain } }",
        );
        expect(data.item).toEqual({
          above: "above(value)",
          below: "below(value)",
          combined: "option(first(second(value)))",
          stacked: "lower(upper(value))",
          composed: "composed(value)",
          plain: "value",
        });
      });

      it("should apply middleware to field resolvers in any decorator order", async () => {
        const data = await query(
          app,
          "{ item { resolvedAbove resolvedBelow resolvedCombined resolvedFast } }",
        );
        expect(data.item).toEqual({
          resolvedAbove: "above(value)",
          resolvedBelow: "below(value)",
          resolvedCombined: "option(first(second(value)))",
          resolvedFast: "fast(value)",
        });
      });

      it("should keep the middleware of a model field overridden by a field resolver", async () => {
        const data = await query(app, "{ item { overridden } }");
        expect(data.item.overridden).toBe("option(decorator(resolver(value)))");
      });

      it("should keep the middleware of a model field overridden by an interface field resolver", async () => {
        const data = await query(app, "{ payslip { owner } memo { owner } }");
        expect(data).toEqual({
          payslip: { owner: "payslip(resolver(value))" },
          memo: { owner: "document(resolver(value))" },
        });
      });

      it("should keep the middleware on fields copied by mapped types", async () => {
        const data = await query(
          app,
          "{ partialItem { above combined plain } }",
        );
        expect(data.partialItem).toEqual({
          above: "above(value)",
          combined: "option(first(second(value)))",
          plain: "value",
        });
      });

      it("should apply middleware to fields inherited from interface classes", async () => {
        const data = await query(app, "{ namedItem { owner name } }");
        expect(data.namedItem).toEqual({
          owner: "base(value)",
          name: "value",
        });
      });
    });

    describe("with global middleware and field resolver guards", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await createApp({
          globalMiddleware: true,
          fieldResolverEnhancers: ["guards"],
        });
      });

      afterAll(async () => {
        await app.close();
      });

      beforeEach(() => {
        executionLog.length = 0;
      });

      it("should run global middleware first", async () => {
        const data = await query(
          app,
          "{ item { combined plain resolvedCombined resolvedFast } }",
        );
        expect(data.item).toEqual({
          combined: "global(option(first(second(value))))",
          plain: "global(value)",
          resolvedCombined: "global(option(first(second(value))))",
          resolvedFast: "global(fast(value))",
        });
      });

      it("should run global middleware on fields inherited from interface classes", async () => {
        const data = await query(app, "{ namedItem { owner name } }");
        expect(data.namedItem).toEqual({
          owner: "global(base(value))",
          name: "global(value)",
        });
      });

      it("should run the global middleware, then the model field middleware, then the field resolver middleware, once each", async () => {
        const data = await query(
          app,
          "{ item { overridden } payslip { owner } memo { owner } }",
        );
        expect(data).toEqual({
          item: { overridden: "global(option(decorator(resolver(value))))" },
          payslip: { owner: "global(payslip(resolver(value)))" },
          memo: { owner: "global(document(resolver(value)))" },
        });
      });

      it("should run field middleware before field resolver enhancers", async () => {
        const data = await query(app, "{ item { resolvedGuarded } }");
        expect(data.item.resolvedGuarded).toBe("global(value)");
        expect(executionLog).toEqual(["middleware", "guard", "resolver"]);
      });
    });

    describe("schema first", () => {
      @Resolver("Book")
      class BookResolver {
        @Query(() => Object, { name: "book" })
        book() {
          return {};
        }

        @ResolveField("title")
        @UseFieldMiddleware(wrap("schema-first"))
        title() {
          return "value";
        }
      }

      @Module({
        imports: [
          GraphQLModule.forRoot({
            typeDefs: "type Book { title: String! } type Query { book: Book! }",
          }),
        ],
        providers: [BookResolver],
      })
      class SchemaFirstModule {}

      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [SchemaFirstModule],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterAll(async () => {
        await app.close();
      });

      it("should apply middleware to field resolvers", async () => {
        const data = await query(app, "{ book { title } }");
        expect(data.book.title).toBe("schema-first(value)");
      });
    });
  },
);
