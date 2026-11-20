import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Header,
  HttpCode,
  METADATA_KEYS,
  MetadataRegistry,
  Reflector,
  SetMetadata,
  UseGuards,
  UseMiddleware,
  createMethodAspectDecorator,
  getMethodAspects,
  hasMethodAspects,
  wrapMethodDescriptor,
  type CanActivate,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "../src";

class SampleGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

describe("MetadataRegistry utilities & wrapMethodDescriptor", () => {
  it("copyMetadata copies own metadata keys without overwriting existing target keys", () => {
    const SYM_A = Symbol("a");
    const SYM_B = Symbol("b");
    const src = function sourceFn() {};
    const dst = function targetFn() {};

    MetadataRegistry.define("k1", "from-src", src);
    MetadataRegistry.define(SYM_A, [1, 2], src);
    MetadataRegistry.define(SYM_B, "src-b", src);
    MetadataRegistry.define(SYM_B, "dst-b-wins", dst);

    MetadataRegistry.copyMetadata(src, dst);

    expect(MetadataRegistry.getOwn("k1", dst)).toBe("from-src");
    expect(MetadataRegistry.getOwn(SYM_A, dst)).toEqual([1, 2]);
    // Existing key on target must NOT be overwritten
    expect(MetadataRegistry.getOwn(SYM_B, dst)).toBe("dst-b-wins");
  });

  it("getMergedMethodArray merges method metadata along inheritance chain safely without mutating parent", () => {
    const KEY = Symbol("test:methods");

    class Base {
      foo() {}
      bar() {}
    }
    class Child extends Base {
      override foo() {}
      baz() {}
    }

    MetadataRegistry.define(
      KEY,
      [
        { methodName: "foo", tag: "base-foo" },
        { methodName: "bar", tag: "base-bar" },
      ],
      Base,
    );
    MetadataRegistry.define(
      KEY,
      [
        { methodName: "foo", tag: "child-foo-1" },
        { methodName: "foo", tag: "child-foo-2" },
        { methodName: "baz", tag: "child-baz" },
      ],
      Child,
    );

    const baseMerged = MetadataRegistry.getMergedMethodArray<{
      methodName: string;
      tag: string;
    }>(KEY, Base, "methodName");
    const childMerged = MetadataRegistry.getMergedMethodArray<{
      methodName: string;
      tag: string;
    }>(KEY, Child); // default keyProp detects methodName

    expect(baseMerged).toEqual([
      { methodName: "foo", tag: "base-foo" },
      { methodName: "bar", tag: "base-bar" },
    ]);
    expect(childMerged).toEqual([
      { methodName: "foo", tag: "child-foo-1" },
      { methodName: "foo", tag: "child-foo-2" },
      { methodName: "bar", tag: "base-bar" },
      { methodName: "baz", tag: "child-baz" },
    ]);

    // Returned objects are shallow clones, never mutating stored metadata
    childMerged[0]!.tag = "mutated";
    expect(
      MetadataRegistry.getMergedMethodArray<{ methodName: string; tag: string }>(
        KEY,
        Child,
        "methodName",
      )[0]!.tag,
    ).toBe("child-foo-1");
  });

  it("wrapMethodDescriptor preserves .name, .length, this binding, and all metadata when placed above HTTP decorators", () => {
    const calls: string[] = [];

    function Trace(): MethodDecorator {
      return (_target, propertyKey, descriptor) =>
        wrapMethodDescriptor(descriptor, (original) => {
          return function (this: unknown, ...args: unknown[]) {
            calls.push(`before:${String(propertyKey)}`);
            const res = original.apply(this, args);
            calls.push(`after:${String(propertyKey)}`);
            return res;
          };
        });
    }

    @Controller("/wrapped")
    class WrappedController {
      prefix = "ok";

      @Trace()
      @Get("item/:id")
      @HttpCode(202)
      @Header("X-Wrapped", "true")
      @UseGuards(SampleGuard)
      @SetMetadata("roles", ["admin"])
      findOne(id: string, flag: boolean) {
        return `${this.prefix}:${id}:${flag}`;
      }
    }

    const fn = WrappedController.prototype.findOne;
    expect(fn.name).toBe("findOne");
    expect(fn.length).toBe(2);
    expect(MetadataRegistry.get(METADATA_KEYS.ROUTE_METHOD, fn)).toBe("GET");
    expect(MetadataRegistry.get(METADATA_KEYS.ROUTE_PATH, fn)).toBe("item/:id");
    expect(MetadataRegistry.get(METADATA_KEYS.HTTP_CODE, fn)).toBe(202);
    expect(MetadataRegistry.getHeaders(fn)).toEqual([
      { name: "X-Wrapped", value: "true" },
    ]);
    expect(MetadataRegistry.get(METADATA_KEYS.GUARDS, fn)).toEqual([
      SampleGuard,
    ]);
    expect(MetadataRegistry.get("roles", fn)).toEqual(["admin"]);

    const instance = new WrappedController();
    expect(instance.findOne("42", true)).toBe("ok:42:true");
    expect(calls).toEqual(["before:findOne", "after:findOne"]);
  });
});

describe("Reflector.getAllAndMerge inheritance fix (C4)", () => {
  const reflector = new Reflector();

  it("merges array and object metadata along class inheritance chain when subclass defines own metadata", () => {
    const Roles = Reflector.createDecorator<string[]>();
    const Config = Reflector.createDecorator<Record<string, unknown>>();
    const Public = Reflector.createDecorator<boolean>();

    @Roles(["base-role"])
    @Config({ timeout: 1000, retries: 1, baseOnly: true })
    @Public(false)
    class BaseCtrl {
      action() {}
    }

    @Roles(["sub-role"])
    @Config({ retries: 3, subOnly: true })
    @Public(true)
    class SubCtrl extends BaseCtrl {
      @Roles(["method-role"])
      @Config({ retries: 5 })
      override action() {}
    }

    const handler = SubCtrl.prototype.action;

    // Single class target merges Base -> Sub
    expect(reflector.getAllAndMerge(Roles, [SubCtrl])).toEqual([
      "base-role",
      "sub-role",
    ]);
    expect(reflector.getAllAndMerge(Config, [SubCtrl])).toEqual({
      timeout: 1000,
      retries: 3,
      baseOnly: true,
      subOnly: true,
    });

    // Class + handler target merges Base -> Sub -> handler
    expect(reflector.getAllAndMerge(Roles, [SubCtrl, handler])).toEqual([
      "base-role",
      "sub-role",
      "method-role",
    ]);
    expect(reflector.getAllAndMerge(Config, [SubCtrl, handler])).toEqual({
      timeout: 1000,
      retries: 5,
      baseOnly: true,
      subOnly: true,
    });

    // Explicit [BaseCtrl, SubCtrl] does NOT duplicate BaseCtrl metadata
    expect(reflector.getAllAndMerge(Roles, [BaseCtrl, SubCtrl])).toEqual([
      "base-role",
      "sub-role",
    ]);

    // Non-mergeable primitives along inheritance chain still yield derived value
    expect(reflector.getAllAndMerge(Public, [SubCtrl])).toBe(true);

    // Base class metadata remains completely untouched
    expect(reflector.get(Roles, BaseCtrl)).toEqual(["base-role"]);
  });
});

describe("Method Aspect metadata contract & @UseMiddleware", () => {
  it("records stacked, ordered, class-level, and inherited method aspects cleanly", () => {
    const ASPECT_A = Symbol("ASPECT_A");
    const ASPECT_B = Symbol("ASPECT_B");
    const ASPECT_C = Symbol("ASPECT_C");
    const CLASS_ASPECT = Symbol("CLASS_ASPECT");

    class DirectAspect implements MethodAspectHandler {
      intercept(ctx: MethodAspectContext) {
        return ctx.proceed();
      }
    }

    const AspectA = (label: string, order?: number) =>
      createMethodAspectDecorator(ASPECT_A, { label }, order);
    const AspectB = (label: string, order?: number) =>
      createMethodAspectDecorator(ASPECT_B, { label }, order);
    const AspectC = () => createMethodAspectDecorator(ASPECT_C);
    const ClassAsp = () => createMethodAspectDecorator(CLASS_ASPECT);

    class PlainService {
      work() {}
    }

    @ClassAsp()
    class BaseService {
      @AspectA("outer")
      @AspectB("inner")
      compute() {}

      @AspectB("late", 10)
      @AspectA("early", -5)
      ordered() {}
    }

    class SubService extends BaseService {
      @AspectC()
      override compute() {}

      @createMethodAspectDecorator(DirectAspect)
      extra() {}
    }

    expect(hasMethodAspects(PlainService)).toBe(false);
    expect(hasMethodAspects(BaseService)).toBe(true);
    expect(hasMethodAspects(SubService)).toBe(true);

    // Top-to-bottom stacked order with class-level first
    expect(
      getMethodAspects(BaseService, "compute").map((a) => a.token),
    ).toEqual([CLASS_ASPECT, ASPECT_A, ASPECT_B]);

    // Explicit order ascending (-5 < 0 < 10)
    expect(
      getMethodAspects(BaseService, "ordered").map((a) => a.token),
    ).toEqual([ASPECT_A, CLASS_ASPECT, ASPECT_B]);

    // Subclass inherits parent aspects and adds its own without mutating parent
    expect(
      getMethodAspects(SubService, "compute").map((a) => a.token),
    ).toEqual([CLASS_ASPECT, ASPECT_A, ASPECT_B, ASPECT_C]);
    expect(
      getMethodAspects(SubService, "extra").map((a) => a.token),
    ).toEqual([CLASS_ASPECT, DirectAspect]);
    expect(
      getMethodAspects(BaseService, "compute").map((a) => a.token),
    ).toEqual([CLASS_ASPECT, ASPECT_A, ASPECT_B]);
  });

  it("attaches @UseMiddleware on classes and methods in top-to-bottom order without mutating parent", () => {
    const mw1 = (_req: Request, _res: unknown, next: () => unknown) => next();
    const mw2 = (_req: Request, _res: unknown, next: () => unknown) => next();
    const mw3 = (_req: Request, _res: unknown, next: () => unknown) => next();

    @UseMiddleware(mw1)
    class BaseCtrl {
      @UseMiddleware(mw2)
      @UseMiddleware(mw3)
      list() {}
    }

    @UseMiddleware(mw2)
    class SubCtrl extends BaseCtrl {}

    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.MIDDLEWARES, BaseCtrl),
    ).toEqual([mw1]);
    expect(
      MetadataRegistry.getMergedClassArray(METADATA_KEYS.MIDDLEWARES, SubCtrl),
    ).toEqual([mw1, mw2]);
    expect(
      MetadataRegistry.getOwn(
        METADATA_KEYS.MIDDLEWARES,
        BaseCtrl.prototype.list,
      ),
    ).toEqual([mw2, mw3]);
  });
});
