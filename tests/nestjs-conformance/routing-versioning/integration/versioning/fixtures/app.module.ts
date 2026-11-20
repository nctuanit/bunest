import "reflect-metadata";
import {
  Controller,
  Get,
  Module,
  VERSION_NEUTRAL,
  Version,
  type MiddlewareConsumer,
  type NestModule,
} from "../../../../../../packages/common/src";

@Controller({
  version: "1",
})
export class AppV1Controller {
  @Get("/")
  helloWorldV1() {
    return "Hello World V1!";
  }

  @Get("/:param/hello")
  paramV1() {
    return "Parameter V1!";
  }
}

@Controller({
  version: "2",
})
export class AppV2Controller {
  @Get("/")
  helloWorldV2() {
    return "Hello World V2!";
  }

  @Get("/:param/hello")
  paramV2() {
    return "Parameter V2!";
  }
}

@Controller({
  version: ["1", "2"],
})
export class MultipleVersionController {
  @Get("/multiple")
  multiple() {
    return "Multiple Versions 1 or 2";
  }
}

@Controller()
export class MultipleVersionNeutralController {
  @Version([VERSION_NEUTRAL, "2"])
  @Get("/multiple-neutral")
  multipleNeutral() {
    return "Multiple Versions Neutral or 2";
  }
}

@Controller("foo")
export class NoVersioningController {
  @Get("/bar")
  helloFoo() {
    return "Hello FooBar!";
  }
}

@Controller({
  version: VERSION_NEUTRAL,
})
export class VersionNeutralController {
  @Get("/neutral")
  neutral() {
    return "Neutral";
  }
}

@Controller()
export class OverrideController {
  @Version("1")
  @Get("/override")
  overrideV1() {
    return "Override Version 1";
  }

  @Version("2")
  @Get("/override")
  overrideV2() {
    return "Override Version 2";
  }
}

@Controller({
  version: "1",
})
export class OverridePartialController {
  @Get("/override-partial")
  overridePartialV1() {
    return "Override Partial Version 1";
  }

  @Version("2")
  @Get("/override-partial")
  overridePartialV2() {
    return "Override Partial Version 2";
  }
}

@Controller({
  path: "middleware",
  version: "1",
})
export class MiddlewareController {
  @Get("/")
  hello() {
    return 'Hello from "MiddlewareController"!';
  }

  @Version("2")
  @Get("/override")
  hellov2() {
    return 'Hello from "MiddlewareController"!';
  }
}

@Controller({
  version: ["1", "2"],
  path: "middleware",
})
export class MultipleMiddlewareVersionController {
  @Get("/multiple")
  multiple() {
    return "Multiple Versions 1 or 2";
  }
}

@Controller({
  path: "middleware",
  version: VERSION_NEUTRAL,
})
export class VersionNeutralMiddlewareController {
  @Get("/neutral")
  neutral() {
    return "Neutral";
  }
}

@Module({
  imports: [],
  controllers: [
    AppV1Controller,
    AppV2Controller,
    MultipleVersionController,
    MultipleVersionNeutralController,
    NoVersioningController,
    VersionNeutralController,
    OverrideController,
    OverridePartialController,
    MiddlewareController,
    MultipleMiddlewareVersionController,
    VersionNeutralMiddlewareController,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // ADR-001 / ADR-010: short-circuit middleware returns a native Web Response
    // instead of Express `res.end(...)`.
    consumer
      .apply(() => new Response("Hello from middleware function!"))
      .forRoutes(
        MiddlewareController,
        MultipleMiddlewareVersionController,
        VersionNeutralMiddlewareController,
      );
  }
}
