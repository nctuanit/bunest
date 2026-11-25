import { afterEach, describe, expect, it } from "bun:test";
import { IsEmail, IsString } from "../../../packages/validation/src/validator";
import {
  Body,
  Controller,
  Get,
  HttpException,
  Injectable,
  Post,
  Scope,
  ValidationPipe as CoreValidationPipe,
} from "../../../packages/core/src";
import { ValidationPipe as PkgValidationPipe } from "../../../packages/validation/src";
import {
  BUNEST_ADRS,
  NEST_DEFAULT_VALIDATION_PIPE_OPTIONS,
  adaptedTitle,
  adrTag,
  bunestStrictValidationPipe,
  clearRegisteredConformanceSuites,
  conformanceTitle,
  createSandbox,
  createSpy,
  createStub,
  createTestApp,
  createTestingModule,
  deepMatch,
  describeConformance,
  expectCalled,
  expectCalledOnce,
  expectCalledOnceWith,
  expectCalledTimes,
  expectCalledWith,
  expectNestValidationErrorEnvelope,
  expectNotCalled,
  expectRejectsWith,
  expectScopeLeak,
  expectValidationErrorEnvelope,
  getAdrInfo,
  getRegisteredConformanceSuites,
  httpRequest,
  itAdapted,
  match,
  nestCompatibleValidationPipe,
  spyOnMethod,
  stubMethod,
  withTestApp,
} from "./index";

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  name!: string;
}

@Controller("users")
class UsersController {
  @Get("ping")
  ping() {
    return { ok: true };
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return {
      isInstance: dto instanceof CreateUserDto,
      payload: dto,
    };
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestOnlyService {
  getValue() {
    return "req-only";
  }
}

@Injectable()
class LeakySingletonService {
  constructor(readonly reqSvc: RequestOnlyService) {}
}

describe("Conformance Test Harness (_helpers)", () => {
  describe("module identity", () => {
    it("shares identical class constructors across relative package imports", () => {
      expect(CoreValidationPipe).toBe(PkgValidationPipe);
      expect(nestCompatibleValidationPipe()).toBeInstanceOf(CoreValidationPipe);
      expect(bunestStrictValidationPipe()).toBeInstanceOf(PkgValidationPipe);
    });
  });

  describe("conformance-meta", () => {
    it("exposes complete ADR-001..ADR-012 registry and formats tags cleanly", () => {
      expect(Object.keys(BUNEST_ADRS)).toHaveLength(12);
      expect(getAdrInfo("ADR-008").title).toContain("Promise");
      expect(getAdrInfo("ADR-009").title).toContain("ValidationPipe");
      expect(getAdrInfo("ADR-012").title).toContain("ScopeLeakException");

      expect(adrTag("ADR-008")).toBe("[ADR-008]");
      expect(adrTag(["ADR-009", "ADR-010"])).toBe("[ADR-009, ADR-010]");
      expect(adrTag("ADR-012", "fail-fast scope leak")).toBe(
        "[ADR-012: fail-fast scope leak]",
      );
      expect(conformanceTitle("validates DTO", "ADR-009")).toBe(
        "validates DTO [ADR-009]",
      );
      expect(
        adaptedTitle("ADR-008", "runs interceptor", "Promise CallHandler"),
      ).toBe("runs interceptor [ADR-008: Promise CallHandler]");
    });

    it("detects ADR-012 ScopeLeakException via expectScopeLeak()", async () => {
      const err = await expectScopeLeak(
        () =>
          createTestingModule({
            providers: [RequestOnlyService, LeakySingletonService],
          }).compile({ logger: false }),
        /LeakySingletonService.*RequestOnlyService/,
      );
      expect(err.name).toBe("ScopeLeakException");
    });

    describeConformance(
      "Sample Conformance Suite Registration",
      {
        upstreamPath: "integration/sample/e2e/sample.spec.ts",
        category: "ADAPTED_PORT",
        adrs: ["ADR-008", "ADR-009"],
        notes: "Self-test verifying suite registration",
      },
      () => {
        itAdapted(
          "ADR-008",
          "registers suite metadata and supports adapted test helper",
          () => {
            const suites = getRegisteredConformanceSuites();
            const found = suites.find(
              (s) => s.upstreamPath === "integration/sample/e2e/sample.spec.ts",
            );
            expect(found).toBeDefined();
            expect(found?.category).toBe("ADAPTED_PORT");
            expect(found?.adrs).toEqual(["ADR-008", "ADR-009"]);
            clearRegisteredConformanceSuites();
            expect(getRegisteredConformanceSuites()).toHaveLength(0);
          },
          "Promise pipeline",
        );
      },
    );
  });

  describe("http-helpers", () => {
    it("supports createTestApp / withTestApp, TestClient, and Supertest request()", async () => {
      await withTestApp(
        { controllers: [UsersController] },
        async ({ app, client, request: makeRequest }) => {
          const clientRes = await client.get("/users/ping");
          clientRes.expectStatus(200);
          await clientRes.expectJson({ ok: true });

          await makeRequest().get("/users/ping").expect(200, { ok: true });
          await httpRequest(app).get("/users/ping").expect(200, { ok: true });
        },
        { silentLogger: true },
      );
    });

    it("contrasts nestCompatibleValidationPipe() vs bunestStrictValidationPipe()", async () => {
      expect(NEST_DEFAULT_VALIDATION_PIPE_OPTIONS).toEqual({
        transform: false,
        whitelist: false,
        forbidNonWhitelisted: false,
        forbidUnknownValues: false,
        errorFormat: "list",
      });

      // 1. NestJS-compatible defaults: allows extra fields, keeps plain object, returns flat message: string[]
      const nestCtx = await createTestApp(
        { controllers: [UsersController] },
        {
          silentLogger: true,
          configureApp: (app) => {
            app.useGlobalPipes(nestCompatibleValidationPipe());
          },
        },
      );
      try {
        const okRes = await nestCtx
          .request()
          .post("/users")
          .send({ email: "a@b.com", name: "Alice", extra: "kept" })
          .expect(201);
        expect(okRes.body).toEqual({
          isInstance: false,
          payload: { email: "a@b.com", name: "Alice", extra: "kept" },
        });

        const errRes = await nestCtx
          .request()
          .post("/users")
          .send({ email: "not-an-email", name: 123 })
          .expect(400);
        expectNestValidationErrorEnvelope(errRes.body, {
          statusCode: 400,
          messageIncludes: [/email/, /name/],
        });
      } finally {
        await nestCtx.close();
      }

      // 2. NestJS-compatible with whitelist: true strips extra fields without 400
      await withTestApp(
        { controllers: [UsersController] },
        async ({ request: makeRequest }) => {
          const res = await makeRequest()
            .post("/users")
            .send({ email: "a@b.com", name: "Alice", extra: "stripped" })
            .expect(201);
          expect(res.body).toEqual({
            isInstance: false,
            payload: { email: "a@b.com", name: "Alice" },
          });
        },
        {
          silentLogger: true,
          configureApp: (app) => {
            app.useGlobalPipes(
              nestCompatibleValidationPipe({ whitelist: true }),
            );
          },
        },
      );

      // 3. Bunest ADR-009 strict defaults: forbids non-whitelisted, transforms to DTO instance, normalized details envelope
      await withTestApp(
        { controllers: [UsersController] },
        async ({ request: makeRequest }) => {
          const okRes = await makeRequest()
            .post("/users")
            .send({ email: "a@b.com", name: "Alice" })
            .expect(201);
          expect(okRes.body.isInstance).toBe(true);

          const forbiddenRes = await makeRequest()
            .post("/users")
            .send({ email: "a@b.com", name: "Alice", extra: "blocked" })
            .expect(400);
          expectValidationErrorEnvelope(forbiddenRes.body, {
            statusCode: 400,
            fields: ["extra"],
          });
        },
        {
          silentLogger: true,
          configureApp: (app) => {
            app.useGlobalPipes(bunestStrictValidationPipe());
          },
        },
      );
    });
  });

  describe("spy-helpers", () => {
    const sandbox = createSandbox();

    afterEach(() => {
      sandbox.restore();
    });

    it("provides Sinon-compatible spies that also work with bun:test expect()", () => {
      const first = createSpy((a: number, b: number) => a + b);
      const second = createSpy((label: string) => label.toUpperCase());

      expectNotCalled(first);
      expect(first.notCalled).toBe(true);

      const sum = first(2, 3);
      const upper = second("hello");

      expect(sum).toBe(5);
      expect(upper).toBe("HELLO");

      // Native bun:test matchers work directly on the spy
      expect(first).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledWith(2, 3);

      // Sinon-like properties & helpers work identically
      expectCalled(first);
      expectCalledOnce(first);
      expectCalledTimes(first, 1);
      expectCalledWith(first, 2, match.number);
      expectCalledOnceWith(first, 2, 3);
      expect(first.calledWithExactly(2, 3)).toBe(true);
      expect(first.calledWithExactly(2)).toBe(false);
      expect(first.firstCall?.returnValue).toBe(5);
      expect(first.calledBefore(second)).toBe(true);
      expect(second.calledAfter(first)).toBe(true);

      first.resetHistory();
      expect(first.notCalled).toBe(true);
      expect(first.firstCall).toBeNull();
    });

    it("supports stubs with returns/resolves/rejects/throws/onCall and sandbox restore", async () => {
      const stub = createStub<(x: number) => number>();
      stub.onFirstCall().returns(10);
      stub.onSecondCall().returnsArg(0);
      stub.returns(99);

      expect(stub(1)).toBe(10);
      expect(stub(42)).toBe(42);
      expect(stub(7)).toBe(99);
      expect(stub.calledThrice).toBe(true);
      expect(stub.returnValues).toEqual([10, 42, 99]);

      const asyncStub = createStub<() => Promise<string>>();
      asyncStub.resolves("done");
      expect(await asyncStub()).toBe("done");

      asyncStub.rejects(new HttpException("boom", 418));
      const err = await expectRejectsWith(asyncStub, HttpException);
      expect(err.getStatus()).toBe(418);

      const throwingStub = createStub<() => void>().throws("sync boom");
      expect(() => throwingStub()).toThrow("sync boom");

      const target = {
        greet(name: string) {
          return `hi ${name}`;
        },
      };
      const spied = spyOnMethod(target, "greet");
      expect(target.greet("bun")).toBe("hi bun");
      expectCalledOnceWith(spied, "bun");
      spied.restore();

      const stubbed = sandbox.stub(target, "greet").returns("stubbed!");
      expect(target.greet("bun")).toBe("stubbed!");
      expectCalledOnce(stubbed);

      // Re-stubbing with callThrough() safely delegates to the true original method
      const directStub = stubMethod(target, "greet").callThrough();
      expect(target.greet("again")).toBe("hi again");
      directStub.restore();

      sandbox.restore();
      expect(target.greet("restored")).toBe("hi restored");
    });

    it("supports matchers and structural deepMatch including cycles", () => {
      expect(
        deepMatch(
          { id: 1, tag: "abc", nested: [1, 2] },
          { id: match.number, tag: match.regex(/^a/), nested: match.array },
        ),
      ).toBe(true);
      expect(deepMatch({ a: 1 }, match.has("a", 1))).toBe(true);
      expect(deepMatch({ a: 1 }, match.has("b"))).toBe(false);
      expect(deepMatch(new Date(1000), match.instanceOf(Date))).toBe(true);

      const cyclicA: Record<string, unknown> = { x: 1 };
      cyclicA.self = cyclicA;
      const cyclicB: Record<string, unknown> = { x: 1 };
      cyclicB.self = cyclicB;
      expect(deepMatch(cyclicA, cyclicB)).toBe(true);
    });
  });
});
