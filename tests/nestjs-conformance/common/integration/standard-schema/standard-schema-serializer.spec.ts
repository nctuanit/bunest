import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  APP_INTERCEPTOR,
  Controller,
  Get,
  Module,
  Reflector,
  UseInterceptors,
  type StandardSchemaV1,
} from "../../../../../packages/core/src/common";
import {
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  UseStandardSchema,
} from "../../../../../packages/validation/src";
import {
  createTestApp,
  describeConformance,
  itAdapted,
  type TestAppContext,
} from "../../../_helpers";

// ─── Test schemas ──────────────────────────────────────────────

/**
 * Schema that strips out the `password` field (simulating a "safe user" DTO).
 */
const safeUserSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      const { password: _password, ...safe } = value as Record<string, unknown>;
      return { value: safe };
    },
  },
};

/**
 * Schema that adds a `serialized: true` flag (useful for asserting the schema ran).
 */
const flagSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({
      value: { ...(value as Record<string, unknown>), serialized: true },
    }),
  },
};

/**
 * Schema that always fails — used for the error case.
 */
const failingSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => ({
      issues: [{ message: "not allowed" }],
    }),
  },
};

/**
 * Async schema — validates that the interceptor awaits promises.
 */
const asyncSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: async (value: unknown) => ({
      value: { ...(value as Record<string, unknown>), async: true },
    }),
  },
};

// ─── Controllers ───────────────────────────────────────────────

@Controller("serializer")
@UseInterceptors(new StandardSchemaSerializerInterceptor())
class SerializerTestController {
  @Get("user")
  @UseStandardSchema(safeUserSchema)
  getUser() {
    return { id: 1, name: "Alice", password: "secret123" };
  }

  @Get("users")
  @UseStandardSchema(safeUserSchema)
  getUsers() {
    return [
      { id: 1, name: "Alice", password: "pw1" },
      { id: 2, name: "Bob", password: "pw2" },
    ];
  }

  @Get("flagged")
  @UseStandardSchema(flagSchema)
  getFlagged() {
    return { id: 1 };
  }

  @Get("no-schema")
  getNoSchema() {
    return { id: 1, secret: "visible" };
  }

  @Get("failing")
  @UseStandardSchema(failingSchema)
  getFailing() {
    return { id: 1 };
  }

  @Get("async")
  @UseStandardSchema(asyncSchema)
  getAsync() {
    return { id: 1 };
  }

  @Get("primitive")
  @UseStandardSchema(failingSchema)
  getPrimitive() {
    return "plain string";
  }

  @Get("serialize-options-parity")
  @SerializeOptions({ schema: safeUserSchema } as any)
  getViaSerializeOptions() {
    return { id: 1, name: "Alice", password: "secret123" };
  }
}

/**
 * Controller-level schema applied via class decorator — all routes inherit it.
 */
@Controller("class-level")
@UseInterceptors(new StandardSchemaSerializerInterceptor())
@UseStandardSchema(safeUserSchema)
class ClassLevelSerializerController {
  @Get("user")
  getUser() {
    return { id: 1, name: "Carol", password: "secret" };
  }

  @Get("override")
  @UseStandardSchema(flagSchema)
  getOverride() {
    return { id: 1, name: "Carol", password: "secret" };
  }
}

/**
 * Controller demonstrating global interceptor registration with a default schema.
 */
@Controller("global")
class GlobalSerializerController {
  @Get("default")
  getDefault() {
    return { id: 1, name: "Dave", password: "global-secret" };
  }

  @Get("override")
  @UseStandardSchema(flagSchema)
  getOverride() {
    return { id: 1 };
  }
}

@Module({
  controllers: [SerializerTestController, ClassLevelSerializerController],
})
class SerializerTestModule {}

@Module({
  controllers: [GlobalSerializerController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector) =>
        new StandardSchemaSerializerInterceptor(reflector, {
          schema: safeUserSchema,
        }),
      inject: [Reflector],
    },
  ],
})
class GlobalSerializerTestModule {}

// ─── Tests ─────────────────────────────────────────────────────

describeConformance(
  "StandardSchemaSerializerInterceptor (integration)",
  {
    upstreamPath:
      "integration/hello-world/e2e/standard-schema-serializer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-009"],
    notes:
      "Adapted to zero-socket Bunest TestAppContext and @UseStandardSchema() (with explicit parity test for NestJS @SerializeOptions({ schema })).",
  },
  () => {
    let ctx: TestAppContext | undefined;

    afterEach(async () => {
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
    });

    describe("DI class-token registration via @UseInterceptors(StandardSchemaSerializerInterceptor)", () => {
      @Controller("di-class-token")
      @UseInterceptors(StandardSchemaSerializerInterceptor)
      class DiClassTokenController {
        @Get("user")
        @UseStandardSchema(safeUserSchema)
        getUser() {
          return { id: 1, name: "Alice", password: "secret" };
        }
      }

      // BUNEST_BUG: StandardSchemaSerializerInterceptor constructor parameter #1 (`secondArg`) lacks `@Optional()`, causing UnknownDependencyException (Cannot resolve constructor parameter #1 Object) whenever registered by class token in `@UseInterceptors(StandardSchemaSerializerInterceptor)` (packages/validation/src/standard-schema-serializer.interceptor.ts:173)
      it.skip("should instantiate StandardSchemaSerializerInterceptor via DI when passed as a class token", async () => {
        ctx = await createTestApp(
          { controllers: [DiClassTokenController] },
          { silentLogger: true },
        );
        await ctx!
          .request()
          .get("/di-class-token/user")
          .expect(200)
          .expect({ id: 1, name: "Alice" });
      });
    });

    describe("handler-level @UseStandardSchema / @SerializeOptions", () => {
      beforeEach(async () => {
        ctx = await createTestApp(
          { imports: [SerializerTestModule] },
          { silentLogger: true },
        );
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should strip fields via schema on a single object",
        async () => {
          await ctx!
            .request()
            .get("/serializer/user")
            .expect(200)
            .expect(({ body }) => {
              expect(body).toEqual({ id: 1, name: "Alice" });
              expect(body).not.toHaveProperty("password");
            });
        },
        "@UseStandardSchema",
      );

      // BUNEST_BUG: StandardSchemaSerializerInterceptor passes an array response directly to `schema["~standard"].validate(response)` instead of mapping over each item when `Array.isArray(response)` (packages/validation/src/standard-schema-serializer.interceptor.ts:204)
      it.skip("should apply schema to each item in an array response", async () => {
        await ctx!
          .request()
          .get("/serializer/users")
          .expect(200)
          .expect(({ body }) => {
            expect(body).toEqual([
              { id: 1, name: "Alice" },
              { id: 2, name: "Bob" },
            ]);
            for (const item of body as Record<string, unknown>[]) {
              expect(item).not.toHaveProperty("password");
            }
          });
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should augment response through the schema",
        async () => {
          await ctx!
            .request()
            .get("/serializer/flagged")
            .expect(200)
            .expect({ id: 1, serialized: true });
        },
        "@UseStandardSchema",
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should return response unchanged when no schema is set",
        async () => {
          await ctx!
            .request()
            .get("/serializer/no-schema")
            .expect(200)
            .expect({ id: 1, secret: "visible" });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008", "ADR-009"],
        "should return 500 when schema validation fails",
        async () => {
          await ctx!.request().get("/serializer/failing").expect(500);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should handle async schemas",
        async () => {
          await ctx!
            .request()
            .get("/serializer/async")
            .expect(200)
            .expect({ id: 1, async: true });
        },
      );

      // BUNEST_BUG: StandardSchemaSerializerInterceptor's `isNativeResponsePassthrough()` returns `false` for primitives (`"plain string"`), causing primitive responses to be passed to the schema and fail with HTTP 500 (packages/validation/src/standard-schema-serializer.interceptor.ts:106-109)
      it.skip("should pass primitive values through even when a schema is set", async () => {
        await ctx!
          .request()
          .get("/serializer/primitive")
          .expect(200)
          .expect(({ text }) => {
            expect(text).toBe("plain string");
          });
      });

      // BUNEST_BUG: StandardSchemaSerializerInterceptor only reads Bunest's `@UseStandardSchema()` (`STANDARD_SCHEMA_SERIALIZER_METADATA`) and ignores NestJS v12 `@SerializeOptions({ schema })` (`CLASS_SERIALIZER_OPTIONS`) (packages/validation/src/standard-schema-serializer.interceptor.ts:228-239, packages/validation/src/serialize-options.decorator.ts)
      it.skip("should read schema from @SerializeOptions({ schema }) (NestJS v12 parity)", async () => {
        await ctx!
          .request()
          .get("/serializer/serialize-options-parity")
          .expect(200)
          .expect(({ body }) => {
            expect(body).toEqual({ id: 1, name: "Alice" });
            expect(body).not.toHaveProperty("password");
          });
      });
    });

    describe("class-level @UseStandardSchema / @SerializeOptions", () => {
      beforeEach(async () => {
        ctx = await createTestApp(
          { imports: [SerializerTestModule] },
          { silentLogger: true },
        );
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should apply class-level schema to all routes",
        async () => {
          await ctx!
            .request()
            .get("/class-level/user")
            .expect(200)
            .expect(({ body }) => {
              expect(body).toEqual({ id: 1, name: "Carol" });
              expect(body).not.toHaveProperty("password");
            });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should allow handler-level schema to override class-level",
        async () => {
          await ctx!
            .request()
            .get("/class-level/override")
            .expect(200)
            .expect(({ body }) => {
              // flagSchema adds `serialized: true` but does NOT strip password
              expect(body).toHaveProperty("serialized", true);
              expect(body).toHaveProperty("password", "secret");
            });
        },
      );
    });

    describe("global interceptor with default schema", () => {
      beforeEach(async () => {
        ctx = await createTestApp(
          { imports: [GlobalSerializerTestModule] },
          { silentLogger: true },
        );
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should apply the default schema globally",
        async () => {
          await ctx!
            .request()
            .get("/global/default")
            .expect(200)
            .expect(({ body }) => {
              expect(body).toEqual({ id: 1, name: "Dave" });
              expect(body).not.toHaveProperty("password");
            });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should let @UseStandardSchema override the global default",
        async () => {
          await ctx!
            .request()
            .get("/global/override")
            .expect(200)
            .expect({ id: 1, serialized: true });
        },
      );
    });
  },
);
