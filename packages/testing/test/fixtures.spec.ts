import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Injectable,
  Reflector,
  SetMetadata,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/common";
import {
  ClassSerializerInterceptor,
  SerializeOptions,
} from "@bunest/core";
import { Exclude, Expose } from "class-transformer";
import {
  Test,
  createMockCallHandler,
  createMockExecutionContext,
  createMockProvider,
  createMockRequest,
} from "../src";

const ROLES_KEY = Symbol.for("test:roles");
const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const role = req.headers.get("x-role") ?? "";
    return required.includes(role);
  }
}

class CacheShortCircuitInterceptor implements BunestInterceptor {
  constructor(private readonly cachedValue?: unknown) {}

  async intercept(
    _ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    if (this.cachedValue !== undefined) {
      return this.cachedValue;
    }
    const result = await next.handle();
    return { fresh: result };
  }
}

class SecretItem {
  @Expose()
  id!: string;

  @Exclude()
  secret!: string;

  @Expose({ groups: ["admin"] })
  audit!: string;
}

class FixtureController {
  @Roles("admin")
  @SerializeOptions({ groups: ["admin"] })
  adminAction(): SecretItem {
    return Object.assign(new SecretItem(), {
      id: "item_1",
      secret: "hidden",
      audit: "ok",
    });
  }
}

describe("Testing Fixtures (createMockRequest, createMockExecutionContext, createMockCallHandler, createMockProvider)", () => {
  it("constructs native Request objects with query, headers, cookies, and JSON body", async () => {
    const req = createMockRequest("/items", {
      method: "POST",
      query: { filter: "active", ids: [1, 2] },
      headers: { "X-Api-Key": "k_123" },
      cookies: { theme: "dark" },
      json: { name: "Widget" },
    });

    expect(req).toBeInstanceOf(Request);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://bunest.test/items?filter=active&ids=1&ids=2");
    expect(req.headers.get("x-api-key")).toBe("k_123");
    expect(req.headers.get("cookie")).toBe("theme=dark");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.json()).toEqual({ name: "Widget" });
  });

  it("unit-tests guards and ClassSerializerInterceptor in isolation via createMockExecutionContext", async () => {
    const guard = new RolesGuard(new Reflector());

    const forbiddenCtx = createMockExecutionContext({
      controllerClass: FixtureController,
      handlerKey: "adminAction",
      request: createMockRequest("/admin", { headers: { "x-role": "guest" } }),
    });
    expect(guard.canActivate(forbiddenCtx)).toBe(false);

    const allowedCtx = createMockExecutionContext({
      controllerClass: FixtureController,
      handlerKey: "adminAction",
      request: createMockRequest("/admin", { headers: { "x-role": "admin" } }),
    });
    expect(guard.canActivate(allowedCtx)).toBe(true);

    // Serializer interceptor reads @SerializeOptions metadata from FixtureController.adminAction
    const serializer = new ClassSerializerInterceptor();
    const callHandler = createMockCallHandler(() =>
      new FixtureController().adminAction(),
    );
    const out = await serializer.intercept(allowedCtx, callHandler);
    expect(callHandler.called).toBe(true);
    expect(callHandler.callCount).toBe(1);
    expect(out).toEqual({ id: "item_1", audit: "ok" });
  });

  it("tracks invocation counts in createMockCallHandler for short-circuit vs passthrough interceptors", async () => {
    const ctx = createMockExecutionContext();

    const shortCircuitHandler = createMockCallHandler({ value: 42 });
    const cachedInterceptor = new CacheShortCircuitInterceptor({ cached: true });
    expect(await cachedInterceptor.intercept(ctx, shortCircuitHandler)).toEqual({
      cached: true,
    });
    expect(shortCircuitHandler.called).toBe(false);
    expect(shortCircuitHandler.callCount).toBe(0);

    const passHandler = createMockCallHandler(async () => {
      await Bun.sleep(1);
      return "live";
    });
    const freshInterceptor = new CacheShortCircuitInterceptor();
    expect(await freshInterceptor.intercept(ctx, passHandler)).toEqual({
      fresh: "live",
    });
    expect(passHandler.called).toBe(true);
    expect(passHandler.callCount).toBe(1);
  });

  it("builds typed ValueProviders via createMockProvider", async () => {
    interface Mailer {
      send(to: string): string;
    }
    const MAILER = Symbol("MAILER");

    const mod = await Test.createTestingModule({
      providers: [
        createMockProvider<Mailer>(MAILER, {
          send: (to: string) => `mock-sent:${to}`,
        }),
      ],
    }).compile();

    const mailer = mod.get<Mailer>(MAILER);
    expect(mailer.send("a@b.com")).toBe("mock-sent:a@b.com");
    await mod.close();
  });
});
