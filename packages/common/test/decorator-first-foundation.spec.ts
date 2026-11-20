import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  AutoModule,
  ClassSerializerInterceptor,
  Column,
  Controller,
  CreateDateColumn,
  DecoratorRegistry,
  Entity,
  Get,
  Header,
  HttpCode,
  Index,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  Param,
  Post,
  PrimaryGeneratedColumn,
  PrimaryKey,
  SetMetadata,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
  Unique,
  UpdateDateColumn,
  UseGuards,
  UseMiddleware,
  ValidationPipe,
  Version,
  getEntityColumns,
  getEntityIndexes,
  getEntitySchema,
  getPrecompiledController,
  hasEntitySchema,
  invalidateControllerCache,
  type CanActivate,
  type DecoratorRegistrySnapshot,
} from "../src";

class DummyGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

class ExtraGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

describe("DecoratorRegistry", () => {
  let savedSnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    savedSnapshot = DecoratorRegistry.snapshot();
    DecoratorRegistry.clear();
  });

  afterEach(() => {
    DecoratorRegistry.restore(savedSnapshot);
  });

  it("self-registers @Controller, @Injectable, and @Entity classes at evaluation time", () => {
    @Entity("users")
    class UserEntity {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Injectable()
    class UserService {}

    @Controller("users")
    class UserController {
      @Get()
      list() {
        return [];
      }
    }

    expect(DecoratorRegistry.getEntities()).toEqual([UserEntity]);
    expect(DecoratorRegistry.getInjectables()).toEqual([UserService]);
    expect(DecoratorRegistry.getControllers()).toEqual([UserController]);
    expect(DecoratorRegistry.has("entity", UserEntity)).toBe(true);
    expect(DecoratorRegistry.has("injectable", UserService)).toBe(true);
    expect(DecoratorRegistry.has("controller", UserController)).toBe(true);
  });

  it("supports custom kinds with metadata, deduplication, snapshot/restore, and selective clear", () => {
    class RepoA {}
    class RepoB {}
    class SvcA {}

    DecoratorRegistry.register("repository", RepoA, {
      dialect: "sqlite",
      table: "users",
    });
    DecoratorRegistry.register("repository", RepoB, {
      dialect: "postgres",
      table: "orders",
    });
    // Re-registering updates meta without duplicating target
    DecoratorRegistry.register("repository", RepoA, {
      dialect: "sqlite",
      table: "app_users",
    });
    DecoratorRegistry.registerInjectable(SvcA);

    const repoEntries = DecoratorRegistry.getByKind<{
      dialect: string;
      table: string;
    }>("repository");
    expect(repoEntries).toHaveLength(2);
    expect(repoEntries[0]).toEqual({
      kind: "repository",
      target: RepoA,
      meta: { dialect: "sqlite", table: "app_users" },
    });
    expect(repoEntries[1]).toEqual({
      kind: "repository",
      target: RepoB,
      meta: { dialect: "postgres", table: "orders" },
    });
    expect(DecoratorRegistry.getTargetsByKind("repository")).toEqual([
      RepoA,
      RepoB,
    ]);
    expect(
      DecoratorRegistry.getMeta<{ dialect: string; table: string }>(
        "repository",
        RepoA,
      ),
    ).toEqual({ dialect: "sqlite", table: "app_users" });

    // Snapshot captures full state immutably
    const snap = DecoratorRegistry.snapshot();
    expect(snap.injectables).toEqual([SvcA]);
    expect(snap.byKind.repository).toHaveLength(2);

    // Clear only a single kind leaves other kinds untouched
    DecoratorRegistry.clear("repository");
    expect(DecoratorRegistry.getByKind("repository")).toEqual([]);
    expect(DecoratorRegistry.getInjectables()).toEqual([SvcA]);

    // Clear all wipes everything
    DecoratorRegistry.clear();
    expect(DecoratorRegistry.getInjectables()).toEqual([]);
    expect(DecoratorRegistry.getControllers()).toEqual([]);
    expect(DecoratorRegistry.getEntities()).toEqual([]);

    // Restore brings back exact state
    DecoratorRegistry.restore(snap);
    expect(DecoratorRegistry.getInjectables()).toEqual([SvcA]);
    expect(DecoratorRegistry.getTargetsByKind("repository")).toEqual([
      RepoA,
      RepoB,
    ]);
  });

  it("marks built-in @bunest/common injectables as internal so they never pollute user auto-discovery", () => {
    expect(DecoratorRegistry.isInternal(ValidationPipe)).toBe(true);
    expect(DecoratorRegistry.isInternal(StandardSchemaValidationPipe)).toBe(
      true,
    );
    expect(DecoratorRegistry.isInternal(ClassSerializerInterceptor)).toBe(true);
    expect(
      DecoratorRegistry.isInternal(StandardSchemaSerializerInterceptor),
    ).toBe(true);

    // Re-registering an internal class does not leak into public injectables
    DecoratorRegistry.registerInjectable(ValidationPipe);
    expect(DecoratorRegistry.getInjectables()).not.toContain(ValidationPipe);
  });
});

describe("Unified Entity Schema Decorators (@Entity, @PrimaryKey, @PrimaryGeneratedColumn, @Column, @Index, @Unique)", () => {
  let savedSnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    savedSnapshot = DecoratorRegistry.snapshot();
    DecoratorRegistry.clear();
  });

  afterEach(() => {
    DecoratorRegistry.restore(savedSnapshot);
  });

  it("auto-infers column types from TypeScript design:type and preserves constraints, timestamps, transformers, and indexes", () => {
    const lowerTransformer = {
      to: (v: string) => v.toLowerCase(),
      from: (v: string) => v,
    };

    class PlainDto {}

    @Entity("users")
    @Index(["tenantId", "status"], { name: "idx_users_tenant_status" })
    @Unique(["tenantId", "email"])
    class User {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ name: "tenant_id" })
      tenantId!: string;

      @Column({
        unique: true,
        minLength: 5,
        maxLength: 255,
        pattern: /^[^@]+@[^@]+$/,
        description: "User email address",
        example: "ada@example.com",
        transformer: lowerTransformer,
      })
      email!: string;

      @Column({ min: 0, max: 150, default: 18 })
      age!: number;

      @Column({ default: true })
      isActive!: boolean;

      @Column({ nullable: true })
      lastLoginAt!: Date | null;

      @Column({ nullable: true })
      metadata!: Record<string, unknown> | null;

      @Column()
      tags!: string[];

      @Column({ type: "real", min: 0 })
      score!: number;

      @Column({ enum: ["active", "suspended", "pending"] as const })
      @Index()
      status!: string;

      @Column()
      avatarBytes!: Uint8Array;

      @CreateDateColumn()
      createdAt!: Date;

      @UpdateDateColumn()
      updatedAt!: Date;
    }

    expect(hasEntitySchema(User)).toBe(true);
    expect(hasEntitySchema(PlainDto)).toBe(false);
    expect(getEntitySchema(PlainDto)).toBeUndefined();
    expect(MetadataRegistry.has(METADATA_KEYS.ENTITY_SCHEMA, User)).toBe(true);
    expect(MetadataRegistry.has(METADATA_KEYS.ENTITY_COLUMNS, User)).toBe(true);
    expect(MetadataRegistry.has(METADATA_KEYS.ENTITY_INDEXES, User)).toBe(true);

    const schema = getEntitySchema(User)!;
    expect(schema.tableName).toBe("users");
    expect(schema.name).toBe("users");
    expect(schema.target).toBe(User);
    expect(schema.primaryKey?.propertyName).toBe("id");
    expect(schema.primaryKey?.primary).toBe(true);
    expect(schema.primaryKey?.generated).toBe(true);
    expect(schema.primaryKey?.generationStrategy).toBe("increment");
    expect(schema.primaryKey?.type).toBe("integer");

    const byProp = new Map(schema.columns.map((c) => [c.propertyName, c]));

    // design:type auto-inference checks
    expect(byProp.get("tenantId")?.type).toBe("text");
    expect(byProp.get("tenantId")?.name).toBe("tenant_id");
    expect(byProp.get("email")?.type).toBe("text");
    expect(byProp.get("email")?.unique).toBe(true);
    expect(byProp.get("email")?.minLength).toBe(5);
    expect(byProp.get("email")?.maxLength).toBe(255);
    expect(byProp.get("email")?.pattern).toEqual(/^[^@]+@[^@]+$/);
    expect(byProp.get("email")?.description).toBe("User email address");
    expect(byProp.get("email")?.example).toBe("ada@example.com");
    expect(byProp.get("email")?.transformer?.to("ADA@EXAMPLE.COM")).toBe(
      "ada@example.com",
    );

    expect(byProp.get("age")?.type).toBe("integer");
    expect(byProp.get("age")?.min).toBe(0);
    expect(byProp.get("age")?.max).toBe(150);
    expect(byProp.get("age")?.hasDefault).toBe(true);
    expect(byProp.get("age")?.default).toBe(18);

    expect(byProp.get("isActive")?.type).toBe("boolean");
    expect(byProp.get("isActive")?.name).toBe("is_active");
    expect(byProp.get("isActive")?.default).toBe(true);

    expect(byProp.get("lastLoginAt")?.type).toBe("datetime");
    expect(byProp.get("lastLoginAt")?.nullable).toBe(true);
    expect(byProp.get("lastLoginAt")?.name).toBe("last_login_at");

    expect(byProp.get("metadata")?.type).toBe("json");
    expect(byProp.get("tags")?.type).toBe("json");
    expect(byProp.get("score")?.type).toBe("real");
    expect(byProp.get("status")?.enum).toEqual([
      "active",
      "suspended",
      "pending",
    ]);
    expect(byProp.get("avatarBytes")?.type).toBe("blob");

    // Timestamps
    expect(byProp.get("createdAt")?.type).toBe("datetime");
    expect(byProp.get("createdAt")?.createdAt).toBe(true);
    expect(byProp.get("createdAt")?.name).toBe("created_at");
    expect(byProp.get("updatedAt")?.type).toBe("datetime");
    expect(byProp.get("updatedAt")?.updatedAt).toBe(true);
    expect(byProp.get("updatedAt")?.name).toBe("updated_at");

    // Indexes (both property-level and composite class-level)
    const indexes = getEntityIndexes(User);
    expect(indexes).toEqual([
      { columns: ["status"], unique: false },
      { columns: ["tenant_id", "email"], unique: true },
      {
        name: "idx_users_tenant_status",
        columns: ["tenant_id", "status"],
        unique: false,
      },
    ]);
  });

  it("supports UUID @PrimaryGeneratedColumn, @PrimaryKey, property-level @Unique, and entity inheritance without mutating parent", () => {
    class BaseAuditEntity {
      @PrimaryGeneratedColumn("uuid")
      id!: string;

      @CreateDateColumn()
      createdAt!: Date;
    }

    @Entity()
    class ApiKey extends BaseAuditEntity {
      @Column()
      @Unique("uq_api_key_hash")
      keyHash!: string;
    }

    @Entity({ tableName: "composite_links", camelCaseMapping: false })
    class CompositeLink {
      @PrimaryKey({ type: "uuid" })
      orgId!: string;

      @PrimaryKey({ type: "uuid" })
      memberId!: string;
    }

    const apiKeySchema = getEntitySchema(ApiKey)!;
    expect(apiKeySchema.tableName).toBe("api_keys");
    expect(apiKeySchema.primaryKey?.type).toBe("uuid");
    expect(apiKeySchema.primaryKey?.generated).toBe(true);
    expect(apiKeySchema.primaryKey?.generationStrategy).toBe("uuid");
    expect(apiKeySchema.columns.map((c) => c.propertyName)).toEqual([
      "id",
      "createdAt",
      "keyHash",
    ]);
    expect(
      apiKeySchema.columns.find((c) => c.propertyName === "keyHash")?.unique,
    ).toBe(true);
    expect(apiKeySchema.indexes).toEqual([
      { name: "uq_api_key_hash", columns: ["key_hash"], unique: true },
    ]);

    // Parent class metadata was never mutated by child
    expect(getEntityColumns(BaseAuditEntity).map((c) => c.propertyName)).toEqual(
      ["id", "createdAt"],
    );

    // Composite primary keys with camelCaseMapping: false
    const linkSchema = getEntitySchema(CompositeLink)!;
    expect(linkSchema.tableName).toBe("composite_links");
    expect(linkSchema.primaryKeys.map((k) => k.name)).toEqual([
      "orgId",
      "memberId",
    ]);
  });

  it("throws when class-level @Index() is called with no columns", () => {
    expect(() => {
      @Index()
      class BadEntity {}
      return BadEntity;
    }).toThrow(/requires at least one column name/);
  });
});

describe("Decorator-Time Controller Pre-Indexing & Automatic Cache Invalidation", () => {
  it("pre-caches normalized descriptors on WeakMap and invalidates automatically on metadata mutations", () => {
    const mw = (_req: Request, _res: unknown, next: () => unknown) => next();

    @Controller("orders")
    @UseGuards(DummyGuard)
    @UseMiddleware(mw)
    @Version("1")
    class OrdersController {
      @Get(":id")
      @HttpCode(200)
      @Header("X-Cached", "yes")
      @SetMetadata("roles", ["reader"])
      findOne(@Param("id") id: string) {
        return { id };
      }

      @Post()
      @HttpCode(201)
      create() {
        return { created: true };
      }
    }

    @Controller("unrelated")
    class UnrelatedController {
      @Get()
      ping() {
        return "pong";
      }
    }

    const first = getPrecompiledController(OrdersController)!;
    const second = getPrecompiledController(OrdersController)!;
    const unrelatedFirst = getPrecompiledController(UnrelatedController)!;

    // Repeated reads return exact cached descriptor reference
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(first.paths).toEqual(["orders"]);
    expect(first.controllerVersion).toBe("1");
    expect(first.controllerGuards).toEqual([DummyGuard]);
    expect(first.controllerMiddlewares).toEqual([mw]);
    expect(first.routes).toHaveLength(2);
    expect(first.routes[0]?.handlerKey).toBe("findOne");
    expect(first.routes[0]?.parameters[0]).toMatchObject({
      index: 0,
      source: "param",
      key: "id",
      metatype: String,
    });
    expect(first.routes[0]?.headers).toEqual([
      { name: "X-Cached", value: "yes" },
    ]);

    // Mutating class metadata automatically invalidates OrdersController, NOT UnrelatedController
    MetadataRegistry.prependOwnArray(
      METADATA_KEYS.GUARDS,
      [ExtraGuard],
      OrdersController,
    );
    const afterClassMutation = getPrecompiledController(OrdersController)!;
    expect(afterClassMutation).not.toBe(first);
    expect(afterClassMutation.controllerGuards).toEqual([
      ExtraGuard,
      DummyGuard,
    ]);
    expect(getPrecompiledController(UnrelatedController)).toBe(unrelatedFirst);

    // Mutating handler metadata automatically invalidates
    MetadataRegistry.define(
      METADATA_KEYS.HTTP_CODE,
      202,
      OrdersController.prototype.findOne,
    );
    const afterHandlerMutation = getPrecompiledController(OrdersController)!;
    expect(afterHandlerMutation).not.toBe(afterClassMutation);
    expect(afterHandlerMutation.routes[0]?.httpCode).toBe(202);

    // Deleting handler metadata automatically invalidates
    MetadataRegistry.delete(
      METADATA_KEYS.HTTP_CODE,
      OrdersController.prototype.findOne,
    );
    const afterDelete = getPrecompiledController(OrdersController)!;
    expect(afterDelete).not.toBe(afterHandlerMutation);
    expect(afterDelete.routes[0]?.httpCode).toBeUndefined();

    // Manual invalidation helper also forces recompilation
    invalidateControllerCache(OrdersController);
    const afterManualInvalidate = getPrecompiledController(OrdersController)!;
    expect(afterManualInvalidate).not.toBe(afterDelete);
  });

  it("handles @UseGuards placed ABOVE @Controller via automatic invalidation", () => {
    @UseGuards(ExtraGuard)
    @Controller("above")
    class GuardAboveController {
      @Get()
      index() {
        return "ok";
      }
    }

    const compiled = getPrecompiledController(GuardAboveController)!;
    expect(compiled.controllerGuards).toEqual([ExtraGuard]);
    expect(compiled.paths).toEqual(["above"]);
  });

  it("supports @AutoModule and ModuleMetadata.autoDiscover without affecting plain @Module metadata shape", () => {
    @AutoModule()
    class DefaultAutoMod {}

    @AutoModule({
      autoDiscover: { controllers: true, providers: false },
    })
    class CustomAutoMod {}

    @Module({ providers: [] })
    class ExplicitMod {}

    expect(MetadataRegistry.get(METADATA_KEYS.MODULE, DefaultAutoMod)).toEqual({
      imports: undefined,
      controllers: undefined,
      providers: undefined,
      exports: undefined,
      autoDiscover: true,
    });

    expect(MetadataRegistry.get(METADATA_KEYS.MODULE, CustomAutoMod)).toEqual({
      imports: undefined,
      controllers: undefined,
      providers: undefined,
      exports: undefined,
      autoDiscover: { controllers: true, providers: false },
    });

    const explicitMeta = MetadataRegistry.get<Record<string, unknown>>(
      METADATA_KEYS.MODULE,
      ExplicitMod,
    )!;
    expect("autoDiscover" in explicitMeta).toBe(false);
  });
});
