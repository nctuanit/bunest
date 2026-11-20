import { EventEmitter } from "node:events";
import { MongooseError } from "../errors/mongoose.error";
import type {
  ConnectionLike,
  ConnectOptions,
  HydratedDocument,
} from "../interfaces/mongoose-options.interface";
import type {
  MongooseSchemaLike,
  PluginFunction,
} from "../interfaces/schema-types.interface";
import {
  deepClone,
  getNestedValue,
  isPlainObject,
  pluralizeCollectionName,
  setNestedValue,
} from "../utils/shared.utils";
import { ObjectId } from "./object-id";
import {
  applyProjection,
  applyUpdateOperators,
  compareValues,
  matchesFilter,
  parseSortSpec,
  valuesEqual,
} from "./query-matcher";
import { MongooseSchema, type RegisteredHook } from "./schema";

export interface QueryOptions {
  lean?: boolean;
  new?: boolean;
  returnDocument?: "before" | "after";
  upsert?: boolean;
  runValidators?: boolean;
  projection?: string | Record<string, number | boolean>;
  sort?: string | Record<string, 1 | -1 | "asc" | "desc" | "ascending" | "descending">;
  skip?: number;
  limit?: number;
  populate?: Array<string | PopulateOptions>;
  [key: string]: any;
}

export interface PopulateOptions {
  path: string;
  select?: string | Record<string, number | boolean>;
  model?: string;
  match?: Record<string, any>;
}

export interface UpdateWriteOpResult {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: ObjectId | null;
}

export interface DeleteResult {
  acknowledged: boolean;
  deletedCount: number;
}

function hookMatches(hook: RegisteredHook, methodName: string): boolean {
  if (hook.method instanceof RegExp) {
    return hook.method.test(methodName);
  }
  return hook.method === methodName;
}

async function runPreHooks(
  schema: MongooseSchema<any>,
  methodName: string,
  context: any,
): Promise<void> {
  for (const hook of schema.preHooks) {
    if (!hookMatches(hook, methodName)) continue;
    await invokeHookFn(hook.fn, context, []);
  }
}

async function runPostHooks(
  schema: MongooseSchema<any>,
  methodName: string,
  context: any,
  result: any,
): Promise<void> {
  for (const hook of schema.postHooks) {
    if (!hookMatches(hook, methodName)) continue;
    await invokeHookFn(hook.fn, context, [result]);
  }
}

async function invokeHookFn(
  fn: (this: any, ...args: any[]) => any,
  context: any,
  baseArgs: any[],
): Promise<void> {
  const expectsNext = fn.length > baseArgs.length;
  if (!expectsNext) {
    const ret = fn.apply(context, baseArgs);
    if (ret && typeof ret.then === "function") {
      await ret;
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const next = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    try {
      const ret = fn.apply(context, [...baseArgs, next]);
      if (ret && typeof ret.then === "function") {
        (ret as Promise<unknown>).then(
          () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          },
        );
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

function getTimestampFieldNames(
  schema: MongooseSchema<any>,
): { createdAt?: string; updatedAt?: string; currentTime: () => Date } | null {
  const ts = schema.options.timestamps;
  if (!ts) return null;
  if (ts === true) {
    return {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
      currentTime: () => new Date(),
    };
  }
  const createdAt =
    ts.createdAt === false
      ? undefined
      : typeof ts.createdAt === "string"
        ? ts.createdAt
        : "createdAt";
  const updatedAt =
    ts.updatedAt === false
      ? undefined
      : typeof ts.updatedAt === "string"
        ? ts.updatedAt
        : "updatedAt";
  const currentTime = () => {
    if (ts.currentTime) {
      const t = ts.currentTime();
      return t instanceof Date ? t : new Date(t);
    }
    return new Date();
  };
  return { createdAt, updatedAt, currentTime };
}

export class MongooseCollection {
  readonly name: string;
  readonly collectionName: string;
  readonly documents: Array<Record<string, any>> = [];
  readonly indexDefinitions: Array<[Record<string, any>, Record<string, any>]> =
    [];

  constructor(name: string) {
    this.name = name;
    this.collectionName = name;
  }

  async drop(): Promise<boolean> {
    this.documents.length = 0;
    this.indexDefinitions.length = 0;
    return true;
  }
}

export class MongooseQuery<TResult = any, TDoc = any>
  implements PromiseLike<TResult>
{
  private filter: Record<string, any>;
  private options: QueryOptions;
  private activeField?: string;
  private readonly executor: (
    filter: Record<string, any>,
    options: QueryOptions,
  ) => Promise<TResult>;

  constructor(
    filter: Record<string, any>,
    options: QueryOptions,
    executor: (
      filter: Record<string, any>,
      options: QueryOptions,
    ) => Promise<TResult>,
  ) {
    this.filter = deepClone(filter);
    this.options = { ...options };
    this.executor = executor;
  }

  lean(val = true): this {
    this.options.lean = val;
    return this;
  }

  select(projection: string | Record<string, number | boolean>): this {
    this.options.projection = projection;
    return this;
  }

  sort(
    arg:
      | string
      | Record<string, 1 | -1 | "asc" | "desc" | "ascending" | "descending">,
  ): this {
    this.options.sort = arg;
    return this;
  }

  skip(n: number): this {
    this.options.skip = n;
    return this;
  }

  limit(n: number): this {
    this.options.limit = n;
    return this;
  }

  populate(
    path: string | PopulateOptions | Array<string | PopulateOptions>,
    select?: string | Record<string, number | boolean>,
  ): this {
    if (!this.options.populate) {
      this.options.populate = [];
    }
    if (Array.isArray(path)) {
      this.options.populate.push(...path);
    } else if (typeof path === "string" && select !== undefined) {
      this.options.populate.push({ path, select });
    } else {
      this.options.populate.push(path);
    }
    return this;
  }

  where(path: string | Record<string, any>, val?: any): this {
    if (typeof path === "string") {
      this.activeField = path;
      if (val !== undefined) {
        this.filter[path] = val;
      }
    } else {
      Object.assign(this.filter, path);
    }
    return this;
  }

  private applyFieldOp(op: string, val: any): this {
    if (!this.activeField) {
      throw new MongooseError(`Query.${op}() requires .where(path) first`);
    }
    const existing = this.filter[this.activeField];
    if (isPlainObject(existing)) {
      existing[op] = val;
    } else {
      this.filter[this.activeField] = { [op]: val };
    }
    return this;
  }

  equals(val: any): this {
    if (!this.activeField) {
      throw new MongooseError("Query.equals() requires .where(path) first");
    }
    this.filter[this.activeField] = val;
    return this;
  }

  ne(val: any): this {
    return this.applyFieldOp("$ne", val);
  }

  gt(val: any): this {
    return this.applyFieldOp("$gt", val);
  }

  gte(val: any): this {
    return this.applyFieldOp("$gte", val);
  }

  lt(val: any): this {
    return this.applyFieldOp("$lt", val);
  }

  lte(val: any): this {
    return this.applyFieldOp("$lte", val);
  }

  in(val: any[]): this {
    return this.applyFieldOp("$in", val);
  }

  nin(val: any[]): this {
    return this.applyFieldOp("$nin", val);
  }

  regex(val: RegExp | string): this {
    return this.applyFieldOp("$regex", val);
  }

  and(conditions: Record<string, any>[]): this {
    this.filter.$and = [...(this.filter.$and ?? []), ...conditions];
    return this;
  }

  or(conditions: Record<string, any>[]): this {
    this.filter.$or = [...(this.filter.$or ?? []), ...conditions];
    return this;
  }

  nor(conditions: Record<string, any>[]): this {
    this.filter.$nor = [...(this.filter.$nor ?? []), ...conditions];
    return this;
  }

  setOptions(opts: QueryOptions): this {
    Object.assign(this.options, opts);
    return this;
  }

  getFilter(): Record<string, any> {
    return this.filter;
  }

  getQuery(): Record<string, any> {
    return this.filter;
  }

  getOptions(): QueryOptions {
    return this.options;
  }

  clone(): MongooseQuery<TResult, TDoc> {
    return new MongooseQuery<TResult, TDoc>(
      deepClone(this.filter),
      deepClone(this.options),
      this.executor,
    );
  }

  async exec(): Promise<TResult> {
    return this.executor(this.filter, this.options);
  }

  then<TResult1 = TResult, TResult2 = never>(
    onfulfilled?:
      | ((value: TResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult2 = never>(
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult | TResult2> {
    return this.exec().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<TResult> {
    return this.exec().finally(onfinally);
  }
}

export class MongooseDocument<T extends Record<string, any> = Record<string, any>> {
  _id!: ObjectId;
  __v?: number;
  isNew: boolean;
  private readonly __model: MongooseModel<T>;
  private readonly __schema: MongooseSchema<T>;
  private readonly __modifiedPaths = new Set<string>();
  private readonly __populated: Record<string, any> = {};

  constructor(
    data: Partial<T> & Record<string, any>,
    model: MongooseModel<T>,
    schema: MongooseSchema<T>,
    isNew = true,
  ) {
    this.__model = model;
    this.__schema = schema;
    this.isNew = isNew;

    // Hide internal metadata fields from enumeration & JSON
    Object.defineProperties(this, {
      __model: { enumerable: false, configurable: false, writable: false, value: model },
      __schema: { enumerable: false, configurable: false, writable: false, value: schema },
      __modifiedPaths: { enumerable: false, configurable: false, writable: false, value: this.__modifiedPaths },
      __populated: { enumerable: false, configurable: false, writable: false, value: this.__populated },
      isNew: { enumerable: false, configurable: true, writable: true, value: isNew },
    });

    // Apply defaults & cast incoming fields
    const initialData: Record<string, any> = deepClone(data ?? {});
    if (initialData._id === undefined && schema.obj._id !== false) {
      initialData._id = new ObjectId();
    } else if (
      initialData._id !== undefined &&
      schema.paths._id?.instance === "ObjectId" &&
      !(initialData._id instanceof ObjectId) &&
      ObjectId.isValid(initialData._id)
    ) {
      initialData._id = new ObjectId(initialData._id);
    }

    // Apply schema defaults for missing top-level paths
    for (const [path, st] of Object.entries(schema.paths)) {
      if (path === "_id" || path.includes(".")) continue;
      if (initialData[path] === undefined) {
        const def = st.getDefault(initialData);
        if (def !== undefined) {
          initialData[path] = def;
        }
      }
      if (initialData[path] !== undefined) {
        initialData[path] = st.cast(initialData[path], initialData);
      }
    }

    // Apply discriminator value if this model is a discriminator
    if (model.discriminatorKey && model.discriminatorValue !== undefined) {
      initialData[model.discriminatorKey] = model.discriminatorValue;
    }

    const versionKey = schema.options.versionKey;
    if (versionKey !== false && typeof versionKey === "string") {
      if (initialData[versionKey] === undefined) {
        initialData[versionKey] = 0;
      }
    }

    // Assign own fields
    for (const [k, v] of Object.entries(initialData)) {
      (this as Record<string, any>)[k] = v;
      if (isNew) {
        this.__modifiedPaths.add(k);
      }
    }

    // Attach schema instance methods
    for (const [methodName, fn] of Object.entries(schema.methods)) {
      Object.defineProperty(this, methodName, {
        value: fn.bind(this),
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }

    // Attach virtual getters/setters
    for (const [vName, virtual] of Object.entries(schema.virtuals)) {
      if (vName.includes(".")) continue;
      Object.defineProperty(this, vName, {
        enumerable: false,
        configurable: true,
        get: () => {
          if (vName in this.__populated) {
            return this.__populated[vName];
          }
          if (virtual.getters.length > 0) {
            return virtual.applyGetters(undefined, this as any);
          }
          return undefined;
        },
        set: (val: any) => {
          if (virtual.setters.length > 0) {
            virtual.applySetters(val, this as any);
          } else {
            this.__populated[vName] = val;
          }
        },
      });
    }
  }

  isModified(path?: string): boolean {
    if (!path) {
      return this.__modifiedPaths.size > 0;
    }
    return this.__modifiedPaths.has(path);
  }

  markModified(path: string): void {
    this.__modifiedPaths.add(path);
  }

  async validate(): Promise<void> {
    await runPreHooks(this.__schema, "validate", this);
    const errors: Record<string, Error> = {};

    for (const [path, st] of Object.entries(this.__schema.paths)) {
      if (path === "_id") continue;
      const val = getNestedValue(this as Record<string, any>, path);
      if (val !== undefined) {
        const castVal = st.cast(val, this);
        if (castVal !== val) {
          setNestedValue(this as Record<string, any>, path, castVal);
        }
      }
      const err = await st.doValidate(
        getNestedValue(this as Record<string, any>, path),
        this,
      );
      if (err) {
        errors[path] = err;
      }
    }

    if (Object.keys(errors).length > 0) {
      const summary = Object.values(errors)
        .map((e) => e.message)
        .join(", ");
      throw new MongooseError(
        `${this.__model.modelName} validation failed: ${summary}`,
        { errors },
      );
    }

    await runPostHooks(this.__schema, "validate", this, this);
  }

  async save(): Promise<HydratedDocument<T>> {
    await runPreHooks(this.__schema, "save", this);

    if (this.__schema.options.validateBeforeSave !== false) {
      await this.validate();
    }

    const ts = getTimestampFieldNames(this.__schema);
    if (ts) {
      const now = ts.currentTime();
      if (this.isNew && ts.createdAt && (this as any)[ts.createdAt] === undefined) {
        (this as any)[ts.createdAt] = now;
      }
      if (ts.updatedAt) {
        (this as any)[ts.updatedAt] = now;
      }
    }

    const plain = this.toPlainRecord();
    this.__model._persistDocument(plain, this.isNew);
    this.isNew = false;
    this.__modifiedPaths.clear();

    await runPostHooks(this.__schema, "save", this, this);
    return this as unknown as HydratedDocument<T>;
  }

  async deleteOne(): Promise<DeleteResult> {
    await runPreHooks(this.__schema, "deleteOne", this);
    const res = await this.__model.deleteOne({ _id: this._id });
    await runPostHooks(this.__schema, "deleteOne", this, res);
    return res;
  }

  async populate(
    path: string | PopulateOptions | Array<string | PopulateOptions>,
  ): Promise<HydratedDocument<T>> {
    const specs = Array.isArray(path) ? path : [path];
    for (const spec of specs) {
      const opt: PopulateOptions =
        typeof spec === "string" ? { path: spec } : spec;
      await this.__model._populateDoc(this as Record<string, any>, opt, this.__populated);
    }
    return this as unknown as HydratedDocument<T>;
  }

  toPlainRecord(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(this)) {
      if (k.startsWith("__") && k !== "__v" && k !== "__t") continue;
      out[k] = deepClone(v);
    }
    return out;
  }

  toObject(options?: Record<string, any>): T & { _id: ObjectId; id?: string } {
    const mergedOpts = { ...(this.__schema.options.toObject ?? {}), ...(options ?? {}) };
    const ret = this.toPlainRecord();
    if (mergedOpts.versionKey === false) {
      const vk = this.__schema.options.versionKey;
      if (typeof vk === "string") {
        delete ret[vk];
      }
    }
    if (mergedOpts.virtuals) {
      for (const [vName, virtual] of Object.entries(this.__schema.virtuals)) {
        if (vName.includes(".")) continue;
        ret[vName] =
          vName in this.__populated
            ? this.__populated[vName]
            : virtual.applyGetters(undefined, this as any);
      }
    }
    if (typeof mergedOpts.transform === "function") {
      const transformed = mergedOpts.transform(this, ret, mergedOpts);
      if (transformed !== undefined) {
        return transformed;
      }
    }
    return ret as T & { _id: ObjectId; id?: string };
  }

  toJSON(options?: Record<string, any>): Record<string, any> {
    const mergedOpts = { ...(this.__schema.options.toJSON ?? {}), ...(options ?? {}) };
    const ret = this.toObject(mergedOpts);
    if (ret._id instanceof ObjectId) {
      (ret as any)._id = ret._id.toHexString();
    }
    return ret;
  }
}

export class MongooseModel<T extends Record<string, any> = Record<string, any>> {
  readonly modelName: string;
  readonly schema: MongooseSchema<T>;
  readonly collection: MongooseCollection;
  readonly db: MongooseConnection;
  readonly discriminators: Record<string, MongooseModel<any>> = {};
  readonly discriminatorKey?: string;
  readonly discriminatorValue?: string;

  constructor(
    name: string,
    schema: MongooseSchema<T>,
    collection: MongooseCollection,
    connection: MongooseConnection,
    discriminatorInfo?: { key: string; value: string },
  ) {
    this.modelName = name;
    this.schema = schema;
    this.collection = collection;
    this.db = connection;
    this.discriminatorKey = discriminatorInfo?.key;
    this.discriminatorValue = discriminatorInfo?.value;

    // Bind schema statics onto the model instance
    for (const [staticName, fn] of Object.entries(schema.statics)) {
      (this as Record<string, any>)[staticName] = fn.bind(this);
    }
  }

  /**
   * Creates a new unsaved document instance (just like `new Model(data)`).
   */
  newDocument(data: Partial<T> = {}): HydratedDocument<T> {
    return new MongooseDocument<T>(
      data,
      this,
      this.schema,
      true,
    ) as unknown as HydratedDocument<T>;
  }

  hydrate(obj: Record<string, any>): HydratedDocument<T> {
    return new MongooseDocument<T>(
      obj as Partial<T> & Record<string, any>,
      this,
      this.schema,
      false,
    ) as unknown as HydratedDocument<T>;
  }

  private scopeFilter(filter: Record<string, any> = {}): Record<string, any> {
    if (this.discriminatorKey && this.discriminatorValue !== undefined) {
      return { ...filter, [this.discriminatorKey]: this.discriminatorValue };
    }
    return { ...filter };
  }

  private enforceUniqueIndexes(
    candidate: Record<string, any>,
    excludeId?: ObjectId,
  ): void {
    const indexes = this.schema.indexes();
    for (const [fields, opts] of indexes) {
      if (!opts.unique) continue;
      const fieldNames = Object.keys(fields);
      const isAllUndefined = fieldNames.every(
        (f) => getNestedValue(candidate, f) === undefined,
      );
      if (opts.sparse && isAllUndefined) continue;

      const conflict = this.collection.documents.find((existing) => {
        if (excludeId && valuesEqual(existing._id, excludeId)) return false;
        if (
          this.discriminatorKey &&
          this.discriminatorValue !== undefined &&
          existing[this.discriminatorKey] !== this.discriminatorValue
        ) {
          return false;
        }
        return fieldNames.every((f) =>
          valuesEqual(getNestedValue(existing, f), getNestedValue(candidate, f)),
        );
      });
      if (conflict) {
        throw new MongooseError(
          `E11000 duplicate key error collection: ${this.collection.name} index: ${fieldNames.join("_")}`,
          { code: 11000 },
        );
      }
    }
  }

  /** @internal */
  _persistDocument(plain: Record<string, any>, isNew: boolean): void {
    this.enforceUniqueIndexes(plain, isNew ? undefined : plain._id);
    if (isNew) {
      this.collection.documents.push(deepClone(plain));
      return;
    }
    const idx = this.collection.documents.findIndex((d) =>
      valuesEqual(d._id, plain._id),
    );
    if (idx === -1) {
      this.collection.documents.push(deepClone(plain));
    } else {
      this.collection.documents[idx] = deepClone(plain);
    }
  }

  /** @internal */
  async _populateDoc(
    doc: Record<string, any>,
    opt: PopulateOptions,
    virtualTarget?: Record<string, any>,
  ): Promise<void> {
    const path = opt.path;
    const virtual = this.schema.virtuals[path];
    if (virtual && virtual.options.ref && virtual.options.localField && virtual.options.foreignField) {
      const refModelName =
        typeof virtual.options.ref === "function"
          ? virtual.options.ref(doc as T)
          : virtual.options.ref;
      const refModel = this.db.models[refModelName] as MongooseModel<any> | undefined;
      if (!refModel) return;
      const localField =
        typeof virtual.options.localField === "function"
          ? virtual.options.localField(doc as T)
          : virtual.options.localField;
      const foreignField =
        typeof virtual.options.foreignField === "function"
          ? virtual.options.foreignField(doc as T)
          : virtual.options.foreignField;
      const localVal = getNestedValue(doc, localField);
      const baseMatch =
        typeof virtual.options.match === "function"
          ? virtual.options.match(doc as T)
          : (virtual.options.match ?? {});
      const queryFilter: Record<string, any> = {
        ...baseMatch,
        ...(opt.match ?? {}),
        [foreignField]: Array.isArray(localVal) ? { $in: localVal } : localVal,
      };
      const matched = await refModel.find(queryFilter).exec();
      const val = virtual.options.count
        ? matched.length
        : virtual.options.justOne
          ? (matched[0] ?? null)
          : matched;
      if (virtualTarget) {
        virtualTarget[path] = val;
      } else {
        doc[path] = val;
      }
      return;
    }

    const st = this.schema.paths[path];
    const embedded = st?.getEmbeddedSchemaType();
    const refSpec = opt.model ?? st?.options.ref ?? embedded?.options.ref;
    if (!refSpec || typeof refSpec !== "string") {
      return;
    }
    const refModel = this.db.models[refSpec] as MongooseModel<any> | undefined;
    if (!refModel) return;

    const currentVal = getNestedValue(doc, path);
    if (currentVal === undefined || currentVal === null) return;

    if (Array.isArray(currentVal)) {
      const populatedArr: any[] = [];
      for (const item of currentVal) {
        const found = await refModel
          .findOne({ _id: item, ...(opt.match ?? {}) }, opt.select)
          .exec();
        if (found) populatedArr.push(found);
      }
      setNestedValue(doc, path, populatedArr);
    } else {
      const found = await refModel
        .findOne({ _id: currentVal, ...(opt.match ?? {}) }, opt.select)
        .exec();
      setNestedValue(doc, path, found);
    }
  }

  private async finalizeResultDoc(
    rawDoc: Record<string, any>,
    options: QueryOptions,
  ): Promise<any> {
    const projected = applyProjection(deepClone(rawDoc), options.projection);
    if (options.lean) {
      if (options.populate) {
        for (const pop of options.populate) {
          const opt: PopulateOptions =
            typeof pop === "string" ? { path: pop } : pop;
          await this._populateDoc(projected, opt);
        }
      }
      return projected;
    }
    const hydrated = this.hydrate(projected);
    if (options.populate && options.populate.length > 0) {
      await hydrated.populate(options.populate);
    }
    return hydrated;
  }

  async create(doc: Partial<T>): Promise<HydratedDocument<T>>;
  async create(docs: Array<Partial<T>>): Promise<Array<HydratedDocument<T>>>;
  async create(
    docOrDocs: Partial<T> | Array<Partial<T>>,
  ): Promise<HydratedDocument<T> | Array<HydratedDocument<T>>> {
    if (Array.isArray(docOrDocs)) {
      const results: Array<HydratedDocument<T>> = [];
      for (const item of docOrDocs) {
        const doc = this.newDocument(item);
        results.push(await doc.save());
      }
      return results;
    }
    const doc = this.newDocument(docOrDocs);
    return doc.save();
  }

  async insertMany(
    docs: Array<Partial<T>>,
  ): Promise<Array<HydratedDocument<T>>> {
    await runPreHooks(this.schema, "insertMany", this);
    const results: Array<HydratedDocument<T>> = [];
    for (const item of docs) {
      const doc = this.newDocument(item);
      results.push(await doc.save());
    }
    await runPostHooks(this.schema, "insertMany", this, results);
    return results;
  }

  find(
    filter: Record<string, any> = {},
    projection?: string | Record<string, number | boolean>,
    options: QueryOptions = {},
  ): MongooseQuery<Array<HydratedDocument<T>>, T> {
    return new MongooseQuery<Array<HydratedDocument<T>>, T>(
      filter,
      { ...options, ...(projection ? { projection } : {}) },
      async (qFilter, qOpts) => {
        await runPreHooks(this.schema, "find", { filter: qFilter, options: qOpts });
        const scoped = this.scopeFilter(qFilter);
        let matched = this.collection.documents.filter((d) =>
          matchesFilter(d, scoped),
        );
        if (qOpts.sort) {
          const specs = parseSortSpec(qOpts.sort);
          matched = [...matched].sort((a, b) => {
            for (const [field, dir] of specs) {
              const cmp = compareValues(
                getNestedValue(a, field),
                getNestedValue(b, field),
              );
              if (cmp !== 0) return cmp * dir;
            }
            return 0;
          });
        }
        if (qOpts.skip && qOpts.skip > 0) {
          matched = matched.slice(qOpts.skip);
        }
        if (qOpts.limit !== undefined && qOpts.limit >= 0) {
          matched = matched.slice(0, qOpts.limit);
        }
        const results: Array<HydratedDocument<T>> = [];
        for (const rawDoc of matched) {
          results.push(await this.finalizeResultDoc(rawDoc, qOpts));
        }
        await runPostHooks(this.schema, "find", { filter: qFilter, options: qOpts }, results);
        return results;
      },
    );
  }

  findOne(
    filter: Record<string, any> = {},
    projection?: string | Record<string, number | boolean>,
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return new MongooseQuery<HydratedDocument<T> | null, T>(
      filter,
      { ...options, ...(projection ? { projection } : {}) },
      async (qFilter, qOpts) => {
        await runPreHooks(this.schema, "findOne", { filter: qFilter, options: qOpts });
        const scoped = this.scopeFilter(qFilter);
        let matched = this.collection.documents.filter((d) =>
          matchesFilter(d, scoped),
        );
        if (qOpts.sort) {
          const specs = parseSortSpec(qOpts.sort);
          matched = [...matched].sort((a, b) => {
            for (const [field, dir] of specs) {
              const cmp = compareValues(
                getNestedValue(a, field),
                getNestedValue(b, field),
              );
              if (cmp !== 0) return cmp * dir;
            }
            return 0;
          });
        }
        if (qOpts.skip && qOpts.skip > 0) {
          matched = matched.slice(qOpts.skip);
        }
        const rawDoc = matched[0];
        const result = rawDoc
          ? await this.finalizeResultDoc(rawDoc, qOpts)
          : null;
        await runPostHooks(this.schema, "findOne", { filter: qFilter, options: qOpts }, result);
        return result;
      },
    );
  }

  findById(
    id: ObjectId | string | any,
    projection?: string | Record<string, number | boolean>,
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return this.findOne({ _id: id }, projection, options);
  }

  findOneAndUpdate(
    filter: Record<string, any> = {},
    update: Record<string, any> = {},
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return new MongooseQuery<HydratedDocument<T> | null, T>(
      filter,
      options,
      async (qFilter, qOpts) => {
        await runPreHooks(this.schema, "findOneAndUpdate", {
          filter: qFilter,
          update,
          options: qOpts,
        });
        const scoped = this.scopeFilter(qFilter);
        const idx = this.collection.documents.findIndex((d) =>
          matchesFilter(d, scoped),
        );

        const returnAfter =
          qOpts.new === true || qOpts.returnDocument === "after";

        if (idx === -1) {
          if (!qOpts.upsert) {
            await runPostHooks(
              this.schema,
              "findOneAndUpdate",
              { filter: qFilter, update, options: qOpts },
              null,
            );
            return null;
          }
          const seed: Record<string, any> = {};
          for (const [k, v] of Object.entries(scoped)) {
            if (!k.startsWith("$") && !isPlainObject(v)) {
              setNestedValue(seed, k, deepClone(v));
            }
          }
          applyUpdateOperators(seed, update, true);
          const created = await this.create(seed as Partial<T>);
          const out = returnAfter
            ? qOpts.lean
              ? created.toObject()
              : created
            : null;
          await runPostHooks(
            this.schema,
            "findOneAndUpdate",
            { filter: qFilter, update, options: qOpts },
            out,
          );
          return out as HydratedDocument<T> | null;
        }

        const before = deepClone(this.collection.documents[idx]!);
        const updated = deepClone(before);
        applyUpdateOperators(updated, update, false);
        const ts = getTimestampFieldNames(this.schema);
        if (ts?.updatedAt) {
          updated[ts.updatedAt] = ts.currentTime();
        }
        if (qOpts.runValidators) {
          const checkDoc = this.hydrate(updated);
          await checkDoc.validate();
        }
        this.enforceUniqueIndexes(updated, updated._id);
        this.collection.documents[idx] = updated;

        const chosen = returnAfter ? updated : before;
        const result = await this.finalizeResultDoc(chosen, qOpts);
        await runPostHooks(
          this.schema,
          "findOneAndUpdate",
          { filter: qFilter, update, options: qOpts },
          result,
        );
        return result;
      },
    );
  }

  findByIdAndUpdate(
    id: ObjectId | string | any,
    update: Record<string, any> = {},
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  findOneAndReplace(
    filter: Record<string, any> = {},
    replacement: Partial<T>,
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return new MongooseQuery<HydratedDocument<T> | null, T>(
      filter,
      options,
      async (qFilter, qOpts) => {
        const scoped = this.scopeFilter(qFilter);
        const idx = this.collection.documents.findIndex((d) =>
          matchesFilter(d, scoped),
        );
        const returnAfter =
          qOpts.new === true || qOpts.returnDocument === "after";
        if (idx === -1) {
          if (!qOpts.upsert) return null;
          const created = await this.create(replacement);
          return returnAfter ? created : null;
        }
        const before = deepClone(this.collection.documents[idx]!);
        const nextDoc = this.newDocument({
          ...replacement,
          _id: before._id,
        } as Partial<T>);
        await nextDoc.validate();
        const plain = (nextDoc as unknown as MongooseDocument<T>).toPlainRecord();
        this.enforceUniqueIndexes(plain, before._id);
        this.collection.documents[idx] = plain;
        return this.finalizeResultDoc(returnAfter ? plain : before, qOpts);
      },
    );
  }

  findOneAndDelete(
    filter: Record<string, any> = {},
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return new MongooseQuery<HydratedDocument<T> | null, T>(
      filter,
      options,
      async (qFilter, qOpts) => {
        await runPreHooks(this.schema, "findOneAndDelete", {
          filter: qFilter,
          options: qOpts,
        });
        const scoped = this.scopeFilter(qFilter);
        const idx = this.collection.documents.findIndex((d) =>
          matchesFilter(d, scoped),
        );
        if (idx === -1) {
          await runPostHooks(
            this.schema,
            "findOneAndDelete",
            { filter: qFilter, options: qOpts },
            null,
          );
          return null;
        }
        const [removed] = this.collection.documents.splice(idx, 1);
        const result = await this.finalizeResultDoc(removed!, qOpts);
        await runPostHooks(
          this.schema,
          "findOneAndDelete",
          { filter: qFilter, options: qOpts },
          result,
        );
        return result;
      },
    );
  }

  findByIdAndDelete(
    id: ObjectId | string | any,
    options: QueryOptions = {},
  ): MongooseQuery<HydratedDocument<T> | null, T> {
    return this.findOneAndDelete({ _id: id }, options);
  }

  updateOne(
    filter: Record<string, any> = {},
    update: Record<string, any> = {},
    options: QueryOptions = {},
  ): MongooseQuery<UpdateWriteOpResult, T> {
    return new MongooseQuery<UpdateWriteOpResult, T>(
      filter,
      options,
      async (qFilter, qOpts) => {
        await runPreHooks(this.schema, "updateOne", { filter: qFilter, update });
        const scoped = this.scopeFilter(qFilter);
        const idx = this.collection.documents.findIndex((d) =>
          matchesFilter(d, scoped),
        );
        if (idx === -1) {
          if (qOpts.upsert) {
            const seed: Record<string, any> = {};
            for (const [k, v] of Object.entries(scoped)) {
              if (!k.startsWith("$") && !isPlainObject(v)) {
                setNestedValue(seed, k, deepClone(v));
              }
            }
            applyUpdateOperators(seed, update, true);
            const created = await this.create(seed as Partial<T>);
            return {
              acknowledged: true,
              matchedCount: 0,
              modifiedCount: 0,
              upsertedCount: 1,
              upsertedId: created._id,
            };
          }
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          };
        }
        const updated = deepClone(this.collection.documents[idx]!);
        applyUpdateOperators(updated, update, false);
        const ts = getTimestampFieldNames(this.schema);
        if (ts?.updatedAt) {
          updated[ts.updatedAt] = ts.currentTime();
        }
        this.enforceUniqueIndexes(updated, updated._id);
        this.collection.documents[idx] = updated;
        const result: UpdateWriteOpResult = {
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        };
        await runPostHooks(this.schema, "updateOne", { filter: qFilter, update }, result);
        return result;
      },
    );
  }

  updateMany(
    filter: Record<string, any> = {},
    update: Record<string, any> = {},
    options: QueryOptions = {},
  ): MongooseQuery<UpdateWriteOpResult, T> {
    return new MongooseQuery<UpdateWriteOpResult, T>(
      filter,
      options,
      async (qFilter) => {
        await runPreHooks(this.schema, "updateMany", { filter: qFilter, update });
        const scoped = this.scopeFilter(qFilter);
        let matchedCount = 0;
        const ts = getTimestampFieldNames(this.schema);
        for (let i = 0; i < this.collection.documents.length; i++) {
          const doc = this.collection.documents[i]!;
          if (!matchesFilter(doc, scoped)) continue;
          matchedCount++;
          const updated = deepClone(doc);
          applyUpdateOperators(updated, update, false);
          if (ts?.updatedAt) {
            updated[ts.updatedAt] = ts.currentTime();
          }
          this.enforceUniqueIndexes(updated, updated._id);
          this.collection.documents[i] = updated;
        }
        const result: UpdateWriteOpResult = {
          acknowledged: true,
          matchedCount,
          modifiedCount: matchedCount,
          upsertedCount: 0,
          upsertedId: null,
        };
        await runPostHooks(this.schema, "updateMany", { filter: qFilter, update }, result);
        return result;
      },
    );
  }

  replaceOne(
    filter: Record<string, any> = {},
    replacement: Partial<T>,
    options: QueryOptions = {},
  ): MongooseQuery<UpdateWriteOpResult, T> {
    return new MongooseQuery<UpdateWriteOpResult, T>(
      filter,
      options,
      async (qFilter, qOpts) => {
        const scoped = this.scopeFilter(qFilter);
        const idx = this.collection.documents.findIndex((d) =>
          matchesFilter(d, scoped),
        );
        if (idx === -1) {
          if (qOpts.upsert) {
            const created = await this.create(replacement);
            return {
              acknowledged: true,
              matchedCount: 0,
              modifiedCount: 0,
              upsertedCount: 1,
              upsertedId: created._id,
            };
          }
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          };
        }
        const existingId = this.collection.documents[idx]!._id;
        const nextDoc = this.newDocument({ ...replacement, _id: existingId } as Partial<T>);
        await nextDoc.validate();
        const plain = (nextDoc as unknown as MongooseDocument<T>).toPlainRecord();
        this.enforceUniqueIndexes(plain, existingId);
        this.collection.documents[idx] = plain;
        return {
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
          upsertedCount: 0,
          upsertedId: null,
        };
      },
    );
  }

  deleteOne(
    filter: Record<string, any> = {},
  ): MongooseQuery<DeleteResult, T> {
    return new MongooseQuery<DeleteResult, T>(filter, {}, async (qFilter) => {
      const scoped = this.scopeFilter(qFilter);
      const idx = this.collection.documents.findIndex((d) =>
        matchesFilter(d, scoped),
      );
      if (idx === -1) {
        return { acknowledged: true, deletedCount: 0 };
      }
      this.collection.documents.splice(idx, 1);
      return { acknowledged: true, deletedCount: 1 };
    });
  }

  deleteMany(
    filter: Record<string, any> = {},
  ): MongooseQuery<DeleteResult, T> {
    return new MongooseQuery<DeleteResult, T>(filter, {}, async (qFilter) => {
      const scoped = this.scopeFilter(qFilter);
      let deletedCount = 0;
      for (let i = this.collection.documents.length - 1; i >= 0; i--) {
        if (matchesFilter(this.collection.documents[i]!, scoped)) {
          this.collection.documents.splice(i, 1);
          deletedCount++;
        }
      }
      return { acknowledged: true, deletedCount };
    });
  }

  countDocuments(
    filter: Record<string, any> = {},
  ): MongooseQuery<number, T> {
    return new MongooseQuery<number, T>(filter, {}, async (qFilter) => {
      const scoped = this.scopeFilter(qFilter);
      return this.collection.documents.filter((d) => matchesFilter(d, scoped))
        .length;
    });
  }

  estimatedDocumentCount(): MongooseQuery<number, T> {
    return this.countDocuments({});
  }

  exists(
    filter: Record<string, any> = {},
  ): MongooseQuery<{ _id: ObjectId } | null, T> {
    return new MongooseQuery<{ _id: ObjectId } | null, T>(
      filter,
      {},
      async (qFilter) => {
        const scoped = this.scopeFilter(qFilter);
        const found = this.collection.documents.find((d) =>
          matchesFilter(d, scoped),
        );
        return found ? { _id: found._id } : null;
      },
    );
  }

  distinct<TVal = any>(
    field: string,
    filter: Record<string, any> = {},
  ): MongooseQuery<TVal[], T> {
    return new MongooseQuery<TVal[], T>(filter, {}, async (qFilter) => {
      const scoped = this.scopeFilter(qFilter);
      const out: TVal[] = [];
      for (const doc of this.collection.documents) {
        if (!matchesFilter(doc, scoped)) continue;
        const val = getNestedValue(doc, field);
        const items = Array.isArray(val) ? val : [val];
        for (const item of items) {
          if (item !== undefined && !out.some((x) => valuesEqual(x, item))) {
            out.push(deepClone(item));
          }
        }
      }
      return out;
    });
  }

  aggregate<R = any>(
    pipeline: Array<Record<string, any>> = [],
  ): MongooseQuery<R[], T> {
    return new MongooseQuery<R[], T>({}, {}, async () => {
      const scoped = this.scopeFilter({});
      let docs: Array<Record<string, any>> = this.collection.documents
        .filter((d) => matchesFilter(d, scoped))
        .map((d) => deepClone(d));

      for (const stage of pipeline) {
        if ("$match" in stage) {
          docs = docs.filter((d) => matchesFilter(d, stage.$match));
        } else if ("$project" in stage) {
          docs = docs.map((d) => applyProjection(d, stage.$project));
        } else if ("$addFields" in stage || "$set" in stage) {
          const spec = stage.$addFields ?? stage.$set;
          docs = docs.map((d) => {
            const copy = deepClone(d);
            for (const [k, expr] of Object.entries(spec)) {
              copy[k] =
                typeof expr === "string" && expr.startsWith("$")
                  ? getNestedValue(copy, expr.slice(1))
                  : deepClone(expr);
            }
            return copy;
          });
        } else if ("$sort" in stage) {
          const specs = parseSortSpec(stage.$sort);
          docs = [...docs].sort((a, b) => {
            for (const [field, dir] of specs) {
              const cmp = compareValues(
                getNestedValue(a, field),
                getNestedValue(b, field),
              );
              if (cmp !== 0) return cmp * dir;
            }
            return 0;
          });
        } else if ("$skip" in stage) {
          docs = docs.slice(Number(stage.$skip));
        } else if ("$limit" in stage) {
          docs = docs.slice(0, Number(stage.$limit));
        } else if ("$count" in stage) {
          const fieldName = String(stage.$count);
          docs = docs.length > 0 ? [{ [fieldName]: docs.length }] : [];
        } else if ("$unwind" in stage) {
          const path =
            typeof stage.$unwind === "string"
              ? stage.$unwind.replace(/^\$/, "")
              : String(stage.$unwind.path).replace(/^\$/, "");
          const next: Array<Record<string, any>> = [];
          for (const doc of docs) {
            const arr = getNestedValue(doc, path);
            if (Array.isArray(arr)) {
              for (const elem of arr) {
                const copy = deepClone(doc);
                setNestedValue(copy, path, elem);
                next.push(copy);
              }
            }
          }
          docs = next;
        } else if ("$group" in stage) {
          const groupSpec = stage.$group as Record<string, any>;
          const groups = new Map<string, { id: any; items: Array<Record<string, any>> }>();
          for (const doc of docs) {
            const idExpr = groupSpec._id;
            const groupId =
              idExpr === null
                ? null
                : typeof idExpr === "string" && idExpr.startsWith("$")
                  ? getNestedValue(doc, idExpr.slice(1))
                  : idExpr;
            const key = JSON.stringify(groupId);
            let bucket = groups.get(key);
            if (!bucket) {
              bucket = { id: groupId, items: [] };
              groups.set(key, bucket);
            }
            bucket.items.push(doc);
          }
          const groupedDocs: Array<Record<string, any>> = [];
          for (const bucket of groups.values()) {
            const row: Record<string, any> = { _id: bucket.id };
            for (const [field, acc] of Object.entries(groupSpec)) {
              if (field === "_id" || !isPlainObject(acc)) continue;
              const resolveVal = (d: Record<string, any>, expr: any) =>
                typeof expr === "string" && expr.startsWith("$")
                  ? getNestedValue(d, expr.slice(1))
                  : expr;
              if ("$sum" in acc) {
                row[field] = bucket.items.reduce(
                  (sum, d) => sum + Number(resolveVal(d, acc.$sum) ?? 0),
                  0,
                );
              } else if ("$avg" in acc) {
                const total = bucket.items.reduce(
                  (sum, d) => sum + Number(resolveVal(d, acc.$avg) ?? 0),
                  0,
                );
                row[field] = bucket.items.length > 0 ? total / bucket.items.length : null;
              } else if ("$min" in acc) {
                row[field] = bucket.items
                  .map((d) => resolveVal(d, acc.$min))
                  .sort(compareValues)[0];
              } else if ("$max" in acc) {
                const sorted = bucket.items
                  .map((d) => resolveVal(d, acc.$max))
                  .sort(compareValues);
                row[field] = sorted[sorted.length - 1];
              } else if ("$push" in acc) {
                row[field] = bucket.items.map((d) => resolveVal(d, acc.$push));
              } else if ("$first" in acc) {
                row[field] =
                  bucket.items.length > 0
                    ? resolveVal(bucket.items[0]!, acc.$first)
                    : undefined;
              } else if ("$last" in acc) {
                row[field] =
                  bucket.items.length > 0
                    ? resolveVal(
                        bucket.items[bucket.items.length - 1]!,
                        acc.$last,
                      )
                    : undefined;
              }
            }
            groupedDocs.push(row);
          }
          docs = groupedDocs;
        }
      }
      return docs as R[];
    });
  }

  async bulkWrite(
    operations: Array<Record<string, any>>,
  ): Promise<{
    ok: number;
    insertedCount: number;
    matchedCount: number;
    modifiedCount: number;
    deletedCount: number;
    upsertedCount: number;
  }> {
    let insertedCount = 0;
    let matchedCount = 0;
    let modifiedCount = 0;
    let deletedCount = 0;
    let upsertedCount = 0;

    for (const op of operations) {
      if (op.insertOne) {
        await this.create(op.insertOne.document);
        insertedCount++;
      } else if (op.updateOne) {
        const res = await this.updateOne(
          op.updateOne.filter,
          op.updateOne.update,
          { upsert: op.updateOne.upsert },
        );
        matchedCount += res.matchedCount;
        modifiedCount += res.modifiedCount;
        upsertedCount += res.upsertedCount;
      } else if (op.updateMany) {
        const res = await this.updateMany(
          op.updateMany.filter,
          op.updateMany.update,
        );
        matchedCount += res.matchedCount;
        modifiedCount += res.modifiedCount;
      } else if (op.deleteOne) {
        const res = await this.deleteOne(op.deleteOne.filter);
        deletedCount += res.deletedCount;
      } else if (op.deleteMany) {
        const res = await this.deleteMany(op.deleteMany.filter);
        deletedCount += res.deletedCount;
      } else if (op.replaceOne) {
        const res = await this.replaceOne(
          op.replaceOne.filter,
          op.replaceOne.replacement,
          { upsert: op.replaceOne.upsert },
        );
        matchedCount += res.matchedCount;
        modifiedCount += res.modifiedCount;
        upsertedCount += res.upsertedCount;
      }
    }

    return {
      ok: 1,
      insertedCount,
      matchedCount,
      modifiedCount,
      deletedCount,
      upsertedCount,
    };
  }

  discriminator<D extends Record<string, any> = T>(
    name: string,
    schema: MongooseSchemaLike<D> | MongooseSchema<D>,
    value?: string,
  ): MongooseModel<D> {
    const key = this.schema.options.discriminatorKey ?? "__t";
    const discValue = value ?? name;
    const mergedSchema = this.schema.clone() as unknown as MongooseSchema<D>;
    const subSchema =
      schema instanceof MongooseSchema
        ? schema
        : new MongooseSchema<D>(schema?.obj ?? schema, schema?.options);
    mergedSchema.add(subSchema);
    Object.assign(mergedSchema.methods, subSchema.methods);
    Object.assign(mergedSchema.statics, subSchema.statics);
    for (const [vName, v] of Object.entries(subSchema.virtuals)) {
      if (vName === "id") continue;
      const nv = mergedSchema.virtual(vName, v.options);
      for (const g of v.getters) nv.get(g);
      for (const s of v.setters) nv.set(s);
    }
    for (const h of subSchema.preHooks) mergedSchema.preHooks.push(h);
    for (const h of subSchema.postHooks) mergedSchema.postHooks.push(h);

    const discModel = new MongooseModel<D>(
      name,
      mergedSchema,
      this.collection,
      this.db,
      { key, value: discValue },
    );
    this.discriminators[name] = discModel;
    this.db.models[name] = discModel;
    return discModel;
  }

  async createIndexes(): Promise<void> {
    this.collection.indexDefinitions.length = 0;
    for (const [fields, opts] of this.schema.indexes()) {
      this.collection.indexDefinitions.push([fields, opts]);
    }
  }

  async syncIndexes(): Promise<string[]> {
    await this.createIndexes();
    return [];
  }
}

export class MongooseConnection extends EventEmitter implements ConnectionLike {
  readonly uri: string;
  readonly options: ConnectOptions;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readyState = 0; // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  readonly models: Record<string, MongooseModel<any>> = {};
  readonly collections: Record<string, MongooseCollection> = {};
  readonly plugins: Array<[PluginFunction<any, any>, any]> = [];
  private closed = false;

  constructor(uri = "memory://localhost/test", options: ConnectOptions = {}) {
    super();
    this.uri = uri;
    this.options = { ...options };

    let parsedName = options.dbName ?? "test";
    let parsedHost = "localhost";
    let parsedPort = 27017;
    try {
      const normalized = uri.replace(/^mongodb(\+srv)?:\/\//, "http://").replace(/^memory:\/\//, "http://");
      const url = new URL(normalized);
      if (url.hostname) parsedHost = url.hostname;
      if (url.port) parsedPort = Number(url.port) || 27017;
      const pathDb = url.pathname.replace(/^\/+/, "").split("/")[0];
      if (!options.dbName && pathDb) {
        parsedName = pathDb;
      }
    } catch {
      // keep defaults
    }

    this.name = parsedName;
    this.host = parsedHost;
    this.port = parsedPort;
    this.readyState = 2; // connecting
  }

  async asPromise(): Promise<this> {
    if (this.closed) {
      throw new MongooseError("Connection has been closed");
    }
    this.readyState = 1; // connected
    this.emit("connected", this);
    this.emit("open", this);
    return this;
  }

  plugin<POptions = any>(
    fn: PluginFunction<any, POptions>,
    opts?: POptions,
  ): this {
    this.plugins.push([fn, opts]);
    return this;
  }

  model<T extends Record<string, any> = Record<string, any>>(
    name: string,
    schema?: MongooseSchemaLike<T> | MongooseSchema<T> | Record<string, any>,
    collectionName?: string,
  ): MongooseModel<T> {
    if (!schema) {
      const existing = this.models[name];
      if (!existing) {
        throw new MongooseError(`Schema hasn't been registered for model "${name}".`);
      }
      return existing as MongooseModel<T>;
    }

    if (this.models[name] && !(schema as MongooseSchema<T>)?.options?.overwriteModels) {
      return this.models[name] as MongooseModel<T>;
    }

    const resolvedSchema =
      schema instanceof MongooseSchema
        ? schema
        : new MongooseSchema<T>(
            (schema as any).obj ?? schema,
            (schema as any).options ?? {},
          );

    // Apply connection-level plugins to the schema
    for (const [pluginFn, pluginOpts] of this.plugins) {
      resolvedSchema.plugin(pluginFn, pluginOpts);
    }

    const colName =
      collectionName ??
      resolvedSchema.options.collection ??
      pluralizeCollectionName(name);
    let col = this.collections[colName];
    if (!col) {
      col = new MongooseCollection(colName);
      this.collections[colName] = col;
    }

    const model = new MongooseModel<T>(name, resolvedSchema, col, this);
    this.models[name] = model;
    return model;
  }

  modelNames(): string[] {
    return Object.keys(this.models);
  }

  deleteModel(name: string | RegExp): this {
    if (typeof name === "string") {
      delete this.models[name];
    } else {
      for (const k of Object.keys(this.models)) {
        if (name.test(k)) delete this.models[k];
      }
    }
    return this;
  }

  collection(name: string): MongooseCollection {
    let col = this.collections[name];
    if (!col) {
      col = new MongooseCollection(name);
      this.collections[name] = col;
    }
    return col;
  }

  useDb(dbName: string): MongooseConnection {
    const conn = new MongooseConnection(this.uri, {
      ...this.options,
      dbName,
    });
    conn.readyState = this.readyState;
    return conn;
  }

  async dropCollection(name: string): Promise<boolean> {
    const col = this.collections[name];
    if (!col) return false;
    await col.drop();
    delete this.collections[name];
    return true;
  }

  async dropDatabase(): Promise<boolean> {
    for (const col of Object.values(this.collections)) {
      await col.drop();
    }
    for (const k of Object.keys(this.collections)) {
      delete this.collections[k];
    }
    return true;
  }

  async close(_force?: boolean): Promise<void> {
    if (this.closed) return;
    this.readyState = 3; // disconnecting
    this.emit("disconnecting", this);
    this.closed = true;
    this.readyState = 0; // disconnected
    this.emit("disconnected", this);
    this.emit("close", this);
  }

  async destroy(force?: boolean): Promise<void> {
    await this.close(force);
  }
}

export function createConnection(
  uri?: string,
  options?: ConnectOptions,
): MongooseConnection {
  return new MongooseConnection(uri, options);
}
