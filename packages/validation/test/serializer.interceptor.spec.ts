import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  Reflector,
  type CallHandler,
  type ExecutionContext,
  type Type,
} from "@bunest/common";
import { Exclude, Expose, Transform } from "class-transformer";
import {
  CLASS_SERIALIZER_OPTIONS,
  ClassSerializerInterceptor,
  SerializeOptions,
} from "../src";

class UserEntity {
  id: string;
  email: string;
  firstName: string;
  lastName: string;

  @Exclude()
  passwordHash: string;

  @Expose({ groups: ["admin"] })
  internalNotes: string;

  @Transform(({ value }) =>
    typeof value === "string" ? value.toUpperCase() : value,
  )
  role: string;

  @Expose()
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  constructor(partial: Partial<UserEntity> = {}) {
    this.id = partial.id ?? "";
    this.email = partial.email ?? "";
    this.firstName = partial.firstName ?? "";
    this.lastName = partial.lastName ?? "";
    this.passwordHash = partial.passwordHash ?? "";
    this.internalNotes = partial.internalNotes ?? "";
    this.role = partial.role ?? "user";
  }
}

@Exclude()
class StrictProfileEntity {
  @Expose()
  id!: string;

  @Expose({ groups: ["public", "admin"] })
  username!: string;

  @Expose({ groups: ["admin"] })
  auditTrail!: string;

  secretToken!: string;
}

class PlainController {
  getUser(): UserEntity {
    return new UserEntity({
      id: "u_1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Nguyen",
      passwordHash: "bcrypt$secret",
      internalNotes: "vip-flag",
      role: "member",
    });
  }
}

@SerializeOptions({ groups: ["public"], excludePrefixes: ["_"] })
class AnnotatedController {
  getPublic(): StrictProfileEntity {
    return Object.assign(new StrictProfileEntity(), {
      id: "p_1",
      username: "alice",
      auditTrail: "created-by-root",
      secretToken: "tok_secret",
    });
  }

  @SerializeOptions({ groups: ["admin"] })
  getAdmin(): StrictProfileEntity {
    return Object.assign(new StrictProfileEntity(), {
      id: "p_1",
      username: "alice",
      auditTrail: "created-by-root",
      secretToken: "tok_secret",
    });
  }

  @SerializeOptions({ type: UserEntity })
  getPlainAsEntity(): Record<string, unknown> {
    return {
      id: "u_2",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "Tran",
      passwordHash: "must-be-stripped",
      internalNotes: "admin-only",
      role: "editor",
    };
  }
}

function createMockContext(
  controllerClass: Type<unknown>,
  handlerName: string,
): ExecutionContext {
  const handler = (controllerClass.prototype as Record<string, Function>)[
    handlerName
  ]!;
  return {
    getClass: <T = unknown>() => controllerClass as Type<T>,
    getHandler: () => handler,
    getHandlerKey: () => handlerName,
    getArgs: () => [] as never,
    getArgByIndex: () => undefined as never,
    switchToHttp: () => ({
      getRequest: () => new Request("http://localhost/") as never,
      getResponse: () => ({}) as never,
      getNext: () => (() => undefined) as never,
    }),
    switchToRpc: () => ({
      getData: () => undefined as never,
      getContext: () => undefined as never,
    }),
    switchToWs: () => ({
      getData: () => undefined as never,
      getClient: () => undefined as never,
      getPattern: () => "",
    }),
    getType: () => "http" as never,
  };
}

function callHandlerReturning<T>(value: T): CallHandler<T> {
  return {
    handle: async () => value,
  };
}

describe("ClassSerializerInterceptor & @SerializeOptions()", () => {
  it("strips @Exclude() fields, includes @Expose() getters, and runs @Transform()", async () => {
    const interceptor = new ClassSerializerInterceptor();
    const ctx = createMockContext(PlainController, "getUser");
    const entity = new PlainController().getUser();

    const result = (await interceptor.intercept(
      ctx,
      callHandlerReturning(entity),
    )) as Record<string, unknown>;

    expect(result).not.toBeInstanceOf(UserEntity);
    expect(result.id).toBe("u_1");
    expect(result.email).toBe("alice@example.com");
    expect(result.fullName).toBe("Alice Nguyen");
    expect(result.role).toBe("MEMBER");
    expect(result.passwordHash).toBeUndefined();
    expect("passwordHash" in result).toBe(false);
    // Group-restricted property is hidden when "admin" group is not active
    expect("internalNotes" in result).toBe(false);
  });

  it("serializes arrays of entities and nested entities inside plain envelopes", async () => {
    const interceptor = new ClassSerializerInterceptor();
    const ctx = createMockContext(PlainController, "getUser");
    const u1 = new PlainController().getUser();
    const u2 = new UserEntity({
      id: "u_2",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "Le",
      passwordHash: "secret2",
      role: "admin",
    });

    const arrResult = (await interceptor.intercept(
      ctx,
      callHandlerReturning([u1, u2]),
    )) as Array<Record<string, unknown>>;

    expect(arrResult).toHaveLength(2);
    expect(arrResult[0]?.passwordHash).toBeUndefined();
    expect(arrResult[1]?.passwordHash).toBeUndefined();
    expect(arrResult[1]?.role).toBe("ADMIN");

    const wrappedResult = (await interceptor.intercept(
      ctx,
      callHandlerReturning({ data: u1, items: [u2], meta: { total: 2 } }),
    )) as {
      data: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
      meta: { total: number };
    };

    expect(wrappedResult.data.passwordHash).toBeUndefined();
    expect(wrappedResult.data.fullName).toBe("Alice Nguyen");
    expect(wrappedResult.items[0]?.passwordHash).toBeUndefined();
    expect(wrappedResult.meta).toEqual({ total: 2 });
  });

  it("applies class-level and method-level @SerializeOptions() with method precedence", async () => {
    const interceptor = new ClassSerializerInterceptor(new Reflector());

    const publicCtx = createMockContext(AnnotatedController, "getPublic");
    const publicProfile = new AnnotatedController().getPublic();
    const publicOut = (await interceptor.intercept(
      publicCtx,
      callHandlerReturning(publicProfile),
    )) as Record<string, unknown>;

    expect(publicOut).toEqual({
      id: "p_1",
      username: "alice",
    });

    const adminCtx = createMockContext(AnnotatedController, "getAdmin");
    const adminProfile = new AnnotatedController().getAdmin();
    const adminOut = (await interceptor.intercept(
      adminCtx,
      callHandlerReturning(adminProfile),
    )) as Record<string, unknown>;

    expect(adminOut).toEqual({
      id: "p_1",
      username: "alice",
      auditTrail: "created-by-root",
    });
  });

  it("supports @SerializeOptions({ type }) to serialize plain objects through a target class", async () => {
    const interceptor = new ClassSerializerInterceptor();
    const ctx = createMockContext(AnnotatedController, "getPlainAsEntity");
    const plain = new AnnotatedController().getPlainAsEntity();

    const out = (await interceptor.intercept(
      ctx,
      callHandlerReturning(plain),
    )) as Record<string, unknown>;

    expect(out.id).toBe("u_2");
    expect(out.fullName).toBe("Bob Tran");
    expect(out.role).toBe("EDITOR");
    expect("passwordHash" in out).toBe(false);
    expect("internalNotes" in out).toBe(false);
  });

  it("supports constructor default options and DI metadata", async () => {
    const interceptor = new ClassSerializerInterceptor({ groups: ["admin"] });
    const ctx = createMockContext(PlainController, "getUser");
    const out = (await interceptor.intercept(
      ctx,
      callHandlerReturning(new PlainController().getUser()),
    )) as Record<string, unknown>;

    expect(out.internalNotes).toBe("vip-flag");
    expect("passwordHash" in out).toBe(false);

    // Verify DI tokens for @bunest/core container resolution
    expect(
      MetadataRegistry.has(METADATA_KEYS.INJECTABLE, ClassSerializerInterceptor),
    ).toBe(true);
    const injectTokens = MetadataRegistry.getInjectTokens(
      ClassSerializerInterceptor,
    );
    expect(injectTokens).toEqual([
      { index: 0, token: Reflector },
      { index: 1, token: CLASS_SERIALIZER_OPTIONS },
    ]);
    expect(MetadataRegistry.getOptionalDeps(ClassSerializerInterceptor)).toEqual(
      [0, 1],
    );
  });

  it("passes through native Response, ReadableStream, Blob/BunFile, Uint8Array, AsyncIterable, and primitives untouched", async () => {
    const interceptor = new ClassSerializerInterceptor();
    const ctx = createMockContext(PlainController, "getUser");

    const nativeResponse = new Response("raw-body", { status: 202 });
    expect(
      await interceptor.intercept(ctx, callHandlerReturning(nativeResponse)),
    ).toBe(nativeResponse);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    expect(await interceptor.intercept(ctx, callHandlerReturning(stream))).toBe(
      stream,
    );

    const blob = new Blob(["hello"], { type: "text/plain" });
    expect(await interceptor.intercept(ctx, callHandlerReturning(blob))).toBe(
      blob,
    );

    const bunFile = Bun.file(import.meta.path);
    expect(
      await interceptor.intercept(ctx, callHandlerReturning(bunFile)),
    ).toBe(bunFile);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await interceptor.intercept(ctx, callHandlerReturning(bytes))).toBe(
      bytes,
    );

    const arrayBuffer = new ArrayBuffer(8);
    expect(
      await interceptor.intercept(ctx, callHandlerReturning(arrayBuffer)),
    ).toBe(arrayBuffer);

    async function* sseGenerator() {
      yield { data: "ping" };
    }
    const gen = sseGenerator();
    expect(await interceptor.intercept(ctx, callHandlerReturning(gen))).toBe(
      gen,
    );

    for (const primitive of [null, undefined, "plain text", 42, true, false]) {
      expect(
        await interceptor.intercept(ctx, callHandlerReturning(primitive)),
      ).toBe(primitive);
    }
  });
});
