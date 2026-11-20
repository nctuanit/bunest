import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  BaseSqliteRepository,
  SqliteEntityNotFoundException,
  SqliteService,
} from "../../../../../packages/sqlite/src";
import { describeConformance } from "../../../_helpers/index";

interface ProductRow extends Record<string, unknown> {
  id: number;
  sku: string;
  tenant: string;
  name: string;
  price: number;
  category: string;
  notes: string | null;
}

describeConformance(
  "Persistence (bun-native) - BaseSqliteRepository CRUD, upsert, pagination & guardrails",
  {
    upstreamPath: "bun-native/base-sqlite-repository",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Exhaustive conformance suite for BaseSqliteRepository CRUD, batch insertMany, upsert conflict handling, projection, sorting, pagination, IS NULL matching, iterate, and strictWhere guardrails.",
  },
  () => {
    const openServices: SqliteService[] = [];

    const setup = (): {
      db: SqliteService;
      repo: BaseSqliteRepository<ProductRow, number>;
    } => {
      const db = new SqliteService({ filename: ":memory:" });
      openServices.push(db);
      db.exec(`
        CREATE TABLE products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sku TEXT UNIQUE NOT NULL,
          tenant TEXT NOT NULL DEFAULT 'acme',
          name TEXT NOT NULL,
          price INTEGER NOT NULL,
          category TEXT NOT NULL,
          notes TEXT,
          UNIQUE(tenant, name)
        );
      `);
      const repo = new BaseSqliteRepository<ProductRow, number>(db, "products");
      return { db, repo };
    };

    afterEach(() => {
      while (openServices.length > 0) {
        openServices.pop()!.close();
      }
    });

    it("exposes executor, table, and primaryKeyColumn metadata getters", () => {
      const { db, repo } = setup();
      expect(repo.executor).toBe(db);
      expect(repo.table).toBe("products");
      expect(repo.primaryKeyColumn).toBe("id");

      const customPk = new BaseSqliteRepository<ProductRow, string>(
        db,
        "products",
        "sku",
      );
      expect(customPk.primaryKeyColumn).toBe("sku");
    });

    it("inserts rows via insert() and insertReturning()", () => {
      const { repo } = setup();

      const res = repo.insert({
        sku: "SKU-1",
        tenant: "acme",
        name: "Keyboard",
        price: 120,
        category: "hardware",
        notes: null,
      });
      expect(res.changes).toBe(1);
      expect(res.lastInsertRowid).toBe(1);

      const created = repo.insertReturning({
        sku: "SKU-2",
        tenant: "acme",
        name: "Mouse",
        price: 50,
        category: "hardware",
        notes: "wireless",
      });
      expect(created).toEqual({
        id: 2,
        sku: "SKU-2",
        tenant: "acme",
        name: "Mouse",
        price: 50,
        category: "hardware",
        notes: "wireless",
      });
    });

    it("inserts batches atomically via insertMany() and rolls back entire batch on UNIQUE constraint failure", () => {
      const { repo } = setup();

      expect(repo.insertMany([])).toEqual({ changes: 0, lastInsertRowid: 0 });

      const batch = repo.insertMany([
        { sku: "B1", tenant: "acme", name: "Item 1", price: 10, category: "a" },
        { sku: "B2", tenant: "acme", name: "Item 2", price: 20, category: "a" },
      ]);
      expect(batch.changes).toBe(2);
      expect(repo.count()).toBe(2);

      // Batch where second row violates UNIQUE(sku) rolls back first row too!
      expect(() =>
        repo.insertMany([
          {
            sku: "B3",
            tenant: "acme",
            name: "Item 3",
            price: 30,
            category: "a",
          },
          {
            sku: "B1",
            tenant: "acme",
            name: "Dup SKU",
            price: 40,
            category: "a",
          },
        ]),
      ).toThrow(/UNIQUE/i);

      expect(repo.count()).toBe(2);
      expect(repo.findOneWhere({ sku: "B3" })).toBeNull();
    });

    it("supports upsert() on single conflict column, composite conflict columns, custom updateColumns, and DO NOTHING", () => {
      const { repo } = setup();

      // 1. Insert then update on single conflict column ("sku")
      repo.upsert(
        {
          sku: "U1",
          tenant: "acme",
          name: "Lamp",
          price: 30,
          category: "home",
          notes: "v1",
        },
        "sku",
      );
      repo.upsert(
        {
          sku: "U1",
          tenant: "acme",
          name: "LED Lamp",
          price: 45,
          category: "home",
          notes: "v2",
        },
        "sku",
      );
      expect(repo.findOneWhereOrFail({ sku: "U1" })).toMatchObject({
        name: "LED Lamp",
        price: 45,
        notes: "v2",
      });

      // 2. Custom updateColumns updates ONLY listed column(s)
      repo.upsert(
        {
          sku: "U1",
          tenant: "acme",
          name: "ShouldNotChange",
          price: 99,
          category: "ignored",
          notes: "ignored",
        },
        "sku",
        ["price"],
      );
      expect(repo.findOneWhereOrFail({ sku: "U1" })).toMatchObject({
        name: "LED Lamp",
        price: 99,
        notes: "v2",
      });

      // 3. Explicit empty updateColumns -> DO NOTHING
      repo.upsert(
        {
          sku: "U1",
          tenant: "acme",
          name: "NoOp",
          price: 1,
          category: "home",
        },
        ["sku"],
        [],
      );
      expect(repo.findOneWhereOrFail({ sku: "U1" }).price).toBe(99);

      // 4. Composite conflict columns: ["tenant", "name"]
      repo.upsert(
        {
          sku: "U2",
          tenant: "acme",
          name: "LED Lamp",
          price: 75,
          category: "lighting",
          notes: "composite-updated",
        },
        ["tenant", "name"],
        ["price", "notes"],
      );
      expect(repo.findOneWhereOrFail({ sku: "U1" })).toMatchObject({
        price: 75,
        notes: "composite-updated",
      });

      // 5. Empty conflictColumns array rejected
      expect(() =>
        repo.upsert(
          { sku: "U3", tenant: "acme", name: "X", price: 1, category: "x" },
          [],
        ),
      ).toThrow(/at least one conflict column/);
    });

    it("supports findById(), findByIdOrFail(), findWhere(), findOneWhere(), and findOneWhereOrFail()", () => {
      const { repo } = setup();
      const p1 = repo.insertReturning({
        sku: "F1",
        tenant: "acme",
        name: "Book",
        price: 20,
        category: "books",
      });
      repo.insert({
        sku: "F2",
        tenant: "acme",
        name: "Pen",
        price: 5,
        category: "office",
      });

      expect(repo.findById(p1.id)).toEqual(p1);
      expect(repo.findById(9999)).toBeNull();
      expect(repo.findByIdOrFail(p1.id)).toEqual(p1);
      expect(() => repo.findByIdOrFail(9999)).toThrow(
        SqliteEntityNotFoundException,
      );

      expect(repo.findWhere({ category: "books" })).toEqual([p1]);
      expect(repo.findOneWhere({ category: "office" })?.sku).toBe("F2");
      expect(repo.findOneWhere({ category: "missing" })).toBeNull();
      expect(repo.findOneWhereOrFail({ sku: "F2" }).name).toBe("Pen");
      expect(() => repo.findOneWhereOrFail({ sku: "NONE" })).toThrow(
        SqliteEntityNotFoundException,
      );
    });

    it("supports findAndCount() with paginated rows and full matching total count", () => {
      const { repo } = setup();
      repo.insertMany([
        { sku: "P1", tenant: "acme", name: "A", price: 10, category: "hw" },
        { sku: "P2", tenant: "acme", name: "B", price: 30, category: "hw" },
        { sku: "P3", tenant: "acme", name: "C", price: 20, category: "hw" },
        { sku: "P4", tenant: "acme", name: "D", price: 99, category: "sw" },
      ]);

      const [page, total] = repo.findAndCount(
        { category: "hw" },
        { orderBy: "price", order: "DESC", limit: 2, offset: 0 },
      );
      expect(total).toBe(3);
      expect(page.map((r) => r.sku)).toEqual(["P2", "P3"]);

      const [allSlice, allTotal] = repo.findAndCount(undefined, {
        limit: 1,
        offset: 1,
        orderBy: "sku",
      });
      expect(allTotal).toBe(4);
      expect(allSlice.map((r) => r.sku)).toEqual(["P2"]);
    });

    it("streams rows lazily via iterate() with filtering, projection, sorting, and pagination", () => {
      const { repo } = setup();
      repo.insertMany([
        { sku: "I1", tenant: "acme", name: "One", price: 10, category: "cat" },
        { sku: "I2", tenant: "acme", name: "Two", price: 20, category: "cat" },
        { sku: "I3", tenant: "acme", name: "Three", price: 30, category: "cat" },
      ]);

      const rows = [
        ...repo.iterate(
          { category: "cat" },
          { select: ["sku", "price"], orderBy: "price", order: "DESC", limit: 2 },
        ),
      ];
      expect(rows as unknown as Array<{ sku: string; price: number }>).toEqual([
        { sku: "I3", price: 30 },
        { sku: "I2", price: 20 },
      ]);
    });

    it("supports count(), exists(), existsWhere(), updateById(), updateWhere(), deleteById(), and deleteWhere()", () => {
      const { repo } = setup();
      const first = repo.insertReturning({
        sku: "C1",
        tenant: "acme",
        name: "Chair",
        price: 100,
        category: "furniture",
      });
      repo.insert({
        sku: "C2",
        tenant: "acme",
        name: "Desk",
        price: 200,
        category: "furniture",
      });
      repo.insert({
        sku: "C3",
        tenant: "acme",
        name: "Mug",
        price: 15,
        category: "kitchen",
      });

      expect(repo.count()).toBe(3);
      expect(repo.count({ category: "furniture" })).toBe(2);
      expect(repo.exists(first.id)).toBe(true);
      expect(repo.exists(999)).toBe(false);
      expect(repo.existsWhere({ category: "kitchen" })).toBe(true);
      expect(repo.existsWhere({ category: "toys" })).toBe(false);

      expect(repo.updateById(first.id, { price: 125 }).changes).toBe(1);
      expect(repo.findByIdOrFail(first.id).price).toBe(125);

      expect(
        repo.updateWhere({ category: "furniture" }, { notes: "sale" }).changes,
      ).toBe(2);
      expect(repo.count({ notes: "sale" })).toBe(2);

      expect(repo.deleteById(first.id).changes).toBe(1);
      expect(repo.exists(first.id)).toBe(false);

      expect(repo.deleteWhere({ category: "furniture" }).changes).toBe(1);
      expect(repo.count()).toBe(1);
    });

    it("supports select projection, single & multi-column orderBy, limit: 0, and offset without limit", () => {
      const { repo } = setup();
      repo.insertMany([
        { sku: "S1", tenant: "acme", name: "B", price: 10, category: "x" },
        { sku: "S2", tenant: "acme", name: "A", price: 10, category: "x" },
        { sku: "S3", tenant: "acme", name: "C", price: 20, category: "x" },
        { sku: "S4", tenant: "acme", name: "D", price: 30, category: "x" },
      ]);

      // Multi-column orderBy with mixed specs & select projection
      const sorted = repo.findAll({
        select: ["sku", "price", "name"],
        orderBy: [
          { column: "price", order: "ASC" },
          { column: "name", order: "ASC" },
        ],
      });
      expect(
        sorted as unknown as Array<{ sku: string; price: number; name: string }>,
      ).toEqual([
        { sku: "S2", price: 10, name: "A" },
        { sku: "S1", price: 10, name: "B" },
        { sku: "S3", price: 20, name: "C" },
        { sku: "S4", price: 30, name: "D" },
      ]);

      // offset without limit uses LIMIT -1
      const skipped = repo.findAll({ orderBy: "sku", offset: 2 });
      expect(skipped.map((r) => r.sku)).toEqual(["S3", "S4"]);

      // limit: 0 returns empty array
      expect(repo.findAll({ limit: 0 })).toEqual([]);
    });

    it("translates null filter values into SQL IS NULL predicates", () => {
      const { repo } = setup();
      repo.insertMany([
        {
          sku: "N1",
          tenant: "acme",
          name: "NullNotes",
          price: 10,
          category: "c",
          notes: null,
        },
        {
          sku: "N2",
          tenant: "acme",
          name: "HasNotes",
          price: 20,
          category: "c",
          notes: "present",
        },
      ]);

      expect(repo.findWhere({ notes: null }).map((r) => r.sku)).toEqual(["N1"]);
      expect(repo.count({ notes: null })).toBe(1);
      expect(repo.existsWhere({ notes: null })).toBe(true);

      const updated = repo.updateWhere({ notes: null }, { notes: "filled" });
      expect(updated.changes).toBe(1);
      expect(repo.count({ notes: null })).toBe(0);

      repo.insert({
        sku: "N3",
        tenant: "acme",
        name: "NullToDelete",
        price: 5,
        category: "c",
        notes: null,
      });
      expect(repo.deleteWhere({ notes: null }).changes).toBe(1);
      expect(repo.findOneWhere({ sku: "N3" })).toBeNull();
    });

    it("enforces strictWhere: true by default and allows explicit strictWhere: false opt-out", () => {
      const { repo } = setup();
      repo.insert({
        sku: "W1",
        tenant: "acme",
        name: "Item",
        price: 10,
        category: "c",
      });

      expect(() => repo.findWhere({ sku: undefined })).toThrow(
        /Refusing to execute unfiltered query/,
      );
      expect(() => repo.findOneWhere({ sku: undefined })).toThrow(
        /Refusing to execute unfiltered query/,
      );
      expect(() => repo.count({ sku: undefined })).toThrow(
        /Refusing to execute unfiltered query/,
      );
      expect(() => repo.existsWhere({ sku: undefined })).toThrow(
        /Refusing to execute unfiltered query/,
      );
      expect(() => [...repo.iterate({ sku: undefined })]).toThrow(
        /Refusing to execute unfiltered query/,
      );

      // Explicit opt-out
      expect(
        repo.findWhere({ sku: undefined }, { strictWhere: false }),
      ).toHaveLength(1);
      expect(repo.count({ sku: undefined }, { strictWhere: false })).toBe(1);
      expect(
        repo.existsWhere({ sku: undefined }, { strictWhere: false }),
      ).toBe(true);

      // Empty `{}` has 0 keys and is explicitly unfiltered for reads
      expect(repo.findWhere({})).toHaveLength(1);
    });

    it("rejects empty insert/update payloads and unfiltered updateWhere/deleteWhere calls", () => {
      const { repo } = setup();
      repo.insert({
        sku: "G1",
        tenant: "acme",
        name: "Guarded",
        price: 10,
        category: "c",
      });

      expect(() => repo.insert({})).toThrow(/empty object/);
      expect(() => repo.insert({ sku: undefined })).toThrow(/empty object/);
      expect(() => repo.updateById(1, {})).toThrow(/empty object/);
      expect(() => repo.updateById(1, { name: undefined })).toThrow(
        /empty object/,
      );
      expect(() => repo.updateWhere({ sku: "G1" }, {})).toThrow(/empty object/);
      expect(() => repo.updateWhere({}, { price: 99 })).toThrow(
        /at least one filter/,
      );
      expect(() => repo.updateWhere({ sku: undefined }, { price: 99 })).toThrow(
        /Refusing to execute unfiltered query/,
      );
      expect(() => repo.deleteWhere({})).toThrow(/at least one filter/);
      expect(() => repo.deleteWhere({ sku: undefined })).toThrow(
        /Refusing to execute unfiltered query/,
      );
      // Original row untouched
      expect(repo.findOneWhereOrFail({ sku: "G1" }).price).toBe(10);
    });
  },
);
