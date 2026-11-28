import { describe, expect, it } from "bun:test";
import {
  APP_FILTER,
  Catch,
  Controller,
  DomainException,
  Get,
  Module,
  UseFilters,
  createDomainErrorFilter,
  type ArgumentsHost,
  type DomainErrorKind,
  type ExceptionFilter,
} from "../src/common/index";
import { BunestFactory } from "../src/index";

describe("Transport-agnostic DomainException & createDomainErrorFilter", () => {
  class InsufficientBalanceError extends DomainException {
    constructor(accountId: string) {
      super({
        code: "INSUFFICIENT_BALANCE",
        kind: "conflict",
        message: `Account ${accountId} has insufficient balance`,
        details: { accountId },
      });
    }
  }

  class PlainUserNotFoundError extends Error {
    constructor(readonly userId: string) {
      super(`User ${userId} not found`);
      this.name = "PlainUserNotFoundError";
    }
  }

  class PlainQuotaError extends Error {
    constructor(readonly limit: number) {
      super(`Quota exceeded (${limit})`);
      this.name = "PlainQuotaError";
    }
  }

  class UnmappedError extends Error {}

  const domainFilter = createDomainErrorFilter([
    [PlainUserNotFoundError, { status: 404, code: "USER_NOT_FOUND" }],
    [
      PlainQuotaError,
      (err) => ({
        status: 429,
        code: "QUOTA_EXCEEDED",
        message: err.message,
        details: { limit: err.limit },
      }),
    ],
  ]);

  @Controller("domain")
  class DomainController {
    @Get("conflict")
    conflict() {
      throw new InsufficientBalanceError("acc-9");
    }

    @Get("not-found")
    notFound() {
      throw new DomainException({
        code: "ORDER_NOT_FOUND",
        kind: "not_found",
        message: "Order missing",
      });
    }

    @Get("internal")
    internal() {
      throw new DomainException({
        code: "DB_CORRUPT",
        kind: "internal",
        message: "Sensitive internal SQL error",
        details: { host: "10.0.0.5" },
      });
    }

    @Get("mapped-not-found")
    @UseFilters(domainFilter)
    mappedNotFound() {
      throw new PlainUserNotFoundError("u-42");
    }

    @Get("mapped-quota")
    @UseFilters(domainFilter)
    mappedQuota() {
      throw new PlainQuotaError(100);
    }

    @Get("unmapped")
    @UseFilters(domainFilter)
    unmapped() {
      throw new UnmappedError("boom");
    }
  }

  @Module({ controllers: [DomainController] })
  class TestModule {}

  it("maps all DomainErrorKind values to canonical HTTP statuses via DefaultExceptionFilter", async () => {
    const expected: Record<DomainErrorKind, number> = {
      validation: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      unprocessable: 422,
      rate_limited: 429,
      unavailable: 503,
      internal: 500,
    };
    for (const [kind, status] of Object.entries(expected)) {
      const err = new DomainException({
        code: "TEST",
        kind: kind as DomainErrorKind,
        message: "msg",
      });
      expect(err.httpStatus).toBe(status);
    }

    const app = await BunestFactory.create(TestModule, { logger: false });
    await app.init();
    try {
      const resConflict = await app.fetch(
        new Request("http://localhost/domain/conflict"),
      );
      expect(resConflict.status).toBe(409);
      const bodyConflict = (await resConflict.json()) as Record<string, unknown>;
      expect(bodyConflict).toMatchObject({
        statusCode: 409,
        error: "Conflict",
        code: "INSUFFICIENT_BALANCE",
        message: "Account acc-9 has insufficient balance",
        details: { accountId: "acc-9" },
        path: "/domain/conflict",
      });
      expect(typeof bodyConflict.timestamp).toBe("string");

      const res404 = await app.fetch(
        new Request("http://localhost/domain/not-found"),
      );
      expect(res404.status).toBe(404);
      expect((await res404.json()) as Record<string, unknown>).toMatchObject({
        statusCode: 404,
        code: "ORDER_NOT_FOUND",
        message: "Order missing",
      });
    } finally {
      await app.close();
    }
  });

  it("redacts internal DomainException details in production mode", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const app = await BunestFactory.create(TestModule, { logger: false });
    await app.init();

    try {
      const res = await app.fetch(
        new Request("http://localhost/domain/internal"),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("DB_CORRUPT");
      expect(body.message).toBe("Internal Server Error");
      expect(body.details).toBeUndefined();
    } finally {
      await app.close();
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("maps plain Error subclasses with createDomainErrorFilter and passes through unmatched errors", async () => {
    const app = await BunestFactory.create(TestModule, { logger: false });
    await app.init();

    try {
      const res404 = await app.fetch(
        new Request("http://localhost/domain/mapped-not-found"),
      );
      expect(res404.status).toBe(404);
      expect((await res404.json()) as Record<string, unknown>).toMatchObject({
        statusCode: 404,
        code: "USER_NOT_FOUND",
        message: "User u-42 not found",
      });

      const res429 = await app.fetch(
        new Request("http://localhost/domain/mapped-quota"),
      );
      expect(res429.status).toBe(429);
      expect((await res429.json()) as Record<string, unknown>).toMatchObject({
        statusCode: 429,
        code: "QUOTA_EXCEEDED",
        details: { limit: 100 },
      });

      const res500 = await app.fetch(
        new Request("http://localhost/domain/unmapped"),
      );
      expect(res500.status).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("lets unmatched errors fall through createDomainErrorFilter (and empty filter) to subsequent global filters", async () => {
    @Catch(UnmappedError)
    class GlobalUnmappedFilter implements ExceptionFilter {
      catch(err: UnmappedError, _host: ArgumentsHost) {
        return new Response(
          JSON.stringify({ handledBy: "global", message: err.message }),
          { status: 418, headers: { "content-type": "application/json" } },
        );
      }
    }

    @Catch(DomainException)
    class PlainObjectDomainFilter implements ExceptionFilter {
      catch(err: DomainException) {
        return { customCode: err.code };
      }
    }

    const emptyFilter = createDomainErrorFilter([]);

    @Controller("chain")
    class ChainController {
      @Get("unmapped")
      @UseFilters(domainFilter)
      unmapped() {
        throw new UnmappedError("global-should-catch");
      }

      @Get("empty")
      @UseFilters(emptyFilter)
      empty() {
        throw new UnmappedError("empty-should-pass-through");
      }

      @Get("domain-status")
      @UseFilters(PlainObjectDomainFilter)
      domainStatus() {
        throw new InsufficientBalanceError("acc-1");
      }
    }

    @Module({
      controllers: [ChainController],
      providers: [{ provide: APP_FILTER, useClass: GlobalUnmappedFilter }],
    })
    class ChainModule {}

    const app = await BunestFactory.create(ChainModule, { logger: false });
    await app.init();

    try {
      const resUnmapped = await app.fetch(
        new Request("http://localhost/chain/unmapped"),
      );
      expect(resUnmapped.status).toBe(418);
      expect(await resUnmapped.json()).toEqual({
        handledBy: "global",
        message: "global-should-catch",
      });

      const resEmpty = await app.fetch(
        new Request("http://localhost/chain/empty"),
      );
      expect(resEmpty.status).toBe(418);
      expect(await resEmpty.json()).toEqual({
        handledBy: "global",
        message: "empty-should-pass-through",
      });

      const resDomain = await app.fetch(
        new Request("http://localhost/chain/domain-status"),
      );
      expect(resDomain.status).toBe(409);
      expect(await resDomain.json()).toEqual({
        customCode: "INSUFFICIENT_BALANCE",
      });
    } finally {
      await app.close();
    }
  });
});
