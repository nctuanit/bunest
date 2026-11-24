import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  createParamDecorator,
  type ArgumentMetadata,
  type ExecutionContext,
  type PipeTransform,
  type StandardSchemaV1,
} from "../../../../../packages/core/src/common";
import {
  createTestApp,
  describeConformance,
  itAdapted,
  type TestAppContext,
} from "../../../_helpers";

const testSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

type SchemaAwareArgumentMetadata = ArgumentMetadata & {
  schema?: StandardSchemaV1;
};

/**
 * A pipe that captures the ArgumentMetadata it receives,
 * so the test can verify that `schema` is propagated.
 */
@Injectable()
class SchemaCaptorPipe implements PipeTransform {
  static lastMetadata: SchemaAwareArgumentMetadata | undefined;

  transform(value: unknown, metadata: ArgumentMetadata) {
    SchemaCaptorPipe.lastMetadata = metadata as SchemaAwareArgumentMetadata;
    return value;
  }
}

// ADR-001: Native Web Request exposes query params via `new URL(req.url).searchParams`
const CustomParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return Object.fromEntries(new URL(req.url).searchParams.entries());
  },
);

const CustomData = createParamDecorator((data: unknown) => data ?? null);

@Controller("schema-test")
class SchemaTestController {
  @Post("body")
  bodyWithSchema(
    @Body({ schema: testSchema, pipes: [SchemaCaptorPipe] })
    body: unknown,
  ) {
    return { received: body };
  }

  @Get("query")
  queryWithSchema(
    @Query({ schema: testSchema, pipes: [SchemaCaptorPipe] })
    query: unknown,
  ) {
    return { received: query };
  }

  @Get("param/:id")
  paramWithSchema(
    @Param("id", { schema: testSchema, pipes: [SchemaCaptorPipe] })
    id: string,
  ) {
    return { received: id };
  }

  @Get("custom")
  customWithSchema(
    @CustomParam({ schema: testSchema, pipes: [SchemaCaptorPipe] } as any)
    value: unknown,
  ) {
    return { received: value };
  }

  @Get("custom-schema-data")
  customWithSchemaData(
    @CustomData({ schema: "public", region: "eu" }) value: unknown,
  ) {
    return { received: value };
  }

  @Get("custom-pipes-data")
  customWithPipesData(
    @CustomData({ pipes: ["stage1", "stage2"], region: "eu" }) value: unknown,
  ) {
    return { received: value };
  }

  @Post("body-property")
  bodyPropertyWithSchema(
    @Body("name", { schema: testSchema, pipes: [SchemaCaptorPipe] })
    name: string,
  ) {
    return { received: name };
  }
}

@Module({
  controllers: [SchemaTestController],
  providers: [SchemaCaptorPipe],
})
class SchemaTestModule {}

describeConformance(
  "Schema propagation to pipes",
  {
    upstreamPath: "integration/hello-world/e2e/schema-in-pipes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-004"],
    notes:
      "Adapted from Express/supertest loopback server to zero-socket Bunest TestAppContext and Web Request URL query extraction.",
  },
  () => {
    let ctx: TestAppContext;

    beforeAll(async () => {
      ctx = await createTestApp(
        { imports: [SchemaTestModule] },
        { silentLogger: true },
      );
    });

    beforeEach(() => {
      SchemaCaptorPipe.lastMetadata = undefined;
    });

    afterAll(async () => {
      await ctx.close();
    });

    it("should pass schema to pipe via @Body(options)", async () => {
      await ctx
        .request()
        .post("/schema-test/body")
        .send({ name: "test" })
        .expect(201);

      expect(SchemaCaptorPipe.lastMetadata).toBeDefined();
      expect(SchemaCaptorPipe.lastMetadata!.schema).toBe(testSchema);
      expect(SchemaCaptorPipe.lastMetadata!.type).toBe("body");
    });

    it("should pass schema to pipe via @Query(options)", async () => {
      await ctx.request().get("/schema-test/query?user=john").expect(200);

      expect(SchemaCaptorPipe.lastMetadata).toBeDefined();
      expect(SchemaCaptorPipe.lastMetadata!.schema).toBe(testSchema);
      expect(SchemaCaptorPipe.lastMetadata!.type).toBe("query");
    });

    it("should pass schema to pipe via @Param(property, options)", async () => {
      await ctx
        .request()
        .get("/schema-test/param/42")
        .expect(200)
        .expect({ received: "42" });

      expect(SchemaCaptorPipe.lastMetadata).toBeDefined();
      expect(SchemaCaptorPipe.lastMetadata!.schema).toBe(testSchema);
      expect(SchemaCaptorPipe.lastMetadata!.type).toBe("param");
      expect(SchemaCaptorPipe.lastMetadata!.data).toBe("id");
    });

    // BUNEST_BUG: createParamDecorator() does not parse `{ schema, pipes }` options objects (packages/core/src/common/decorators/params.decorators.ts:296-331), and compileParameters() does not propagate `schema` onto ArgumentMetadata (packages/core/src/http/pipeline/param-extractor.ts)
    it.skip("should pass schema to pipe via createParamDecorator(options)", async () => {
      await ctx.request().get("/schema-test/custom?key=val").expect(200);

      expect(SchemaCaptorPipe.lastMetadata).toBeDefined();
      expect(SchemaCaptorPipe.lastMetadata!.schema).toBe(testSchema);
      expect(SchemaCaptorPipe.lastMetadata!.type).toBe("custom");
    });

    itAdapted(
      "ADR-001",
      "should pass custom data with a schema property to the factory",
      async () => {
        await ctx
          .request()
          .get("/schema-test/custom-schema-data")
          .expect(200)
          .expect({ received: { schema: "public", region: "eu" } });
      },
      "zero-socket request(app)",
    );

    itAdapted(
      "ADR-001",
      "should pass custom data with a pipes property to the factory",
      async () => {
        await ctx
          .request()
          .get("/schema-test/custom-pipes-data")
          .expect(200)
          .expect({ received: { pipes: ["stage1", "stage2"], region: "eu" } });
      },
      "zero-socket request(app)",
    );

    it("should pass schema to pipe via @Body(property, options)", async () => {
      await ctx
        .request()
        .post("/schema-test/body-property")
        .send({ name: "Alice" })
        .expect(201)
        .expect({ received: "Alice" });

      expect(SchemaCaptorPipe.lastMetadata).toBeDefined();
      expect(SchemaCaptorPipe.lastMetadata!.schema).toBe(testSchema);
      expect(SchemaCaptorPipe.lastMetadata!.type).toBe("body");
      expect(SchemaCaptorPipe.lastMetadata!.data).toBe("name");
    });
  },
);
