import { afterEach, describe, expect, it } from "bun:test";
import { dirname, join, mkdirSyncPath, removePath, writeTextSync } from "@bunest/core";
import {
  BUILTIN_CLASS_MACRO_NAMES,
  BUILTIN_DECORATOR_SPECS,
  BUILTIN_ENTITY_DECORATOR_NAMES,
  BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES,
  BunestStaticAnalyzer,
  BunestTypegenScanner,
  emitBunestDeclaration,
  transformBunestSource,
} from "../src";

const tempDirs: string[] = [];

function createTempProject(files: Record<string, string>): string {
  const base = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
  const dir = join(base, `bunest-dec-opt-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSyncPath(dirname(abs), { recursive: true });
    writeTextSync(abs, content);
  }
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("Decorator Optimization Pillars 1, 4, and 5 (@bunest/cli)", () => {
  it("exposes single-source BuiltinDecoratorSpec registry covering BaseEntity across macros, entities, and plugin registration", () => {
    expect(BUILTIN_DECORATOR_SPECS.get("BaseEntity")?.isEntity).toBe(true);
    expect(BUILTIN_DECORATOR_SPECS.get("BaseEntity")?.isClassMacro).toBe(true);
    expect(
      BUILTIN_DECORATOR_SPECS.get("BaseEntity")?.needsMacroFieldRegistration,
    ).toBe(true);
    expect(BUILTIN_CLASS_MACRO_NAMES.has("BaseEntity")).toBe(true);
    expect(BUILTIN_ENTITY_DECORATOR_NAMES.has("BaseEntity")).toBe(true);
    expect(BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES.has("BaseEntity")).toBe(true);
    expect(BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES.has("Data")).toBe(true);
  });

  it("statically resolves cross-file applyDecorators(...) wrappers with generic <Key> & literal argument forwarding", () => {
    const dir = createTempProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          experimentalDecorators: true,
        },
      }),
      "src/decorators/domain-entity.ts": `
import { applyDecorators, Builder, Data, FieldNameConstants } from "@bunest/core";
import { BaseEntity, SoftDelete } from "@bunest/orm";

export function DomainEntity<Key = number>(table: string) {
  return applyDecorators(
    BaseEntity<Key>(table),
    Data(),
    Builder(),
    FieldNameConstants(),
    SoftDelete(),
  );
}
`,
      "src/orders/order.entity.ts": `
import { Column } from "@bunest/orm";
import { DomainEntity } from "../decorators/domain-entity";

@DomainEntity<string>("orders")
export class OrderEntity {
  @Column()
  total!: number;

  @Column()
  status!: string;
}
`,
      "src/orders/order.repository.ts": `
import { CrudRepository, OrmRepository } from "@bunest/orm";
import { OrderEntity } from "./order.entity";

@OrmRepository(OrderEntity)
export abstract class OrderRepository extends CrudRepository<OrderEntity, string> {
  abstract findAllByStatusAndTotalGreaterThan(status: string, min: number): Promise<OrderEntity[]>;
  abstract findAllByCreatedAtGreaterThan(since: Date): Promise<OrderEntity[]>;
}
`,
    });

    // 1. Typegen scanner expands DomainEntity<string>("orders") -> BaseEntity<string> + Data + Builder + FieldNameConstants
    const scanner = new BunestTypegenScanner({
      cwd: dir,
      sourceRoot: join(dir, "src"),
    });
    const scan = scanner.scan();
    const orderMacro = scan.classMacros.find((m) => m.className === "OrderEntity");
    expect(orderMacro).toBeDefined();
    expect(orderMacro!.isBaseEntity).toBe(true);
    expect(orderMacro!.isData).toBe(true);
    expect(orderMacro!.isBuilder).toBe(true);
    expect(orderMacro!.isFieldNameConstants).toBe(true);
    expect(orderMacro!.baseEntityKeyType).toBe("string");

    const dts = emitBunestDeclaration(scan, {
      cwd: dir,
      outputPath: join(dir, ".bunest/types/bunest.d.ts"),
    });
    expect(dts).toContain("id: string;");
    expect(dts).toContain("createdAt: Date;");
    expect(dts).toContain("updatedAt: Date;");
    expect(dts).toContain("deletedAt?: Date | null;");
    expect(dts).toContain("getId(): string;");
    expect(dts).toContain("getTotal(): number;");

    // 2. ORM Repository Analyzer resolves tableName="orders", id: string, createdAt, softDelete scope from composed wrapper!
    const analyzer = new BunestStaticAnalyzer({
      cwd: dir,
      sourceRoot: join(dir, "src"),
    });
    const snap = analyzer.analyze();
    const entity = snap.entities.find((e) => e.className === "OrderEntity");
    expect(entity).toBeDefined();
    expect(entity!.tableName).toBe("orders");
    expect(entity!.idTsType).toBe("string");
    expect(entity!.fields.map((f) => f.propertyName)).toEqual(
      expect.arrayContaining(["id", "total", "status", "createdAt", "updatedAt", "deletedAt"]),
    );

    const repo = snap.repositories.find((r) => r.className === "OrderRepository");
    expect(repo).toBeDefined();
    expect(repo!.scopes?.some((s) => s.kind === "softDelete")).toBe(true);
    const derivedMethod = repo!.methods.find(
      (m) => m.name === "findAllByStatusAndTotalGreaterThan",
    );
    expect(derivedMethod?.derived?.sqlPreview).toContain('FROM "orders"');
    expect(derivedMethod?.derived?.sqlPreview).toContain('"deleted_at" IS NULL');
    expect(
      snap.diagnostics.filter(
        (d) => d.code.startsWith("BUNEST_REPO") || d.code.startsWith("BUNEST_DEC"),
      ),
    ).toHaveLength(0);
  });

  it("reports static decorator diagnostics BUNEST_DEC001 through BUNEST_DEC005 accurately with zero false positives", () => {
    const dir = createTempProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          experimentalDecorators: true,
        },
      }),
      "src/bad-decorators.ts": `
import { applyDecorators, Data, Injectable, Setter, UtilityClass, Value } from "@bunest/core";
import { BaseEntity, Column, ManyToOne, OneToMany, Relation, SoftDelete } from "@bunest/orm";
import { Transactional } from "@bunest/orm";

const ImmutableCombo = () => applyDecorators(Value());

// BUNEST_DEC001: @Value (via applyDecorators) + @Setter conflict
@ImmutableCombo()
@Setter()
export class BadImmutable {
  name!: string;
}

// BUNEST_DEC002: @SoftDelete with @BaseEntity({ deletedAt: false })
@BaseEntity<number>({ deletedAt: false })
@SoftDelete()
export class NoDeleteDateEntity {
  @Column()
  title!: string;
}

// BUNEST_DEC003: @Transactional on non-DI plain class
export class PlainNonDiService {
  @Transactional()
  async runWork(): Promise<void> {}
}

// BUNEST_DEC004: @UtilityClass combined with @Injectable
@UtilityClass()
@Injectable()
export class BadUtilityService {
  static helper(): number { return 1; }
}

// BUNEST_DEC005: Same-file forward-referenced @ManyToOne without Relation<T>
@BaseEntity<number>("posts")
export class PostEntity {
  @ManyToOne(() => AuthorEntity)
  author!: AuthorEntity;

  // Valid (wrapped in Relation<T> -> must NOT warn)
  @ManyToOne(() => AuthorEntity)
  editor!: Relation<AuthorEntity>;

  // Valid (array emits Array, not AuthorEntity -> must NOT warn)
  @OneToMany(() => AuthorEntity, (a) => a.id)
  reviewers!: AuthorEntity[];
}

@BaseEntity<number>("authors")
export class AuthorEntity {
  @Column()
  name!: string;
}

// Valid abstract base class with @Transactional -> must NOT trigger BUNEST_DEC003
export abstract class AbstractBaseService {
  @Transactional()
  async baseOp(): Promise<void> {}
}
`,
    });

    const analyzer = new BunestStaticAnalyzer({
      cwd: dir,
      sourceRoot: join(dir, "src"),
    });
    const snap = analyzer.analyze();
    const decDiags = snap.diagnostics.filter((d) =>
      d.code.startsWith("BUNEST_DEC"),
    );

    const codes = decDiags.map((d) => d.code);
    expect(codes).toContain("BUNEST_DEC001");
    expect(codes).toContain("BUNEST_DEC002");
    expect(codes).toContain("BUNEST_DEC003");
    expect(codes).toContain("BUNEST_DEC004");
    expect(codes).toContain("BUNEST_DEC005");

    // Verify exact counts (no false positives on Relation<T>, array, or abstract base class!)
    expect(decDiags.filter((d) => d.code === "BUNEST_DEC003")).toHaveLength(1);
    expect(decDiags.filter((d) => d.code === "BUNEST_DEC005")).toHaveLength(1);
    expect(decDiags.find((d) => d.code === "BUNEST_DEC005")!.message).toContain(
      "PostEntity.author",
    );
  });

  it("supports build-time AOT optimizations (BaseEntity/applyDecorators macro registration, aotMacros, aotDiMetadata)", () => {
    const source = `
import { applyDecorators, Data, Injectable } from "@bunest/core";
import { BaseEntity } from "@bunest/orm";
import type { ConfigShape } from "./types";

export const DomainModel = () => applyDecorators(BaseEntity(), Data());

@DomainModel()
export class InvoiceModel {
  code!: string;
  amount!: number;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly invoice: InvoiceModel,
    private readonly cfg: ConfigShape,
    private readonly retries: number,
  ) {}
}
`;

    const res = transformBunestSource(source, "/virtual/billing.ts", {
      classMacros: true,
      aotMacros: true,
      aotDiMetadata: true,
      swaggerMetadata: false,
      ormCircularSafe: false,
    });

    expect(res.modified).toBe(true);
    expect(res.stagesApplied).toContain("classMacros");
    expect(res.stagesApplied).toContain("aotMacros");
    expect(res.stagesApplied).toContain("aotDiMetadata");

    // Stage 1 + Stage 6 recognized same-file `applyDecorators(BaseEntity(), Data())`
    expect(res.code).toContain(
      'registerMacroFields(InvoiceModel, ["code","amount"]);',
    );
    expect(res.code).toContain(
      'registerCompiledMacroPlan(InvoiceModel, { fields: ["code","amount"], skipProbe: true });',
    );

    // Stage 7 emitted TDZ-safe MetadataRegistry.define("design:paramtypes", ...)
    expect(res.code).toContain(
      'if (!MetadataRegistry.hasOwn("design:paramtypes", BillingService))',
    );
    expect(res.code).toContain('typeof InvoiceModel === "undefined" ? Object : InvoiceModel');
    // `import type { ConfigShape }` safely maps to Object (not a dangling runtime reference!)
    expect(res.code).not.toContain("typeof ConfigShape");
    expect(res.code).toContain("Number");
    expect(res.aotDiClasses?.[0]?.className).toBe("BillingService");
  });
});
