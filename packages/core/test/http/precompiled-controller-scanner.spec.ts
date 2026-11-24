import { describe, expect, test } from "bun:test";
import {
  Controller,
  Get,
  HttpCode,
  InheritMethodEnhancers,
  METADATA_KEYS,
  MetadataRegistry,
  Param,
  Post,
  SetMetadata,
  UseGuards,
  UseMiddleware,
  Version,
  VersioningType,
  getPrecompiledController,
  type CanActivate,
  type MiddlewareFunction,
} from "../../src/common/index";
import {
  InvalidControllerException,
  InvalidRouteException,
  scanControllers,
} from "../../src/http";

class GuardOne implements CanActivate {
  canActivate() {
    return true;
  }
}

class GuardTwo implements CanActivate {
  canActivate() {
    return true;
  }
}

const mwOne: MiddlewareFunction = (_req, _res, next) => next();
const mwTwo: MiddlewareFunction = (_req, _res, next) => next();

describe("PrecompiledControllerDescriptor integration in scanControllers", () => {
  test("reuses pre-indexed WeakMap descriptor across repeated scans with different options", () => {
    @Controller("books")
    @UseGuards(GuardOne)
    @UseMiddleware(mwOne)
    class BooksController {
      @Get(":id")
      @HttpCode(200)
      @Version("1")
      getOne(@Param("id") id: string) {
        return { id };
      }

      @Post()
      @HttpCode(201)
      @Version("2")
      create() {
        return { created: true };
      }
    }

    const beforeScan = getPrecompiledController(BooksController);
    expect(beforeScan).toBeDefined();

    const scanA = scanControllers([BooksController], {
      globalPrefix: "/api",
    });
    const scanB = scanControllers([BooksController], {
      globalPrefix: "/api",
      versioning: { type: VersioningType.URI },
    });

    // Descriptor stayed cached across both scans with zero invalidations
    expect(getPrecompiledController(BooksController)).toBe(beforeScan);

    expect(scanA.map((r) => `${r.method} ${r.fullPath}`)).toEqual([
      "GET /api/books/:id",
      "POST /api/books",
    ]);
    expect(scanB.map((r) => `${r.method} ${r.fullPath}`)).toEqual([
      "GET /api/v1/books/:id",
      "POST /api/v2/books",
    ]);
    expect(scanA[0]?.controllerGuards).toEqual([GuardOne]);
    expect(scanA[0]?.controllerMiddlewares).toEqual([mwOne]);
  });

  test("automatically invalidates precompiled descriptor when parent or child controller metadata mutates", () => {
    @Controller("base-v")
    @UseGuards(GuardOne)
    class BaseCtrl {
      @Get("item")
      @SetMetadata("roles", ["admin"])
      @UseMiddleware(mwOne)
      item() {
        return "base";
      }
    }

    @Controller("child-v")
    class ChildCtrl extends BaseCtrl {
      @Get("item")
      @UseMiddleware(mwTwo)
      override item() {
        return "child";
      }
    }

    @Controller("optout-v")
    class OptOutCtrl extends BaseCtrl {
      @Get("item")
      @InheritMethodEnhancers(false)
      override item() {
        return "optout";
      }
    }

    const firstScan = scanControllers([ChildCtrl, OptOutCtrl]);
    expect(firstScan[0]?.controllerGuards).toEqual([GuardOne]);
    expect(firstScan[0]?.methodMiddlewares).toEqual([mwOne, mwTwo]);
    expect(MetadataRegistry.get("roles", ChildCtrl.prototype.item)).toEqual([
      "admin",
    ]);
    expect(firstScan[1]?.methodMiddlewares).toEqual([]);

    // Now mutate parent class metadata — ChildCtrl's cached descriptor must invalidate automatically!
    MetadataRegistry.prependOwnArray(
      METADATA_KEYS.GUARDS,
      [GuardTwo],
      BaseCtrl,
    );
    const secondScan = scanControllers([ChildCtrl]);
    expect(secondScan[0]?.controllerGuards).toEqual([GuardTwo, GuardOne]);
  });

  test("preserves InvalidControllerException and InvalidRouteException validation diagnostics", () => {
    class NotAController {}
    expect(() => scanControllers([NotAController])).toThrow(
      InvalidControllerException,
    );

    @Controller("broken")
    class BrokenRouteController {}
    MetadataRegistry.define(
      METADATA_KEYS.ROUTES,
      [{ method: "GET", path: "ghost", handlerKey: "missingMethod" }],
      BrokenRouteController,
    );
    expect(() => scanControllers([BrokenRouteController])).toThrow(
      InvalidRouteException,
    );
  });
});
