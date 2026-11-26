import { Body, Controller, Injectable, Post } from "@bunest/core";
import { Test } from "../../testing/src";
import {
  ValidationPipe,
  type ValidationPipeOptions,
} from "../../validation/src";
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "../../validation/src/validator";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  extractValidationErrorFields,
  replayBodyContractCandidates,
  type ReplayTargetInstance,
} from "../src/analyzer/body-contract-replay";

// ---------------------------------------------------------------------------
// DTO Fixtures
// ---------------------------------------------------------------------------

class CreateOrderMin0Dto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  quantity?: number;
}

class CreateOrderMin1Dto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;
}

class CreateOrderWithLegacyCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  quantity?: number;

  @IsOptional()
  @IsString()
  legacyCode?: string;
}

class CreateOrderWithoutLegacyCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  quantity?: number;
}

// ---------------------------------------------------------------------------
// Isolated Per-Run SQLite (:memory:) Service + Controllers
// ---------------------------------------------------------------------------

interface StoredOrderRow {
  readonly id: number;
  readonly name: string;
  readonly quantity: number;
  readonly legacyCode?: string;
}

@Injectable()
class IsolatedOrdersSqliteService {
  private readonly db: Database;

  constructor() {
    this.db = new Database(":memory:");
    this.db.run(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        legacy_code TEXT
      )
    `);
  }

  create(dto: {
    name: string;
    quantity?: number;
    legacyCode?: string;
  }): StoredOrderRow {
    const qty = dto.quantity ?? 0;
    const hasLegacy = Object.hasOwn(dto, "legacyCode") && dto.legacyCode !== undefined;
    const stmt = this.db.query(
      "INSERT INTO orders (name, quantity, legacy_code) VALUES (?, ?, ?) RETURNING id, name, quantity, legacy_code",
    );
    const row = stmt.get(dto.name, qty, hasLegacy ? dto.legacyCode ?? null : null) as {
      id: number;
      name: string;
      quantity: number;
      legacy_code: string | null;
    };

    const result: StoredOrderRow = {
      id: row.id,
      name: row.name,
      quantity: row.quantity,
      ...(hasLegacy && row.legacy_code !== null
        ? { legacyCode: row.legacy_code }
        : {}),
    };
    return result;
  }

  close(): void {
    this.db.close();
  }
}

@Controller("orders")
class OrdersMin0Controller {
  constructor(private readonly orders: IsolatedOrdersSqliteService) {}

  @Post()
  create(@Body() dto: CreateOrderMin0Dto): StoredOrderRow {
    return this.orders.create(dto);
  }
}

@Controller("orders")
class OrdersMin1Controller {
  constructor(private readonly orders: IsolatedOrdersSqliteService) {}

  @Post()
  create(@Body() dto: CreateOrderMin1Dto): StoredOrderRow {
    return this.orders.create(dto);
  }
}

@Controller("orders")
class OrdersWithLegacyController {
  constructor(private readonly orders: IsolatedOrdersSqliteService) {}

  @Post()
  create(@Body() dto: CreateOrderWithLegacyCodeDto): StoredOrderRow {
    return this.orders.create(dto);
  }
}

@Controller("orders")
class OrdersWithoutLegacyController {
  constructor(private readonly orders: IsolatedOrdersSqliteService) {}

  @Post()
  create(@Body() dto: CreateOrderWithoutLegacyCodeDto): StoredOrderRow {
    return this.orders.create(dto);
  }
}

@Controller("orders")
class OrdersBrokenDbController {
  @Post()
  create(): never {
    throw new Error("SQLITE_ERROR: no such table: orders");
  }
}

function createOrdersAppFactory(
  controller: new (...args: never[]) => unknown,
  pipeOptions?: ValidationPipeOptions | null,
): () => Promise<ReplayTargetInstance> {
  return async () => {
    const mod = await Test.createTestingModule({
      controllers: [controller],
      providers: [IsolatedOrdersSqliteService],
    }).compile();

    const app = mod.createBunestApplication({ logger: false });
    if (pipeOptions !== null) {
      app.useGlobalPipes(new ValidationPipe(pipeOptions));
    }
    await app.init();

    const ordersService = mod.get(IsolatedOrdersSqliteService);

    return {
      fetch: (req: Request) => app.fetch(req),
      close: async () => {
        await app.close();
        ordersService.close();
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DTO Body Contract Replay Harness (Branch C)", () => {
  it("confirms primary Orders/Items @Min(0) -> @Min(1) breaking change and stays deterministic across repeated runs", async () => {
    const pipeOptions: ValidationPipeOptions = {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    };

    const options = {
      base: createOrdersAppFactory(OrdersMin0Controller, pipeOptions),
      head: createOrdersAppFactory(OrdersMin1Controller, pipeOptions),
      baseCommit: "base-abc123",
      headCommit: "head-def456",
      pipeProfile: {
        applied: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        errorFormat: "bunest" as const,
      },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 0 },
        },
      ],
    };

    const run1 = await replayBodyContractCandidates(options);
    const run2 = await replayBodyContractCandidates(options);

    expect(run1).toHaveLength(1);
    const record = run1[0]!;

    expect(record.method).toBe("POST");
    expect(record.path).toBe("/orders");
    expect(record.targetField).toBe("quantity");
    expect(record.baseStatus).toBe(201);
    expect(record.headStatus).toBe(400);
    expect(record.baseErrorFields).toEqual([]);
    expect(record.headErrorFields).toEqual(["quantity"]);
    expect(record.baseCommit).toBe("base-abc123");
    expect(record.headCommit).toBe("head-def456");
    expect(record.verdict).toBe("confirmed-breaking");
    expect(record.environmentError).toBeUndefined();

    // Determinism: running twice in a row produces identical results (fresh :memory: SQLite each run)
    expect(run2).toEqual(run1);
  });

  it("Profile A (whitelist: true, forbidNonWhitelisted: false) classifies removed legacyCode as stripped-accepted", async () => {
    const pipeOptions: ValidationPipeOptions = {
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    };

    const results = await replayBodyContractCandidates({
      base: createOrdersAppFactory(OrdersWithLegacyController, pipeOptions),
      head: createOrdersAppFactory(OrdersWithoutLegacyController, pipeOptions),
      baseCommit: "base-legacy",
      headCommit: "head-stripped",
      includeBodies: true,
      pipeProfile: {
        applied: true,
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        label: "whitelist-strip",
      },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "legacyCode",
          payload: {
            name: "Notebook",
            quantity: 2,
            legacyCode: "LEGACY-42",
          },
        },
      ],
    });

    expect(results).toHaveLength(1);
    const record = results[0]!;
    expect(record.baseStatus).toBe(201);
    expect(record.headStatus).toBe(201);
    expect(record.baseErrorFields).toEqual([]);
    expect(record.headErrorFields).toEqual([]);
    expect(record.strippedFields).toEqual(["legacyCode"]);
    expect(record.verdict).toBe("stripped-accepted");
    expect((record.baseBody as Record<string, unknown>).legacyCode).toBe(
      "LEGACY-42",
    );
    expect(
      Object.hasOwn(record.headBody as Record<string, unknown>, "legacyCode"),
    ).toBe(false);
  });

  it("Profile B (whitelist: true, forbidNonWhitelisted: true) classifies removed legacyCode as confirmed-breaking", async () => {
    const pipeOptions: ValidationPipeOptions = {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    };

    const results = await replayBodyContractCandidates({
      base: createOrdersAppFactory(OrdersWithLegacyController, pipeOptions),
      head: createOrdersAppFactory(OrdersWithoutLegacyController, pipeOptions),
      baseCommit: "base-legacy",
      headCommit: "head-forbid",
      pipeProfile: {
        applied: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        label: "whitelist-forbid",
      },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "legacyCode",
          payload: {
            name: "Notebook",
            quantity: 2,
            legacyCode: "LEGACY-42",
          },
        },
      ],
    });

    expect(results).toHaveLength(1);
    const record = results[0]!;
    expect(record.baseStatus).toBe(201);
    expect(record.headStatus).toBe(400);
    expect(record.headErrorFields).toContain("legacyCode");
    expect(record.verdict).toBe("confirmed-breaking");
  });

  it("Control 1 (ValidationPipe not applied): @Min(0) -> @Min(1) yields 201 -> 201 and no-http-change", async () => {
    const results = await replayBodyContractCandidates({
      base: createOrdersAppFactory(OrdersMin0Controller, null),
      head: createOrdersAppFactory(OrdersMin1Controller, null),
      pipeProfile: { applied: false },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 0 },
        },
      ],
    });

    expect(results).toHaveLength(1);
    const record = results[0]!;
    expect(record.baseStatus).toBe(201);
    expect(record.headStatus).toBe(201);
    expect(record.verdict).toBe("no-http-change");
    expect(record.environmentError).toBeUndefined();
  });

  it("Control 2 (relaxed constraint @Min(1) -> @Min(0)) yields no-http-change", async () => {
    const pipeOptions: ValidationPipeOptions = {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    };

    const results = await replayBodyContractCandidates({
      base: createOrdersAppFactory(OrdersMin1Controller, pipeOptions),
      head: createOrdersAppFactory(OrdersMin0Controller, pipeOptions),
      pipeProfile: {
        applied: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 1 },
          label: "previously-valid",
        },
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 0 },
          label: "newly-accepted-boundary",
        },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.baseStatus).toBe(201);
    expect(results[0]!.headStatus).toBe(201);
    expect(results[0]!.verdict).toBe("no-http-change");

    expect(results[1]!.baseStatus).toBe(400);
    expect(results[1]!.baseErrorFields).toEqual(["quantity"]);
    expect(results[1]!.headStatus).toBe(201);
    expect(results[1]!.verdict).toBe("no-http-change");
  });

  it("separates bootstrap/DB factory errors as environment-error and never as validation failure", async () => {
    const results = await replayBodyContractCandidates({
      base: createOrdersAppFactory(OrdersMin0Controller, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
      head: async () => {
        throw new Error(
          "SQLITE_CANTOPEN: failed to bootstrap isolated orders database",
        );
      },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 0 },
        },
      ],
    });

    expect(results).toHaveLength(1);
    const record = results[0]!;
    expect(record.verdict).toBe("environment-error");
    expect(record.environmentError).toContain("SQLITE_CANTOPEN");
    expect(record.headStatus).toBeNull();
  });

  it("separates 5xx runtime/DB errors as environment-error", async () => {
    const results = await replayBodyContractCandidates({
      base: createOrdersAppFactory(OrdersMin0Controller, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
      head: createOrdersAppFactory(OrdersBrokenDbController, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 0 },
        },
      ],
    });

    expect(results).toHaveLength(1);
    const record = results[0]!;
    expect(record.baseStatus).toBe(201);
    expect(record.headStatus).toBe(500);
    expect(record.verdict).toBe("environment-error");
    expect(record.environmentError).toContain("500");
  });

  it("extracts validation error fields across bunest, grouped, and list formats", () => {
    expect(
      extractValidationErrorFields({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details: [
          {
            field: "quantity",
            constraints: { min: "quantity must not be less than 1" },
            messages: ["quantity must not be less than 1"],
          },
        ],
      }),
    ).toEqual(["quantity"]);

    expect(
      extractValidationErrorFields({
        statusCode: 400,
        error: "Bad Request",
        message: {
          quantity: ["quantity must not be less than 1"],
          "...": ["Some errors omitted"],
        },
      }),
    ).toEqual(["quantity"]);

    expect(
      extractValidationErrorFields({
        statusCode: 400,
        error: "Bad Request",
        message: [
          "quantity must not be less than 1",
          "property legacyCode should not exist",
        ],
      }),
    ).toEqual(["quantity", "legacyCode"]);
  });

  it("supports direct fetch handlers and live base URLs as ReplayTargetApp", async () => {
    const baseApp = await createOrdersAppFactory(OrdersMin0Controller, {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })();
    const headApp = await createOrdersAppFactory(OrdersMin1Controller, {
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })();

    const headServer = Bun.serve({
      port: 0,
      fetch: (req) => headApp.fetch(req),
    });

    try {
      const results = await replayBodyContractCandidates({
        base: (req: Request) => baseApp.fetch(req),
        head: `http://127.0.0.1:${headServer.port}`,
        candidates: [
          {
            method: "POST",
            path: "/orders",
            targetField: "quantity",
            payload: { name: "Notebook", quantity: 0 },
          },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.baseStatus).toBe(201);
      expect(results[0]!.headStatus).toBe(400);
      expect(results[0]!.headErrorFields).toEqual(["quantity"]);
      expect(results[0]!.verdict).toBe("confirmed-breaking");
    } finally {
      headServer.stop(true);
      await baseApp.close?.();
      await headApp.close?.();
    }
  });
});
