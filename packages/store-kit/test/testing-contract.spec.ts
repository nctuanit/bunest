import { describe, expect, it } from "bun:test";
import type {
  SqlExecuteResult,
  SqlExecutor,
  SqlIsolationLevel,
  SqlTransaction,
  SqlTransactionOptions,
} from "../src/index";
import { notATransaction } from "../src/sql/not-a-transaction";
import { isolationSql } from "../src/utils/executor.util";
import { runTransactionWork } from "../src/postgres/executors/transaction-work";
import {
  type SqlExecutorContractTarget,
  sqlExecutorContract,
} from "../src/testing/index";

/**
 * In-memory PostgreSQL-compatible fake engine that supports the full `sqlExecutorContract()`
 * suite (DDL, parameterized SELECT/INSERT/UPDATE/DELETE/RETURNING, transactions with rollback,
 * savepoints, aborted transaction state, isolation levels, txid_current(), and JSONB).
 */
function createInMemoryPostgresTarget(): SqlExecutorContractTarget {
  type Row = Record<string, string | null>;
  let tables = new Map<string, Map<string, Row>>();
  let nextTxId = 100;
  const activeTx = new WeakSet<object>();

  interface TxState {
    id: number;
    isolation: SqlIsolationLevel;
    aborted: boolean;
    snapshot: Map<string, Map<string, Row>>;
    savepoints: Map<string, Map<string, Map<string, Row>>>;
  }

  function cloneTables(src: Map<string, Map<string, Row>>) {
    const out = new Map<string, Map<string, Row>>();
    for (const [k, v] of src) {
      const m = new Map<string, Row>();
      for (const [rk, rv] of v) m.set(rk, { ...rv });
      out.set(k, m);
    }
    return out;
  }

  function execSql(
    text: string,
    params: readonly unknown[],
    tx?: TxState,
  ): { rows: any[]; affectedRows: number } {
    const trimmed = text.trim();
    if (tx?.aborted) {
      if (/^ROLLBACK TO SAVEPOINT\s+(\w+)$/i.test(trimmed)) {
        const sp = /^ROLLBACK TO SAVEPOINT\s+(\w+)$/i.exec(trimmed)![1]!;
        const snap = tx.savepoints.get(sp);
        if (!snap) throw new Error(`savepoint ${sp} does not exist`);
        tx.snapshot = cloneTables(snap);
        tx.aborted = false;
        return { rows: [], affectedRows: 0 };
      }
      throw Object.assign(
        new Error(
          "current transaction is aborted, commands ignored until end of transaction block",
        ),
        { code: "25P02" },
      );
    }

    const store = tx ? tx.snapshot : tables;
    const fail = (err: Error): never => {
      if (tx) tx.aborted = true;
      throw err;
    };

    if (/^CREATE TABLE\s+(\w+)/i.test(trimmed)) {
      const tbl = /^CREATE TABLE\s+(\w+)/i.exec(trimmed)![1]!;
      store.set(tbl, new Map());
      return { rows: [], affectedRows: 0 };
    }
    if (/^DROP TABLE IF EXISTS\s+(\w+)/i.test(trimmed)) {
      const tbl = /^DROP TABLE IF EXISTS\s+(\w+)/i.exec(trimmed)![1]!;
      store.delete(tbl);
      return { rows: [], affectedRows: 0 };
    }
    if (/^SAVEPOINT\s+(\w+)$/i.test(trimmed)) {
      const sp = /^SAVEPOINT\s+(\w+)$/i.exec(trimmed)![1]!;
      tx?.savepoints.set(sp, cloneTables(store));
      return { rows: [], affectedRows: 0 };
    }
    if (trimmed === "SELECT 1") {
      return { rows: [{ "?column?": 1 }], affectedRows: 0 };
    }
    if (trimmed === "SELECT 1 / 0") {
      fail(new Error("division by zero"));
    }
    if (trimmed === "SELECT 'next'::text AS status") {
      return { rows: [{ status: "next" }], affectedRows: 0 };
    }
    if (trimmed.includes("current_setting('transaction_isolation')")) {
      return {
        rows: [{ level: tx?.isolation ?? "read committed" }],
        affectedRows: 0,
      };
    }
    if (trimmed.includes("current_setting('default_transaction_isolation')")) {
      return { rows: [{ level: "read committed" }], affectedRows: 0 };
    }
    if (trimmed.includes("txid_current()")) {
      return {
        rows: [{ id: String(tx ? tx.id : ++nextTxId) }],
        affectedRows: 0,
      };
    }
    if (trimmed.startsWith("SELECT $2::text AS first_value")) {
      return {
        rows: [
          {
            first_value: params[1] ?? null,
            second_value: params[0] ?? null,
            big_value: params[2] == null ? null : String(params[2]),
          },
        ],
        affectedRows: 0,
      };
    }

    // INSERT INTO table (id) VALUES ($1::text)
    const ins1 = /^INSERT INTO (\w+) \(id\) VALUES \(\$1::text\)$/i.exec(
      trimmed,
    );
    if (ins1) {
      const t = store.get(ins1[1]!)!;
      const id = String(params[0]);
      if (t.has(id)) fail(new Error(`duplicate key value violates unique constraint`));
      t.set(id, { id, small_n: null, big_n: null, is_flag: null, doc_json: null, note_text: null });
      return { rows: [], affectedRows: 1 };
    }

    // INSERT INTO table (id, small_n) VALUES ($1::text, 1), ($2::text, 1)
    const ins2 =
      /^INSERT INTO (\w+) \(id, small_n\) VALUES \(\$1::text, 1\), \(\$2::text, 1\)$/i.exec(
        trimmed,
      );
    if (ins2) {
      const t = store.get(ins2[1]!)!;
      for (const p of params) {
        const id = String(p);
        if (t.has(id)) fail(new Error("duplicate key"));
        t.set(id, { id, small_n: "1", big_n: null, is_flag: null, doc_json: null, note_text: null });
      }
      return { rows: [], affectedRows: params.length };
    }

    // Full 6-column INSERT
    const insFull = /^INSERT INTO (\w+) \(id, small_n, big_n, is_flag, doc_json, note_text\)/i.exec(
      trimmed,
    );
    if (insFull) {
      const t = store.get(insFull[1]!)!;
      const id = String(params[0]);
      if (t.has(id)) fail(new Error("duplicate key"));
      t.set(id, {
        id,
        small_n: params[1] == null ? null : String(params[1]),
        big_n: params[2] == null ? null : String(params[2]),
        is_flag: params[3] == null ? null : String(params[3]),
        doc_json: params[4] == null ? null : String(params[4]),
        note_text: params[5] == null ? null : String(params[5]),
      });
      return { rows: [], affectedRows: 1 };
    }

    // UPDATE table SET small_n = small_n WHERE id IN (...)
    const updIn = /^UPDATE (\w+) SET small_n = small_n WHERE id IN/i.exec(trimmed);
    if (updIn) {
      const t = store.get(updIn[1]!)!;
      let matched = 0;
      for (const p of params) {
        if (t.has(String(p))) matched++;
      }
      return { rows: [], affectedRows: matched };
    }

    // UPDATE table SET note_text = $1::text WHERE id = $2::text
    const updNote =
      /^UPDATE (\w+) SET note_text = \$1::text WHERE id = \$2::text$/i.exec(
        trimmed,
      );
    if (updNote) {
      const t = store.get(updNote[1]!)!;
      const row = t.get(String(params[1]));
      if (!row) return { rows: [], affectedRows: 0 };
      row.note_text = params[0] == null ? null : String(params[0]);
      return { rows: [], affectedRows: 1 };
    }

    // DELETE FROM table WHERE id = $1::text [RETURNING id]
    const delOne =
      /^DELETE FROM (\w+) WHERE id = \$1::text(\s+RETURNING id)?$/i.exec(
        trimmed,
      );
    if (delOne) {
      const t = store.get(delOne[1]!)!;
      const id = String(params[0]);
      const existed = t.delete(id);
      return {
        rows: existed && delOne[2] ? [{ id }] : [],
        affectedRows: existed ? 1 : 0,
      };
    }

    // DELETE FROM table
    const delAll = /^DELETE FROM (\w+)$/i.exec(trimmed);
    if (delAll) {
      const t = store.get(delAll[1]!)!;
      const count = t.size;
      t.clear();
      return { rows: [], affectedRows: count };
    }

    // SELECT id FROM table [WHERE id = $1::text]
    const selId = /^SELECT id FROM (\w+)(?: WHERE id = \$1::text)?$/i.exec(
      trimmed,
    );
    if (selId) {
      const t = store.get(selId[1]!)!;
      if (params.length === 1) {
        const row = t.get(String(params[0]));
        return { rows: row ? [{ id: row.id }] : [], affectedRows: 0 };
      }
      return {
        rows: [...t.values()].map((r) => ({ id: r.id })),
        affectedRows: 0,
      };
    }

    // SELECT columns(...) FROM table t WHERE t.id = $1::text
    const selFull = /FROM (\w+) t WHERE t\.id = \$1::text$/i.exec(trimmed);
    if (selFull) {
      const t = store.get(selFull[1]!)!;
      const row = t.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [], affectedRows: 0 };
    }

    throw new Error(`Unhandled PG SQL in contract test mock: ${trimmed}`);
  }

  const rootClient = { kind: "in-memory-pg-root" };

  function makeNativeTx(state: TxState) {
    const nativeTx = {
      state,
      query: async (text: string, params: readonly unknown[] = []) =>
        execSql(text, params, state).rows,
      execute: async (text: string, params: readonly unknown[] = []) => ({
        affectedRows: execSql(text, params, state).affectedRows,
      }),
    };
    activeTx.add(nativeTx);
    return nativeTx;
  }

  async function runTx<T>(
    work: (nativeTx: ReturnType<typeof makeNativeTx>) => Promise<T>,
    isolation: SqlIsolationLevel = "read committed",
  ): Promise<T> {
    const state: TxState = {
      id: ++nextTxId,
      isolation,
      aborted: false,
      snapshot: cloneTables(tables),
      savepoints: new Map(),
    };
    const nativeTx = makeNativeTx(state);
    try {
      const res = await work(nativeTx);
      if (!state.aborted) {
        tables = state.snapshot;
      }
      return res;
    } finally {
      activeTx.delete(nativeTx);
    }
  }

  const executor: SqlExecutor<"postgres"> = {
    dialect: "postgres",
    query: async <R extends object>(text: string, params: readonly unknown[] = []) =>
      execSql(text, params).rows as R[],
    execute: async (
      text: string,
      params: readonly unknown[] = [],
    ): Promise<SqlExecuteResult> => ({
      affectedRows: execSql(text, params).affectedRows,
    }),
    transaction: async <T>(
      work: (transaction: SqlTransaction) => Promise<T>,
      options: SqlTransactionOptions = {},
    ): Promise<T> => {
      if (options.isolationLevel) {
        isolationSql(options.isolationLevel);
      }
      return runTx(
        (nativeTx) =>
          runTransactionWork(work, {
            query: nativeTx.query,
            execute: nativeTx.execute,
            native: nativeTx,
          }),
        options.isolationLevel ?? "read committed",
      );
    },
    wrapTransaction: (transaction: unknown): SqlTransaction => {
      if (
        typeof transaction !== "object" ||
        transaction === null ||
        !activeTx.has(transaction)
      ) {
        throw notATransaction("Not an active in-memory PG transaction");
      }
      const nativeTx = transaction as ReturnType<typeof makeNativeTx>;
      return {
        query: nativeTx.query,
        execute: nativeTx.execute,
        native: nativeTx,
      };
    },
  };

  return {
    executor,
    root: rootClient,
    transaction: (work) => runTx((nativeTx) => work(nativeTx)),
  };
}

/**
 * In-memory MySQL-compatible fake engine that runs the entire MySQL `sqlExecutorContract()` suite.
 */
function createInMemoryMySqlTarget(): SqlExecutorContractTarget {
  type Row = Record<string, string | null>;
  let tables = new Map<string, Map<string, Row>>();
  let nextEventId = 100;
  const activeTx = new WeakSet<object>();

  interface TxState {
    eventId: number;
    isolation: SqlIsolationLevel;
    snapshot: Map<string, Map<string, Row>>;
  }

  function cloneTables(src: Map<string, Map<string, Row>>) {
    const out = new Map<string, Map<string, Row>>();
    for (const [k, v] of src) {
      const m = new Map<string, Row>();
      for (const [rk, rv] of v) m.set(rk, { ...rv });
      out.set(k, m);
    }
    return out;
  }

  function applyJsonPath(root: any, path: string, val: number): any {
    if (path === "$") return val;
    const tokens: Array<string | number> = [];
    const rest = path.slice(1);
    const re = /\."((?:\\.|[^"\\])*)"|\[(\d+)\]/g;
    for (const m of rest.matchAll(re)) {
      if (m[1] !== undefined) tokens.push(JSON.parse(`"${m[1]}"`));
      else if (m[2] !== undefined) tokens.push(Number(m[2]));
    }
    let cur = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      cur = cur[tokens[i]!];
    }
    const lastKey = tokens.at(-1)!;
    Object.defineProperty(cur, lastKey, {
      value: val,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return root;
  }

  function evalJsonParam(
    expr: string,
    params: readonly unknown[],
    startIdx: number,
  ): { value: string | null; consumed: number } {
    if (expr.startsWith("JSON_SET(JSON_EXTRACT(?, '$')")) {
      const pairs = (expr.match(/\?, CAST\(\? AS DOUBLE\)/g) ?? []).length;
      const baseText = params[startIdx];
      let doc = JSON.parse(String(baseText));
      for (let i = 0; i < pairs; i++) {
        const p = String(params[startIdx + 1 + i * 2]);
        const v = Number(params[startIdx + 2 + i * 2]);
        doc = applyJsonPath(doc, p, v);
      }
      return { value: JSON.stringify(doc), consumed: 1 + pairs * 2 };
    }
    const raw = params[startIdx];
    return {
      value: raw == null ? null : String(raw),
      consumed: 1,
    };
  }

  function execSql(
    text: string,
    params: readonly unknown[],
    tx?: TxState,
  ): { rows: any[]; affectedRows: number } {
    const trimmed = text.trim();
    const store = tx ? tx.snapshot : tables;

    if (/^CREATE TABLE\s+(\w+)/i.test(trimmed)) {
      const tbl = /^CREATE TABLE\s+(\w+)/i.exec(trimmed)![1]!;
      store.set(tbl, new Map());
      return { rows: [], affectedRows: 0 };
    }
    if (/^DROP TABLE IF EXISTS\s+(\w+)/i.test(trimmed)) {
      const tbl = /^DROP TABLE IF EXISTS\s+(\w+)/i.exec(trimmed)![1]!;
      store.delete(tbl);
      return { rows: [], affectedRows: 0 };
    }
    if (trimmed === "SELECT ? AS status") {
      return { rows: [{ status: params[0] }], affectedRows: 0 };
    }
    if (trimmed.startsWith("SELECT ? AS first_param")) {
      return {
        rows: [
          {
            first_param: params[0] ?? null,
            second_param: params[1] ?? null,
            big_param: params[2] == null ? null : String(params[2]),
          },
        ],
        affectedRows: 0,
      };
    }
    if (trimmed.includes("@@session.transaction_isolation AS level")) {
      return { rows: [{ level: "REPEATABLE-READ" }], affectedRows: 0 };
    }
    if (trimmed.includes("ISOLATION_LEVEL AS level")) {
      return {
        rows: [
          {
            level: (tx?.isolation ?? "repeatable read").toUpperCase(),
            connection: "REPEATABLE-READ",
          },
        ],
        affectedRows: 0,
      };
    }
    if (trimmed.includes("CONCAT(THREAD_ID, ':', EVENT_ID)")) {
      return {
        rows: [{ id: `1:${tx ? tx.eventId : ++nextEventId}` }],
        affectedRows: 0,
      };
    }
    if (trimmed.includes("_missing")) {
      throw new Error("Table doesn't exist");
    }
    if (trimmed.includes("FROM JSON_TABLE(")) {
      const exprStart = trimmed.indexOf("FROM JSON_TABLE(") + "FROM JSON_TABLE(".length;
      const exprEnd = trimmed.indexOf(", '$[*]'", exprStart);
      const jsonExpr = trimmed.slice(exprStart, exprEnd);
      const { value } = evalJsonParam(jsonExpr, params, 0);
      const arr = JSON.parse(value!) as Array<{ value: unknown }>;
      return {
        rows: arr.map((item, idx) => ({
          n: String(idx + 1),
          value: JSON.stringify(item.value),
        })),
        affectedRows: 0,
      };
    }

    const ins1 = /^INSERT INTO (\w+) \(id\) VALUES \(\?\)$/i.exec(trimmed);
    if (ins1) {
      const t = store.get(ins1[1]!)!;
      const id = String(params[0]);
      if (t.has(id)) throw new Error(`Duplicate entry '${id}' for key 'PRIMARY'`);
      t.set(id, { id, small_n: null, big_n: null, is_flag: null, doc_json: null, note_text: null });
      return { rows: [], affectedRows: 1 };
    }

    const ins2 = /^INSERT INTO (\w+) \(id, small_n\) VALUES \(\?, 1\), \(\?, 1\)$/i.exec(
      trimmed,
    );
    if (ins2) {
      const t = store.get(ins2[1]!)!;
      for (const p of params) {
        const id = String(p);
        if (t.has(id)) throw new Error(`Duplicate entry '${id}'`);
        t.set(id, { id, small_n: "1", big_n: null, is_flag: null, doc_json: null, note_text: null });
      }
      return { rows: [], affectedRows: params.length };
    }

    const insFull = /^INSERT INTO (\w+) \(id, small_n, big_n, is_flag, doc_json, note_text\)\s+VALUES \(([\s\S]+)\)$/i.exec(
      trimmed,
    );
    if (insFull) {
      const t = store.get(insFull[1]!)!;
      const vals = insFull[2]!;
      const id = String(params[0]);
      if (t.has(id)) throw new Error(`Duplicate entry '${id}'`);
      // params[0]=id, params[1]=small_n, params[2]=big_n, params[3]=is_flag, params[4..]=json, last=note_text
      const jsonMatch = /(JSON_SET\(JSON_EXTRACT\(\?, '\$'\)[^)]*(?:\)[^)]*)*\)|JSON_EXTRACT\(\?, '\$'\))/.exec(vals);
      const { value: docJson, consumed } = evalJsonParam(jsonMatch![1]!, params, 4);
      const noteText = params[4 + consumed];
      t.set(id, {
        id,
        small_n: params[1] == null ? null : String(params[1]),
        big_n: params[2] == null ? null : String(params[2]),
        is_flag: params[3] == null ? null : String(params[3]),
        doc_json: docJson,
        note_text: noteText == null ? null : String(noteText),
      });
      return { rows: [], affectedRows: 1 };
    }

    const updIn = /^UPDATE (\w+) SET small_n = small_n WHERE id IN/i.exec(trimmed);
    if (updIn) {
      const t = store.get(updIn[1]!)!;
      let matched = 0;
      for (const p of params) {
        if (t.has(String(p))) matched++;
      }
      return { rows: [], affectedRows: matched };
    }

    const updInc = /^UPDATE (\w+) SET small_n = small_n \+ 1 WHERE id = \?$/i.exec(
      trimmed,
    );
    if (updInc) {
      const t = store.get(updInc[1]!)!;
      const row = t.get(String(params[0]));
      if (!row) return { rows: [], affectedRows: 0 };
      row.small_n = String(Number(row.small_n ?? 0) + 1);
      return { rows: [], affectedRows: 1 };
    }

    const updNote = /^UPDATE (\w+) SET note_text = \? WHERE id = \?$/i.exec(
      trimmed,
    );
    if (updNote) {
      const t = store.get(updNote[1]!)!;
      const row = t.get(String(params[1]));
      if (!row) return { rows: [], affectedRows: 0 };
      row.note_text = params[0] == null ? null : String(params[0]);
      return { rows: [], affectedRows: 1 };
    }

    const delOne = /^DELETE FROM (\w+) WHERE id = \?$/i.exec(trimmed);
    if (delOne) {
      const t = store.get(delOne[1]!)!;
      const existed = t.delete(String(params[0]));
      return { rows: [], affectedRows: existed ? 1 : 0 };
    }

    const delAll = /^DELETE FROM (\w+)$/i.exec(trimmed);
    if (delAll) {
      const t = store.get(delAll[1]!)!;
      const count = t.size;
      t.clear();
      return { rows: [], affectedRows: count };
    }

    const selId = /^SELECT id FROM (\w+)(?: WHERE id = \?)?$/i.exec(trimmed);
    if (selId) {
      const t = store.get(selId[1]!)!;
      if (params.length === 1) {
        const row = t.get(String(params[0]));
        return { rows: row ? [{ id: row.id }] : [], affectedRows: 0 };
      }
      return {
        rows: [...t.values()].map((r) => ({ id: r.id })),
        affectedRows: 0,
      };
    }

    const selFull = /FROM (\w+) t WHERE t\.id = \?$/i.exec(trimmed);
    if (selFull) {
      const t = store.get(selFull[1]!)!;
      const row = t.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [], affectedRows: 0 };
    }

    throw new Error(`Unhandled MySQL SQL in contract test mock: ${trimmed}`);
  }

  const rootClient = { kind: "in-memory-mysql-root" };

  function makeNativeTx(state: TxState) {
    const nativeTx = {
      state,
      query: async (text: string, params: readonly unknown[] = []) =>
        execSql(text, params, state).rows,
      execute: async (text: string, params: readonly unknown[] = []) => ({
        affectedRows: execSql(text, params, state).affectedRows,
      }),
    };
    activeTx.add(nativeTx);
    return nativeTx;
  }

  async function runTx<T>(
    work: (nativeTx: ReturnType<typeof makeNativeTx>) => Promise<T>,
    isolation: SqlIsolationLevel = "repeatable read",
  ): Promise<T> {
    const state: TxState = {
      eventId: ++nextEventId,
      isolation,
      snapshot: cloneTables(tables),
    };
    const nativeTx = makeNativeTx(state);
    try {
      const res = await work(nativeTx);
      tables = state.snapshot;
      return res;
    } finally {
      activeTx.delete(nativeTx);
    }
  }

  const executor: SqlExecutor<"mysql"> = {
    dialect: "mysql",
    query: async <R extends object>(text: string, params: readonly unknown[] = []) =>
      execSql(text, params).rows as R[],
    execute: async (text: string, params: readonly unknown[] = []) => ({
      affectedRows: execSql(text, params).affectedRows,
    }),
    transaction: async <T>(
      work: (transaction: SqlTransaction) => Promise<T>,
      options: SqlTransactionOptions = {},
    ): Promise<T> => {
      if (options.isolationLevel) {
        isolationSql(options.isolationLevel);
      }
      return runTx(
        (nativeTx) =>
          work({
            query: nativeTx.query,
            execute: nativeTx.execute,
            native: nativeTx,
          }),
        options.isolationLevel ?? "repeatable read",
      );
    },
    wrapTransaction: (transaction: unknown): SqlTransaction => {
      if (
        typeof transaction !== "object" ||
        transaction === null ||
        !activeTx.has(transaction)
      ) {
        throw notATransaction("Not an active in-memory MySQL transaction");
      }
      const nativeTx = transaction as ReturnType<typeof makeNativeTx>;
      return {
        query: nativeTx.query,
        execute: nativeTx.execute,
        native: nativeTx,
      };
    },
  };

  return {
    executor,
    root: rootClient,
    transaction: (work) => runTx((nativeTx) => work(nativeTx)),
  };
}

describe("@bunest/store-kit/testing sqlExecutorContract", () => {
  describe("PostgreSQL contract suite (7/7 cases)", () => {
    let disposed = 0;
    const cases = sqlExecutorContract(createInMemoryPostgresTarget, {
      dispose: () => {
        disposed++;
      },
    });
    expect(cases).toHaveLength(7);

    for (const c of cases) {
      it(c.name, async () => {
        await c.run();
      });
    }

    it("invoked dispose for every case", () => {
      expect(disposed).toBe(7);
    });
  });

  describe("MySQL contract suite (7/7 cases)", () => {
    let disposed = 0;
    const cases = sqlExecutorContract(createInMemoryMySqlTarget, {
      dispose: () => {
        disposed++;
      },
    });
    expect(cases).toHaveLength(7);

    for (const c of cases) {
      it(c.name, async () => {
        await c.run();
      });
    }

    it("invoked dispose for every case", () => {
      expect(disposed).toBe(7);
    });
  });

  it("rejects executors with an unsupported dialect", async () => {
    const cases = sqlExecutorContract(() => ({
      executor: { dialect: "sqlite" } as any,
      transaction: async (w) => w({}),
      root: {},
    }));
    await expect(cases[0]!.run()).rejects.toThrow(
      /sqlExecutorContract\(\) covers postgres and mysql executors/,
    );
  });
});
