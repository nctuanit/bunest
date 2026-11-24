import { Database } from "bun:sqlite";
import { QueryFailedError } from "../errors";
import type {
  OrmDialect,
  OrmDocumentDriverLike,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
  OrmSslOption,
} from "../types";
import {
  ObjectId,
  decodeOpMsg,
  encodeOpMsg,
  generateObjectId,
} from "./bson";
import { emitQueryLog } from "./driver.interface";

export interface MongoOrmDriverOptions {
  /**
   * MongoDB connection URL (`mongodb://user:pass@host:27017/mydb?authSource=admin`),
   * OR `":memory:"` / local path for embedded zero-daemon Bun document storage.
   */
  readonly url?: string | URL;
  readonly host?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly username?: string;
  readonly user?: string;
  readonly password?: string | (() => Promise<string> | string);
  readonly database?: string;
  readonly authSource?: string;
  readonly ssl?: OrmSslOption;
  readonly tls?: OrmSslOption;
  readonly logging?: boolean | ((event: OrmQueryLogEvent) => void);
}

interface ParsedMongoConnection {
  readonly isRemote: boolean;
  readonly hostname: string;
  readonly port: number;
  readonly database: string;
  readonly username?: string;
  readonly password?: string;
  readonly authSource: string;
  readonly useTls: boolean;
  readonly localPath: string;
}

function parseMongoConnection(
  options: MongoOrmDriverOptions,
): ParsedMongoConnection {
  const urlRaw = options.url !== undefined ? String(options.url) : undefined;
  const host = options.hostname ?? options.host;

  if (urlRaw && (urlRaw.startsWith("mongodb://") || urlRaw.startsWith("mongodb+srv://"))) {
    const parsed = new URL(urlRaw.replace(/^mongodb\+srv:\/\//, "mongodb://"));
    const dbFromPath = parsed.pathname.replace(/^\/+/, "") || "test";
    const tlsParam = parsed.searchParams.get("tls") ?? parsed.searchParams.get("ssl");
    const useTls =
      urlRaw.startsWith("mongodb+srv://") ||
      tlsParam === "true" ||
      Boolean(options.tls ?? options.ssl);
    return {
      isRemote: true,
      hostname: host ?? parsed.hostname ?? "127.0.0.1",
      port: options.port ?? (parsed.port ? Number(parsed.port) : 27017),
      database: options.database ?? dbFromPath,
      username: options.username ?? options.user ?? (parsed.username ? decodeURIComponent(parsed.username) : undefined),
      password:
        typeof options.password === "string"
          ? options.password
          : parsed.password
            ? decodeURIComponent(parsed.password)
            : undefined,
      authSource:
        options.authSource ?? parsed.searchParams.get("authSource") ?? "admin",
      useTls,
      localPath: ":memory:",
    };
  }

  if (host) {
    return {
      isRemote: true,
      hostname: host,
      port: options.port ?? 27017,
      database: options.database ?? "test",
      username: options.username ?? options.user,
      password: typeof options.password === "string" ? options.password : undefined,
      authSource: options.authSource ?? "admin",
      useTls: Boolean(options.tls ?? options.ssl),
      localPath: ":memory:",
    };
  }

  return {
    isRemote: false,
    hostname: "127.0.0.1",
    port: 27017,
    database: options.database ?? "bunest_mongo",
    authSource: "admin",
    useTls: false,
    localPath:
      options.database &&
      (options.database === ":memory:" ||
        options.database.endsWith(".db") ||
        options.database.endsWith(".sqlite"))
        ? options.database
        : ":memory:",
  };
}

// ============================================================================
// SCRAM-SHA-256 Helpers (Bun native crypto.subtle!)
// ============================================================================

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

async function hmacSha256(key: Uint8Array, msg: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBufferView(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, toArrayBufferView(data)),
  );
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBufferView(data)),
  );
}

async function pbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBufferView(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: toArrayBufferView(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

// ============================================================================
// Native Bun.connect() TCP/TLS MongoDB Wire Protocol (OP_MSG) Transport
// ============================================================================

class BunMongoWireTransport {
  private socket?: Bun.Socket<undefined>;
  private recvBuf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private reqSeq = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (doc: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(private readonly conn: ParsedMongoConnection) {}

  get isConnected(): boolean {
    return this.socket !== undefined;
  }

  async connect(resolvedPassword?: string): Promise<void> {
    if (this.socket) return;

    this.socket = await Bun.connect({
      hostname: this.conn.hostname,
      port: this.conn.port,
      ...(this.conn.useTls ? { tls: true } : {}),
      socket: {
        data: (_socket, chunk) => {
          this.onData(chunk);
        },
        error: (_socket, err) => {
          this.failAllPending(err);
        },
        close: () => {
          this.socket = undefined;
          this.failAllPending(new Error("MongoDB TCP connection closed."));
        },
      },
    });

    // Perform SCRAM-SHA-256 authentication if credentials provided
    if (this.conn.username && resolvedPassword !== undefined) {
      await this.authenticateScramSha256(this.conn.username, resolvedPassword);
    }
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const sock = this.socket;
    this.socket = undefined;
    sock.end();
    this.failAllPending(new Error("MongoDB client disconnected."));
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    const incoming = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const merged = new Uint8Array(this.recvBuf.length + incoming.length);
    merged.set(this.recvBuf);
    merged.set(incoming, this.recvBuf.length);
    this.recvBuf = merged;

    while (this.recvBuf.length >= 4) {
      const view = new DataView(
        this.recvBuf.buffer,
        this.recvBuf.byteOffset,
        this.recvBuf.byteLength,
      );
      const msgLen = view.getInt32(0, true);
      if (msgLen < 21 || this.recvBuf.length < msgLen) {
        break;
      }
      const frame = this.recvBuf.slice(0, msgLen);
      this.recvBuf = this.recvBuf.slice(msgLen);
      try {
        const decoded = decodeOpMsg(frame);
        const handler = this.pending.get(decoded.responseTo);
        if (handler) {
          this.pending.delete(decoded.responseTo);
          handler.resolve(decoded.document);
        }
      } catch (err) {
        this.failAllPending(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async command(
    doc: Record<string, unknown>,
    dbName: string = this.conn.database,
  ): Promise<Record<string, unknown>> {
    if (!this.socket) {
      throw new Error("MongoDB wire transport is not connected.");
    }
    const reqId = ++this.reqSeq;
    const payload = encodeOpMsg(reqId, { ...doc, $db: dbName });

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.socket!.write(payload);
    });

    if (response.ok === 0 || response.ok === false) {
      throw new Error(
        String(response.errmsg ?? `MongoDB command failed (code ${String(response.code ?? "unknown")})`),
      );
    }
    return response;
  }

  private async authenticateScramSha256(
    username: string,
    password: string,
  ): Promise<void> {
    const cleanUser = username.replace(/=/g, "=3D").replace(/,/g, "=2C");
    const clientNonce = Buffer.from(
      crypto.getRandomValues(new Uint8Array(24)),
    ).toString("base64");
    const clientFirstBare = `n=${cleanUser},r=${clientNonce}`;
    const clientFirstMsg = `n,,${clientFirstBare}`;

    const startRes = await this.command(
      {
        saslStart: 1,
        mechanism: "SCRAM-SHA-256",
        payload: new TextEncoder().encode(clientFirstMsg),
        autoAuthorize: 1,
      },
      this.conn.authSource,
    );

    const convId = startRes.conversationId;
    const serverFirstBytes = startRes.payload as Uint8Array;
    const serverFirst = new TextDecoder().decode(serverFirstBytes);
    const parts = Object.fromEntries(
      serverFirst.split(",").map((kv) => {
        const idx = kv.indexOf("=");
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      }),
    );

    const serverNonce = parts.r ?? "";
    const salt = new Uint8Array(Buffer.from(parts.s ?? "", "base64"));
    const iterations = Number(parts.i ?? 4096);

    const saltedPassword = await pbkdf2Sha256(password, salt, iterations);
    const clientKey = await hmacSha256(saltedPassword, "Client Key");
    const storedKey = await sha256(clientKey);
    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
    const clientSignature = await hmacSha256(storedKey, authMessage);
    const clientProof = Buffer.from(xorBytes(clientKey, clientSignature)).toString(
      "base64",
    );
    const clientFinalMsg = `${clientFinalWithoutProof},p=${clientProof}`;

    const contRes = await this.command(
      {
        saslContinue: 1,
        conversationId: convId,
        payload: new TextEncoder().encode(clientFinalMsg),
      },
      this.conn.authSource,
    );

    if (!contRes.done) {
      await this.command(
        {
          saslContinue: 1,
          conversationId: convId,
          payload: new Uint8Array(0),
        },
        this.conn.authSource,
      );
    }
  }
}

// ============================================================================
// MongoDB Filter / Update / Aggregation Evaluator (for Embedded Local Mode)
// ============================================================================

function getNestedValue(doc: Record<string, unknown>, path: string): unknown {
  if (path in doc) return doc[path];
  const parts = path.split(".");
  let curr: unknown = doc;
  for (const part of parts) {
    if (curr === null || curr === undefined || typeof curr !== "object") {
      return undefined;
    }
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr;
}

function setNestedValue(
  doc: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let curr = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (
      curr[key] === undefined ||
      curr[key] === null ||
      typeof curr[key] !== "object"
    ) {
      curr[key] = {};
    }
    curr = curr[key] as Record<string, unknown>;
  }
  curr[parts[parts.length - 1]!] = value;
}

function unsetNestedValue(doc: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let curr: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = curr[parts[i]!];
    if (!next || typeof next !== "object") return;
    curr = next as Record<string, unknown>;
  }
  delete curr[parts[parts.length - 1]!];
}

function normalizeComparable(v: unknown): unknown {
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Date) return v.getTime();
  return v;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const na = normalizeComparable(a);
  const nb = normalizeComparable(b);
  if (na === nb) return true;
  if (Array.isArray(a)) {
    return a.some((item) => valuesEqual(item, b));
  }
  return false;
}

export function matchesMongoFilter(
  doc: Record<string, unknown>,
  filter?: Record<string, unknown>,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;

  for (const [key, expected] of Object.entries(filter)) {
    if (expected === undefined) continue;

    if (key === "$and" && Array.isArray(expected)) {
      if (!expected.every((sub) => matchesMongoFilter(doc, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === "$or" && Array.isArray(expected)) {
      if (!expected.some((sub) => matchesMongoFilter(doc, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === "$nor" && Array.isArray(expected)) {
      if (expected.some((sub) => matchesMongoFilter(doc, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }

    const actual = getNestedValue(doc, key);

    if (
      expected !== null &&
      typeof expected === "object" &&
      !(expected instanceof Date) &&
      !(expected instanceof RegExp) &&
      !(expected instanceof ObjectId) &&
      !Array.isArray(expected)
    ) {
      const expObj = expected as Record<string, unknown>;
      const hasOps = Object.keys(expObj).some((k) => k.startsWith("$"));
      if (hasOps) {
        for (const [op, opVal] of Object.entries(expObj)) {
          const a = normalizeComparable(actual);
          const b = normalizeComparable(opVal);
          switch (op) {
            case "$eq":
              if (!valuesEqual(actual, opVal)) return false;
              break;
            case "$ne":
              if (valuesEqual(actual, opVal)) return false;
              break;
            case "$gt":
              if (a === undefined || a === null || !(Number(a) > Number(b) || String(a) > String(b))) {
                if (!((a as number) > (b as number))) return false;
              }
              break;
            case "$gte":
              if (a === undefined || a === null || !((a as number) >= (b as number))) {
                return false;
              }
              break;
            case "$lt":
              if (a === undefined || a === null || !((a as number) < (b as number))) {
                return false;
              }
              break;
            case "$lte":
              if (a === undefined || a === null || !((a as number) <= (b as number))) {
                return false;
              }
              break;
            case "$in": {
              const arr = Array.isArray(opVal) ? opVal : [];
              if (!arr.some((item) => valuesEqual(actual, item))) return false;
              break;
            }
            case "$nin": {
              const arr = Array.isArray(opVal) ? opVal : [];
              if (arr.some((item) => valuesEqual(actual, item))) return false;
              break;
            }
            case "$exists": {
              const exists = actual !== undefined;
              if (Boolean(opVal) !== exists) return false;
              break;
            }
            case "$regex": {
              const flags = typeof expObj.$options === "string" ? expObj.$options : "";
              const re =
                opVal instanceof RegExp ? opVal : new RegExp(String(opVal), flags);
              if (typeof actual !== "string" || !re.test(actual)) return false;
              break;
            }
            case "$options":
              break;
            case "$not":
              if (matchesMongoFilter({ v: actual }, { v: opVal })) return false;
              break;
          }
        }
        continue;
      }

      // Nested plain object filter
      if (actual && typeof actual === "object") {
        if (!matchesMongoFilter(actual as Record<string, unknown>, expObj)) {
          return false;
        }
        continue;
      }
      return false;
    }

    if (expected instanceof RegExp) {
      if (typeof actual !== "string" || !expected.test(actual)) return false;
      continue;
    }

    if (!valuesEqual(actual, expected)) return false;
  }

  return true;
}

function applyMongoUpdate(
  doc: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(doc);
  const hasOperator = Object.keys(update).some((k) => k.startsWith("$"));
  if (!hasOperator) {
    return { ...update, _id: clone._id };
  }

  if (update.$set && typeof update.$set === "object") {
    for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
      setNestedValue(clone, k, v);
    }
  }
  if (update.$unset && typeof update.$unset === "object") {
    for (const k of Object.keys(update.$unset as Record<string, unknown>)) {
      unsetNestedValue(clone, k);
    }
  }
  if (update.$inc && typeof update.$inc === "object") {
    for (const [k, delta] of Object.entries(update.$inc as Record<string, unknown>)) {
      const curr = Number(getNestedValue(clone, k) ?? 0);
      setNestedValue(clone, k, curr + Number(delta));
    }
  }
  if (update.$push && typeof update.$push === "object") {
    for (const [k, item] of Object.entries(update.$push as Record<string, unknown>)) {
      const curr = getNestedValue(clone, k);
      const arr = Array.isArray(curr) ? [...curr] : [];
      arr.push(item);
      setNestedValue(clone, k, arr);
    }
  }
  if (update.$addToSet && typeof update.$addToSet === "object") {
    for (const [k, item] of Object.entries(update.$addToSet as Record<string, unknown>)) {
      const curr = getNestedValue(clone, k);
      const arr = Array.isArray(curr) ? [...curr] : [];
      if (!arr.some((x) => valuesEqual(x, item))) arr.push(item);
      setNestedValue(clone, k, arr);
    }
  }
  if (update.$pull && typeof update.$pull === "object") {
    for (const [k, target] of Object.entries(update.$pull as Record<string, unknown>)) {
      const curr = getNestedValue(clone, k);
      if (Array.isArray(curr)) {
        setNestedValue(
          clone,
          k,
          curr.filter((x) => !valuesEqual(x, target)),
        );
      }
    }
  }

  return clone;
}

function runLocalAggregate<T>(
  docs: Array<Record<string, unknown>>,
  pipeline: readonly Record<string, unknown>[],
): T[] {
  let current: Array<Record<string, unknown>> = docs.map((d) => structuredClone(d));

  for (const stage of pipeline) {
    if ("$match" in stage && stage.$match) {
      current = current.filter((d) =>
        matchesMongoFilter(d, stage.$match as Record<string, unknown>),
      );
    } else if ("$sort" in stage && stage.$sort) {
      const entries = Object.entries(stage.$sort as Record<string, 1 | -1>);
      current.sort((a, b) => {
        for (const [field, dir] of entries) {
          const av = normalizeComparable(getNestedValue(a, field));
          const bv = normalizeComparable(getNestedValue(b, field));
          if (av === bv) continue;
          if (av === undefined || av === null) return -1 * dir;
          if (bv === undefined || bv === null) return 1 * dir;
          return (av as number) < (bv as number) ? -1 * dir : 1 * dir;
        }
        return 0;
      });
    } else if ("$skip" in stage) {
      current = current.slice(Number(stage.$skip ?? 0));
    } else if ("$limit" in stage) {
      current = current.slice(0, Number(stage.$limit ?? 0));
    } else if ("$count" in stage && typeof stage.$count === "string") {
      current = [{ [stage.$count]: current.length }];
    } else if ("$project" in stage && stage.$project) {
      const proj = stage.$project as Record<string, 0 | 1 | string>;
      current = current.map((d) => {
        const out: Record<string, unknown> = {};
        for (const [k, spec] of Object.entries(proj)) {
          if (spec === 1) {
            out[k] = getNestedValue(d, k);
          } else if (typeof spec === "string" && spec.startsWith("$")) {
            out[k] = getNestedValue(d, spec.slice(1));
          }
        }
        return out;
      });
    } else if ("$group" in stage && stage.$group) {
      const spec = stage.$group as Record<string, unknown>;
      const idExpr = spec._id;
      const groups = new Map<string, { key: unknown; items: Array<Record<string, unknown>> }>();

      for (const doc of current) {
        const groupKey =
          typeof idExpr === "string" && idExpr.startsWith("$")
            ? getNestedValue(doc, idExpr.slice(1))
            : idExpr;
        const mapKey = JSON.stringify(groupKey ?? null);
        let bucket = groups.get(mapKey);
        if (!bucket) {
          bucket = { key: groupKey ?? null, items: [] };
          groups.set(mapKey, bucket);
        }
        bucket.items.push(doc);
      }

      const aggregated: Array<Record<string, unknown>> = [];
      for (const { key, items } of groups.values()) {
        const row: Record<string, unknown> = { _id: key };
        for (const [field, acc] of Object.entries(spec)) {
          if (field === "_id" || !acc || typeof acc !== "object") continue;
          const accObj = acc as Record<string, unknown>;
          if ("$sum" in accObj) {
            const expr = accObj.$sum;
            row[field] = items.reduce((sum, item) => {
              const v =
                typeof expr === "string" && expr.startsWith("$")
                  ? Number(getNestedValue(item, expr.slice(1)) ?? 0)
                  : Number(expr ?? 0);
              return sum + v;
            }, 0);
          } else if ("$avg" in accObj) {
            const expr = accObj.$avg;
            const total = items.reduce((sum, item) => {
              const v =
                typeof expr === "string" && expr.startsWith("$")
                  ? Number(getNestedValue(item, expr.slice(1)) ?? 0)
                  : Number(expr ?? 0);
              return sum + v;
            }, 0);
            row[field] = items.length > 0 ? total / items.length : 0;
          } else if ("$min" in accObj) {
            const expr = String(accObj.$min).replace(/^\$/, "");
            const vals = items.map((i) => getNestedValue(i, expr)).filter((v) => v !== undefined);
            row[field] = vals.sort()[0] ?? null;
          } else if ("$max" in accObj) {
            const expr = String(accObj.$max).replace(/^\$/, "");
            const vals = items.map((i) => getNestedValue(i, expr)).filter((v) => v !== undefined);
            row[field] = vals.sort()[vals.length - 1] ?? null;
          } else if ("$push" in accObj) {
            const expr = String(accObj.$push).replace(/^\$/, "");
            row[field] = items.map((i) => getNestedValue(i, expr));
          }
        }
        aggregated.push(row);
      }
      current = aggregated;
    }
  }

  return current as T[];
}

/**
 * Zero-dependency MongoDB driver powered 100% by Bun native APIs:
 * - **Remote mode (`mongodb://...` or `host`)**: Native `Bun.connect()` TCP/TLS
 *   socket speaking the official MongoDB Wire Protocol (`OP_MSG`, opcode `2013`)
 *   + pure BSON binary codec + SCRAM-SHA-256 auth via `crypto.subtle`.
 * - **Local embedded mode (`:memory:` or file)**: Native `bun:sqlite`-backed
 *   document store with full MongoDB filter/update/aggregation support for instant
 *   local dev & testing without an external MongoDB daemon.
 */
export class MongoOrmDriver implements OrmDocumentDriverLike {
  readonly dialect: OrmDialect = "mongodb";
  readonly isDocumentDriver = true as const;
  readonly driverKind: string;

  private readonly conn: ParsedMongoConnection;
  private readonly options: MongoOrmDriverOptions;
  private wire?: BunMongoWireTransport;
  private localDb?: Database;
  private readonly ensuredLocalCollections = new Set<string>();
  private inTx = false;

  constructor(options: MongoOrmDriverOptions = {}) {
    this.options = options;
    this.conn = parseMongoConnection(options);
    this.driverKind = this.conn.isRemote ? "mongodb-wire" : "mongodb-local";
  }

  get isConnected(): boolean {
    return this.conn.isRemote
      ? Boolean(this.wire?.isConnected)
      : this.localDb !== undefined;
  }

  async connect(): Promise<void> {
    if (this.conn.isRemote) {
      if (this.wire?.isConnected) return;
      const password =
        typeof this.options.password === "function"
          ? await this.options.password()
          : this.conn.password;
      this.wire = new BunMongoWireTransport(this.conn);
      await this.wire.connect(password);
      return;
    }

    if (!this.localDb) {
      this.localDb = new Database(this.conn.localPath);
    }
  }

  async close(): Promise<void> {
    if (this.wire) {
      await this.wire.close();
      this.wire = undefined;
    }
    if (this.localDb) {
      this.localDb.close();
      this.localDb = undefined;
      this.ensuredLocalCollections.clear();
    }
  }

  async ping(): Promise<boolean> {
    if (this.wire) {
      const res = await this.wire.command({ ping: 1 });
      return Number(res.ok) === 1;
    }
    return this.localDb !== undefined;
  }

  isInTransaction(): boolean {
    return this.inTx;
  }

  async runCommand(
    command: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.wire) {
      return await this.wire.command(command);
    }
    if (command.ping) return { ok: 1 };
    return { ok: 1 };
  }

  private localTable(collectionName: string): string {
    return `__bunest_mongo_${collectionName.replace(/[^A-Za-z0-9_]/g, "_")}`;
  }

  private ensureLocalTable(collectionName: string): Database {
    if (!this.localDb) {
      throw new Error("MongoOrmDriver is not connected.");
    }
    const tbl = this.localTable(collectionName);
    if (!this.ensuredLocalCollections.has(tbl)) {
      this.localDb.run(
        `CREATE TABLE IF NOT EXISTS "${tbl}" (doc_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
      );
      this.ensuredLocalCollections.add(tbl);
    }
    return this.localDb;
  }

  private readAllLocal(collectionName: string): Array<Record<string, unknown>> {
    const db = this.ensureLocalTable(collectionName);
    const tbl = this.localTable(collectionName);
    const rows = db
      .query(`SELECT payload FROM "${tbl}" ORDER BY rowid ASC`)
      .all() as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  }

  async ensureCollection(collectionName: string): Promise<void> {
    if (this.wire) return;
    this.ensureLocalTable(collectionName);
  }

  async dropCollection(collectionName: string): Promise<void> {
    if (this.wire) {
      try {
        await this.wire.command({ drop: collectionName });
      } catch {
        // Collection may not exist yet
      }
      return;
    }
    if (this.localDb) {
      const tbl = this.localTable(collectionName);
      this.localDb.run(`DROP TABLE IF EXISTS "${tbl}"`);
      this.ensuredLocalCollections.delete(tbl);
    }
  }

  async docInsertMany(
    collectionName: string,
    docs: readonly Record<string, unknown>[],
  ): Promise<{ insertedCount: number; insertedIds: unknown[] }> {
    const start = performance.now();
    const prepared = docs.map((d) => {
      const clone: Record<string, unknown> = { ...d };
      if (clone._id === undefined || clone._id === null) {
        clone._id = generateObjectId();
      }
      return clone;
    });

    if (this.wire) {
      await this.wire.command({
        insert: collectionName,
        documents: prepared,
      });
      emitQueryLog(this.options.logging, `mongo.insert(${collectionName})`, prepared, start);
      return {
        insertedCount: prepared.length,
        insertedIds: prepared.map((d) => d._id),
      };
    }

    const db = this.ensureLocalTable(collectionName);
    const tbl = this.localTable(collectionName);
    const stmt = db.query(
      `INSERT INTO "${tbl}" (doc_id, payload) VALUES (?1, ?2) ON CONFLICT(doc_id) DO UPDATE SET payload = excluded.payload`,
    );
    for (const doc of prepared) {
      stmt.run(String(doc._id), JSON.stringify(doc));
    }
    emitQueryLog(this.options.logging, `mongo.insert(${collectionName})`, prepared, start);
    return {
      insertedCount: prepared.length,
      insertedIds: prepared.map((d) => d._id),
    };
  }

  async docFind(
    collectionName: string,
    filter: Record<string, unknown> = {},
    options: {
      sort?: Record<string, 1 | -1>;
      skip?: number;
      limit?: number;
      projection?: Record<string, 0 | 1>;
    } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const start = performance.now();

    if (this.wire) {
      const cmd: Record<string, unknown> = {
        find: collectionName,
        filter,
      };
      if (options.sort) cmd.sort = options.sort;
      if (options.skip !== undefined) cmd.skip = options.skip;
      if (options.limit !== undefined) cmd.limit = options.limit;
      if (options.projection) cmd.projection = options.projection;

      const res = await this.wire.command(cmd);
      const cursor = res.cursor as
        | { firstBatch?: Array<Record<string, unknown>> }
        | undefined;
      const docs = cursor?.firstBatch ?? [];
      emitQueryLog(this.options.logging, `mongo.find(${collectionName})`, [filter], start);
      return docs;
    }

    let docs = this.readAllLocal(collectionName).filter((d) =>
      matchesMongoFilter(d, filter),
    );

    if (options.sort) {
      const entries = Object.entries(options.sort);
      docs.sort((a, b) => {
        for (const [field, dir] of entries) {
          const av = normalizeComparable(getNestedValue(a, field));
          const bv = normalizeComparable(getNestedValue(b, field));
          if (av === bv) continue;
          if (av === undefined || av === null) return -1 * dir;
          if (bv === undefined || bv === null) return 1 * dir;
          return (av as number) < (bv as number) ? -1 * dir : 1 * dir;
        }
        return 0;
      });
    }

    if (options.skip !== undefined || options.limit !== undefined) {
      const startIdx = options.skip ?? 0;
      const endIdx =
        options.limit !== undefined ? startIdx + options.limit : undefined;
      docs = docs.slice(startIdx, endIdx);
    }

    if (options.projection) {
      const entries = Object.entries(options.projection);
      const includes = entries.filter(([, v]) => v === 1).map(([k]) => k);
      const excludes = entries.filter(([, v]) => v === 0).map(([k]) => k);
      docs = docs.map((d) => {
        if (includes.length > 0) {
          const picked: Record<string, unknown> = {};
          if (!excludes.includes("_id") && "_id" in d) picked._id = d._id;
          for (const k of includes) {
            if (k in d) picked[k] = d[k];
          }
          return picked;
        }
        const copy = { ...d };
        for (const k of excludes) delete copy[k];
        return copy;
      });
    }

    emitQueryLog(this.options.logging, `mongo.find(${collectionName})`, [filter], start);
    return docs;
  }

  async docUpdate(
    collectionName: string,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { multi?: boolean; upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }> {
    const start = performance.now();

    if (this.wire) {
      const res = await this.wire.command({
        update: collectionName,
        updates: [
          {
            q: filter,
            u: update,
            multi: options.multi === true,
            upsert: options.upsert === true,
          },
        ],
      });
      const upserted = res.upserted as Array<{ _id: unknown }> | undefined;
      emitQueryLog(this.options.logging, `mongo.update(${collectionName})`, [filter, update], start);
      return {
        matchedCount: Number(res.n ?? 0),
        modifiedCount: Number(res.nModified ?? res.n ?? 0),
        ...(upserted?.[0] ? { upsertedId: upserted[0]._id } : {}),
      };
    }

    const db = this.ensureLocalTable(collectionName);
    const tbl = this.localTable(collectionName);
    const docs = this.readAllLocal(collectionName);
    let matchedCount = 0;
    let modifiedCount = 0;

    for (const doc of docs) {
      if (!matchesMongoFilter(doc, filter)) continue;
      matchedCount++;
      const next = applyMongoUpdate(doc, update);
      db.query(
        `UPDATE "${tbl}" SET payload = ?1 WHERE doc_id = ?2`,
      ).run(JSON.stringify(next), String(doc._id));
      modifiedCount++;
      if (!options.multi) break;
    }

    if (matchedCount === 0 && options.upsert) {
      const base: Record<string, unknown> = {
        ...Object.fromEntries(
          Object.entries(filter).filter(([k]) => !k.startsWith("$")),
        ),
        _id: filter._id ?? generateObjectId(),
      };
      const created = applyMongoUpdate(base, update);
      await this.docInsertMany(collectionName, [created]);
      return { matchedCount: 0, modifiedCount: 0, upsertedId: created._id };
    }

    emitQueryLog(this.options.logging, `mongo.update(${collectionName})`, [filter, update], start);
    return { matchedCount, modifiedCount };
  }

  async docDelete(
    collectionName: string,
    filter: Record<string, unknown>,
    options: { multi?: boolean } = {},
  ): Promise<{ deletedCount: number }> {
    const start = performance.now();

    if (this.wire) {
      const res = await this.wire.command({
        delete: collectionName,
        deletes: [{ q: filter, limit: options.multi ? 0 : 1 }],
      });
      emitQueryLog(this.options.logging, `mongo.delete(${collectionName})`, [filter], start);
      return { deletedCount: Number(res.n ?? 0) };
    }

    const db = this.ensureLocalTable(collectionName);
    const tbl = this.localTable(collectionName);
    const docs = this.readAllLocal(collectionName);
    let deletedCount = 0;

    for (const doc of docs) {
      if (!matchesMongoFilter(doc, filter)) continue;
      db.query(`DELETE FROM "${tbl}" WHERE doc_id = ?1`).run(String(doc._id));
      deletedCount++;
      if (!options.multi) break;
    }

    emitQueryLog(this.options.logging, `mongo.delete(${collectionName})`, [filter], start);
    return { deletedCount };
  }

  async docCount(
    collectionName: string,
    filter: Record<string, unknown> = {},
  ): Promise<number> {
    if (this.wire) {
      const res = await this.wire.command({
        count: collectionName,
        query: filter,
      });
      return Number(res.n ?? 0);
    }
    return this.readAllLocal(collectionName).filter((d) =>
      matchesMongoFilter(d, filter),
    ).length;
  }

  async docDistinct<T = unknown>(
    collectionName: string,
    field: string,
    filter: Record<string, unknown> = {},
  ): Promise<T[]> {
    if (this.wire) {
      const res = await this.wire.command({
        distinct: collectionName,
        key: field,
        query: filter,
      });
      return (res.values as T[] | undefined) ?? [];
    }
    const seen = new Set<string>();
    const out: T[] = [];
    for (const doc of this.readAllLocal(collectionName)) {
      if (!matchesMongoFilter(doc, filter)) continue;
      const val = getNestedValue(doc, field);
      if (val === undefined) continue;
      const k = JSON.stringify(val);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(val as T);
      }
    }
    return out;
  }

  async docAggregate<T = Record<string, unknown>>(
    collectionName: string,
    pipeline: readonly Record<string, unknown>[],
  ): Promise<T[]> {
    if (this.wire) {
      const res = await this.wire.command({
        aggregate: collectionName,
        pipeline: [...pipeline],
        cursor: {},
      });
      const cursor = res.cursor as { firstBatch?: T[] } | undefined;
      return cursor?.firstBatch ?? [];
    }
    return runLocalAggregate<T>(this.readAllLocal(collectionName), pipeline);
  }

  async docCreateIndex(
    collectionName: string,
    keys: Record<string, 1 | -1>,
    options: { unique?: boolean; name?: string } = {},
  ): Promise<string> {
    const idxName =
      options.name ??
      Object.entries(keys)
        .map(([k, d]) => `${k}_${d}`)
        .join("_");
    if (this.wire) {
      await this.wire.command({
        createIndexes: collectionName,
        indexes: [{ key: keys, name: idxName, unique: options.unique === true }],
      });
    }
    return idxName;
  }

  // Raw command bridge satisfying OrmQueryExecutor
  async query<T = Record<string, unknown>>(
    commandJson: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult<T>> {
    try {
      const parsed = JSON.parse(commandJson) as Record<string, unknown>;
      const res = await this.runCommand(parsed);
      return { rows: [res as T], affectedRows: 1 };
    } catch (err) {
      throw new QueryFailedError(
        err instanceof Error ? err.message : String(err),
        commandJson,
        params,
        err,
      );
    }
  }

  async execute(
    commandJson: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult> {
    return this.query(commandJson, params);
  }

  async transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
  ): Promise<T> {
    if (this.localDb && !this.inTx) {
      this.inTx = true;
      this.localDb.run("BEGIN TRANSACTION");
      try {
        const res = await run(this);
        this.localDb.run("COMMIT");
        return res;
      } catch (err) {
        try {
          this.localDb.run("ROLLBACK");
        } catch {
          // ignore
        }
        throw err;
      } finally {
        this.inTx = false;
      }
    }
    const prev = this.inTx;
    this.inTx = true;
    try {
      return await run(this);
    } finally {
      this.inTx = prev;
    }
  }
}
