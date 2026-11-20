# @bunest/testing

Testing module builder, DI/enhancer overrides, in-memory HTTP & Supertest-compatible test client, SSE helpers, and mock fixtures for **Bunest** with zero external runtime dependencies.

## Features

- **Testing Module Builder**: `Test.createTestingModule()` with `overrideProvider()`, `overrideGuard()`, `overrideInterceptor()`, `overridePipe()`, `overrideFilter()`, and `useMocker()` auto-mocking.
- **In-Memory HTTP & Supertest Client**: Run full HTTP requests against a `BunestApplication` without binding a TCP port via `TestClient`, `TestAgent`, `CookieJar`, and Supertest-compatible `request(app)`.
- **SSE & Streaming Helpers**: Consume and assert Server-Sent Events responses with `readSseEvents()` and `parseSseJson()`.
- **Auto-Mocking & Fixtures**: `ModuleMocker`, `createAutoMocker()`, `createMockFn()`, `createMockProvider()`, `createMockExecutionContext()`, `createMockCallHandler()`, `createMockRequest()`, `createMockResponseContext()`, `createMockReflector()`, and `runWithMockRequestContext()`.
- **Log Capture**: Inspect structured log output in tests using `CapturingLogger` and `TestingLogger`.

## Installation

```bash
bun add -d @bunest/testing
```

## Quick Start

```ts
import { Controller, Get, Injectable } from "@bunest/common";
import { Test, request } from "@bunest/testing";
import { describe, expect, it } from "bun:test";

@Injectable()
class GreetingService {
  hello() {
    return "hello";
  }
}

@Controller("greet")
class GreetingController {
  constructor(private readonly service: GreetingService) {}

  @Get()
  getGreeting() {
    return { message: this.service.hello() };
  }
}

describe("GreetingController", () => {
  it("returns overridden greeting", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GreetingController],
      providers: [GreetingService],
    })
      .overrideProvider(GreetingService)
      .useValue({ hello: () => "hi from test" })
      .compile();

    const app = moduleRef.createBunestApplication();
    await app.init();

    const res = await request(app).get("/greet").expect(200);
    expect(res.body).toEqual({ message: "hi from test" });

    await app.close();
  });
});
```

## Key Exports

- **Module Builder**: `Test`, `TestingModuleBuilder`, `TestingModule`, `ScopedTestingModule`, `ContextIdFactory`
- **HTTP & SSE Clients**: `TestClient`, `TestAgent`, `TestResponse`, `CookieJar`, `request`, `SupertestRequest`, `SupertestAgent`, `createNodeHttpServer`, `readSseEvents`, `parseSseJson`
- **Mocking & Fixtures**: `ModuleMocker`, `createAutoMocker`, `createMockFn`, `createMockProvider`, `createMockExecutionContext`, `createMockCallHandler`, `createMockRequest`, `createMockResponseContext`, `createMockReflector`, `createMockLogger`, `runWithMockRequestContext`
- **Test Loggers**: `CapturingLogger`, `TestingLogger`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
