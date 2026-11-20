import { EventEmitter } from "node:events";
import { MongooseError } from "../errors/mongoose.error";
import type {
  AnyObject,
  HookMethod,
  IndexDefinition,
  IndexOptions,
  MiddlewareOptions,
  MongooseSchemaLike,
  MongooseSchemaTypeLike,
  PluginFunction,
  SchemaOptions,
  SchemaTypeOptions,
  SearchIndexDescription,
  Validator,
  ValidatorFunction,
  VirtualTypeLike,
  VirtualTypeOptions,
} from "../interfaces/schema-types.interface";
import { RAW_OBJECT_DEFINITION } from "../mongoose.constants";
import { deepClone, isPlainObject } from "../utils/shared.utils";
import { ObjectId } from "./object-id";

export interface RegisteredHook {
  method: HookMethod | RegExp;
  options: MiddlewareOptions;
  fn: (this: any, ...args: any[]) => any;
}

export class MongooseSchemaType<T = any> implements MongooseSchemaTypeLike<T> {
  static schemaName = "SchemaType";

  readonly path: string;
  readonly instance: string;
  readonly options: SchemaTypeOptions<T>;
  readonly OptionsConstructor: SchemaTypeOptions<T>;
  readonly validators: Validator<T>[] = [];
  readonly setters: Array<
    (
      val?: unknown,
      priorVal?: unknown,
      doc?: any,
      options?: Record<string, any> | null,
    ) => unknown
  > = [];
  readonly getters: Array<(val: any, schematype?: any) => any> = [];
  readonly $conditionalHandlers: Record<string, (val: any, context: any) => any> =
    {};
  isRequired?: boolean;
  schema?: MongooseSchema<any>;
  private defaultValue?: any;
  private hasDefault = false;
  private embeddedType?: MongooseSchemaType<any>;
  private checkRequiredFn: (v: any) => boolean = (v) =>
    v !== undefined && v !== null;

  constructor(
    path: string,
    options: SchemaTypeOptions<T> = {},
    instance = "Mixed",
  ) {
    this.path = path;
    this.options = { ...options };
    this.OptionsConstructor = this.options;
    this.instance = instance;

    if (options.default !== undefined) {
      this.defaultValue = options.default;
      this.hasDefault = true;
    }
    if (options.required !== undefined) {
      this.isRequired = Array.isArray(options.required)
        ? Boolean(options.required[0])
        : typeof options.required === "function"
          ? true
          : Boolean(options.required);
    }
    if (options.get) {
      this.getters.push(options.get);
    }
    if (options.set) {
      this.setters.push(options.set as any);
    }
    if (options.validate) {
      const list = Array.isArray(options.validate)
        ? options.validate
        : [options.validate];
      this.validateAll(list);
    }
    if (options.schema instanceof MongooseSchema) {
      this.schema = options.schema;
    }
  }

  setEmbeddedSchemaType(type: MongooseSchemaType<any>): void {
    this.embeddedType = type;
  }

  getEmbeddedSchemaType<TEmbedded = any>():
    | MongooseSchemaTypeLike<TEmbedded>
    | undefined {
    return this.embeddedType as MongooseSchemaTypeLike<TEmbedded> | undefined;
  }

  default(val: any): any {
    if (arguments.length === 0) {
      return this.defaultValue;
    }
    this.defaultValue = val;
    this.hasDefault = true;
    this.options.default = val;
    return this;
  }

  getDefault(doc?: any): any {
    if (!this.hasDefault) {
      return undefined;
    }
    if (typeof this.defaultValue === "function") {
      if (this.defaultValue === Date.now) {
        return new Date();
      }
      return this.defaultValue.call(doc, doc);
    }
    return deepClone(this.defaultValue);
  }

  required(required: boolean, message?: string): this {
    this.isRequired = required;
    this.options.required = message ? [required, message] : required;
    return this;
  }

  index(options: any): this {
    this.options.index = options;
    return this;
  }

  unique(bool: boolean): this {
    this.options.unique = bool;
    return this;
  }

  sparse(bool: boolean): this {
    this.options.sparse = bool;
    return this;
  }

  text(bool: boolean): this {
    this.options.text = bool;
    return this;
  }

  select(val: boolean): this {
    this.options.select = val;
    return this;
  }

  immutable(bool: boolean): this {
    this.options.immutable = bool;
    return this;
  }

  allowNull(allowNull: boolean): this {
    this.options.allowNull = allowNull;
    return this;
  }

  ref(ref: string | boolean | any): this {
    this.options.ref = ref;
    return this;
  }

  get(fn: Function): this {
    this.getters.push(fn as (val: any, schematype?: any) => any);
    return this;
  }

  set(fn: Function): this {
    this.setters.push(fn as any);
    return this;
  }

  transform(fn: (value: any) => any): this {
    this.options.transform = fn;
    return this;
  }

  validate(
    obj: RegExp | Validator<T> | ValidatorFunction<T>,
    errorMsg?: string,
    type?: string,
  ): this {
    if (obj instanceof RegExp) {
      this.validators.push({
        validator: (val: any) =>
          typeof val === "string" ? obj.test(val) : true,
        message: errorMsg ?? `Path \`${this.path}\` is invalid`,
        type: type ?? "regexp",
      });
    } else if (typeof obj === "function") {
      this.validators.push({
        validator: obj,
        message: errorMsg ?? `Validator failed for path \`${this.path}\``,
        type: type ?? "user defined",
      });
    } else if (obj && typeof obj === "object" && typeof obj.validator === "function") {
      this.validators.push({
        validator: obj.validator,
        message:
          obj.message ?? errorMsg ?? `Validator failed for path \`${this.path}\``,
        type: obj.type ?? type ?? "user defined",
      });
    }
    return this;
  }

  validateAll(
    validators: Array<RegExp | Validator<T> | ValidatorFunction<T>>,
  ): this {
    for (const v of validators) {
      this.validate(v);
    }
    return this;
  }

  checkRequired(checkRequired?: (v: any) => boolean): (v: any) => boolean {
    if (typeof checkRequired === "function") {
      this.checkRequiredFn = checkRequired;
    }
    return this.checkRequiredFn;
  }

  cast(
    val: any,
    doc?: any,
    _init?: boolean,
    prev?: any,
    _options?: any,
  ): any {
    let result = val;
    for (const setter of this.setters) {
      result = setter.call(doc, result, prev, doc);
    }
    if (result === null || result === undefined) {
      return result;
    }

    switch (this.instance) {
      case "String": {
        let str = String(result);
        if (this.options.trim) str = str.trim();
        if (this.options.lowercase) str = str.toLowerCase();
        if (this.options.uppercase) str = str.toUpperCase();
        return str;
      }
      case "Number": {
        if (typeof result === "number") {
          if (Number.isNaN(result)) {
            throw new MongooseError(
              `Cast to Number failed for value "${val}" at path "${this.path}"`,
            );
          }
          return result;
        }
        const n = Number(result);
        if (Number.isNaN(n)) {
          throw new MongooseError(
            `Cast to Number failed for value "${val}" at path "${this.path}"`,
          );
        }
        return n;
      }
      case "Boolean": {
        if (typeof result === "boolean") return result;
        if (result === "true" || result === 1 || result === "1") return true;
        if (result === "false" || result === 0 || result === "0") return false;
        return Boolean(result);
      }
      case "Date": {
        if (result instanceof Date) return result;
        const d = new Date(result);
        if (Number.isNaN(d.getTime())) {
          throw new MongooseError(
            `Cast to date failed for value "${val}" at path "${this.path}"`,
          );
        }
        return d;
      }
      case "ObjectId": {
        if (result instanceof ObjectId) return result;
        if (ObjectId.isValid(result)) return new ObjectId(result);
        throw new MongooseError(
          `Cast to ObjectId failed for value "${val}" at path "${this.path}"`,
        );
      }
      case "BigInt": {
        return typeof result === "bigint" ? result : BigInt(result);
      }
      case "Array": {
        const arr = Array.isArray(result) ? result : [result];
        if (this.embeddedType) {
          return arr.map((item) => this.embeddedType!.cast(item, doc));
        }
        return arr;
      }
      case "Map": {
        if (result instanceof Map) return result;
        if (isPlainObject(result)) {
          return new Map(Object.entries(result));
        }
        return result;
      }
      default:
        return result;
    }
  }

  async doValidate(value: any, doc: any): Promise<Error | null> {
    // 1. Required check
    const reqOpt = this.options.required;
    if (reqOpt !== undefined) {
      let requiredFlag = false;
      let requiredMsg = `Path \`${this.path}\` is required.`;
      if (Array.isArray(reqOpt)) {
        const flagOrFn = reqOpt[0];
        requiredFlag =
          typeof flagOrFn === "function"
            ? Boolean(flagOrFn.call(doc))
            : Boolean(flagOrFn);
        if (reqOpt[1]) requiredMsg = reqOpt[1];
      } else if (typeof reqOpt === "function") {
        requiredFlag = Boolean(reqOpt.call(doc));
      } else {
        requiredFlag = Boolean(reqOpt);
      }

      const isMissing =
        value === undefined ||
        value === null ||
        (this.instance === "String" && value === "");
      if (requiredFlag && isMissing) {
        return new MongooseError(requiredMsg);
      }
    }

    if (value === undefined || value === null) {
      return null;
    }

    // 2. Enum check
    if (this.options.enum !== undefined) {
      let allowed: readonly unknown[];
      let enumMsg = `\`${String(value)}\` is not a valid enum value for path \`${this.path}\`.`;
      if (Array.isArray(this.options.enum)) {
        allowed = this.options.enum;
      } else if (
        typeof this.options.enum === "object" &&
        "values" in this.options.enum &&
        Array.isArray(this.options.enum.values)
      ) {
        const enumObj = this.options.enum as {
          values: ReadonlyArray<string | number | null>;
          message?: string;
        };
        allowed = enumObj.values;
        if (enumObj.message) {
          enumMsg = String(enumObj.message);
        }
      } else {
        allowed = Object.values(this.options.enum);
      }
      if (!allowed.includes(value)) {
        return new MongooseError(enumMsg);
      }
    }

    // 3. String checks (minlength/maxlength/match)
    if (typeof value === "string") {
      const minLenOpt = this.options.minlength ?? this.options.minLength;
      if (minLenOpt !== undefined) {
        const [minLen, msg] = Array.isArray(minLenOpt)
          ? [minLenOpt[0], minLenOpt[1]]
          : [minLenOpt, undefined];
        if (value.length < (minLen as number)) {
          return new MongooseError(
            typeof msg === "function"
              ? msg({ value, path: this.path })
              : (msg ??
                `Path \`${this.path}\` (\`${value}\`) is shorter than the minimum allowed length (${minLen}).`),
          );
        }
      }
      const maxLenOpt = this.options.maxlength ?? this.options.maxLength;
      if (maxLenOpt !== undefined) {
        const [maxLen, msg] = Array.isArray(maxLenOpt)
          ? [maxLenOpt[0], maxLenOpt[1]]
          : [maxLenOpt, undefined];
        if (value.length > (maxLen as number)) {
          return new MongooseError(
            typeof msg === "function"
              ? msg({ value, path: this.path })
              : (msg ??
                `Path \`${this.path}\` (\`${value}\`) is longer than the maximum allowed length (${maxLen}).`),
          );
        }
      }
      if (this.options.match !== undefined) {
        const [regex, msg] = Array.isArray(this.options.match)
          ? [this.options.match[0], this.options.match[1]]
          : [this.options.match, undefined];
        if (regex instanceof RegExp && !regex.test(value)) {
          return new MongooseError(
            msg ?? `Path \`${this.path}\` is invalid (${value}).`,
          );
        }
      }
    }

    // 4. Number / Date min & max
    if (typeof value === "number" || value instanceof Date) {
      const numericVal = value instanceof Date ? value.getTime() : value;
      if (this.options.min !== undefined) {
        const [minVal, msg] = Array.isArray(this.options.min)
          ? [this.options.min[0], this.options.min[1]]
          : [this.options.min, undefined];
        const minNum = minVal instanceof Date ? minVal.getTime() : (minVal as number);
        if (numericVal < minNum) {
          return new MongooseError(
            typeof msg === "function"
              ? msg({ value, path: this.path })
              : (msg ?? `Path \`${this.path}\` (${value}) is less than minimum allowed value (${minVal}).`),
          );
        }
      }
      if (this.options.max !== undefined) {
        const [maxVal, msg] = Array.isArray(this.options.max)
          ? [this.options.max[0], this.options.max[1]]
          : [this.options.max, undefined];
        const maxNum = maxVal instanceof Date ? maxVal.getTime() : (maxVal as number);
        if (numericVal > maxNum) {
          return new MongooseError(
            typeof msg === "function"
              ? msg({ value, path: this.path })
              : (msg ?? `Path \`${this.path}\` (${value}) is more than maximum allowed value (${maxVal}).`),
          );
        }
      }
    }

    // 5. Custom validators
    for (const v of this.validators) {
      const ok = await v.validator.call(doc, value, { path: this.path, value });
      if (!ok) {
        const msg =
          typeof v.message === "function"
            ? v.message({ value, path: this.path, type: v.type })
            : (v.message ?? `Validator failed for path \`${this.path}\``);
        return new MongooseError(msg);
      }
    }

    return null;
  }

  toJSONSchema(): Record<string, any> {
    const map: Record<string, string> = {
      String: "string",
      Number: "number",
      Boolean: "boolean",
      Date: "string",
      Array: "array",
      ObjectId: "string",
      Mixed: "object",
      Map: "object",
    };
    return { type: map[this.instance] ?? "object" };
  }
}

class SchemaString extends MongooseSchemaType<string> {
  static override schemaName = "String";
  constructor(path: string, options?: SchemaTypeOptions<string>) {
    super(path, options, "String");
  }
}
class SchemaNumber extends MongooseSchemaType<number> {
  static override schemaName = "Number";
  constructor(path: string, options?: SchemaTypeOptions<number>) {
    super(path, options, "Number");
  }
}
class SchemaBoolean extends MongooseSchemaType<boolean> {
  static override schemaName = "Boolean";
  constructor(path: string, options?: SchemaTypeOptions<boolean>) {
    super(path, options, "Boolean");
  }
}
class SchemaDate extends MongooseSchemaType<Date> {
  static override schemaName = "Date";
  constructor(path: string, options?: SchemaTypeOptions<Date>) {
    super(path, options, "Date");
  }
}
class SchemaBuffer extends MongooseSchemaType<Uint8Array> {
  static override schemaName = "Buffer";
  constructor(path: string, options?: SchemaTypeOptions<Uint8Array>) {
    super(path, options, "Buffer");
  }
}
class SchemaMixed extends MongooseSchemaType<any> {
  static override schemaName = "Mixed";
  constructor(path: string, options?: SchemaTypeOptions<any>) {
    super(path, options, "Mixed");
  }
}
class SchemaObjectId extends MongooseSchemaType<ObjectId> {
  static override schemaName = "ObjectId";
  constructor(path: string, options?: SchemaTypeOptions<ObjectId>) {
    super(path, options, "ObjectId");
  }
}
class SchemaArray extends MongooseSchemaType<any[]> {
  static override schemaName = "Array";
  constructor(path: string, options?: SchemaTypeOptions<any[]>) {
    super(path, options, "Array");
  }
}
class SchemaDecimal128 extends MongooseSchemaType<string> {
  static override schemaName = "Decimal128";
  constructor(path: string, options?: SchemaTypeOptions<string>) {
    super(path, options, "Decimal128");
  }
}
class SchemaMap extends MongooseSchemaType<Map<string, any>> {
  static override schemaName = "Map";
  constructor(path: string, options?: SchemaTypeOptions<Map<string, any>>) {
    super(path, options, "Map");
  }
}
class SchemaBigInt extends MongooseSchemaType<bigint> {
  static override schemaName = "BigInt";
  constructor(path: string, options?: SchemaTypeOptions<bigint>) {
    super(path, options, "BigInt");
  }
}
class SchemaUUID extends MongooseSchemaType<string> {
  static override schemaName = "UUID";
  constructor(path: string, options?: SchemaTypeOptions<string>) {
    super(path, options, "UUID");
  }
}

export const SchemaTypes = {
  String: SchemaString,
  Number: SchemaNumber,
  Boolean: SchemaBoolean,
  Date: SchemaDate,
  Buffer: SchemaBuffer,
  Mixed: SchemaMixed,
  ObjectId: SchemaObjectId,
  Array: SchemaArray,
  Decimal128: SchemaDecimal128,
  Map: SchemaMap,
  BigInt: SchemaBigInt,
  UUID: SchemaUUID,
  Double: SchemaNumber,
  Int32: SchemaNumber,
} as const;

export class MongooseVirtualType<T = any> implements VirtualTypeLike<T> {
  readonly path: string;
  readonly options: VirtualTypeOptions<T>;
  readonly getters: Array<(...args: any[]) => any> = [];
  readonly setters: Array<(...args: any[]) => any> = [];

  constructor(path: string, options: VirtualTypeOptions<T> = {}) {
    this.path = path;
    this.options = { ...options };
    if (typeof options.get === "function") {
      this.getters.push(options.get);
    }
    if (typeof options.set === "function") {
      this.setters.push(options.set);
    }
  }

  get(fn: (...args: any[]) => any): this {
    this.getters.push(fn);
    return this;
  }

  set(fn: (...args: any[]) => any): this {
    this.setters.push(fn);
    return this;
  }

  applyGetters(value: any, scope: T): any {
    let v = value;
    for (const getter of this.getters) {
      v = getter.call(scope, v, this, scope);
    }
    return v;
  }

  applySetters(value: any, scope: T): any {
    let v = value;
    for (const setter of this.setters) {
      const next = setter.call(scope, v, this, scope);
      if (next !== undefined) {
        v = next;
      }
    }
    return v;
  }
}

function inferSchemaTypeInstance(rawType: any): string {
  if (rawType === String || rawType === SchemaTypes.String || rawType === "String") {
    return "String";
  }
  if (rawType === Number || rawType === SchemaTypes.Number || rawType === "Number") {
    return "Number";
  }
  if (rawType === Boolean || rawType === SchemaTypes.Boolean || rawType === "Boolean") {
    return "Boolean";
  }
  if (rawType === Date || rawType === SchemaTypes.Date || rawType === "Date") {
    return "Date";
  }
  if (rawType === Buffer || rawType === SchemaTypes.Buffer || rawType === "Buffer") {
    return "Buffer";
  }
  if (
    rawType === ObjectId ||
    rawType === SchemaTypes.ObjectId ||
    rawType === "ObjectId"
  ) {
    return "ObjectId";
  }
  if (rawType === Map || rawType === SchemaTypes.Map || rawType === "Map") {
    return "Map";
  }
  if (rawType === BigInt || rawType === SchemaTypes.BigInt || rawType === "BigInt") {
    return "BigInt";
  }
  if (Array.isArray(rawType) || rawType === Array || rawType === SchemaTypes.Array) {
    return "Array";
  }
  if (typeof rawType === "function" && typeof (rawType as any).schemaName === "string") {
    return (rawType as any).schemaName;
  }
  return "Mixed";
}

export class MongooseSchema<TClass = any>
  extends EventEmitter
  implements MongooseSchemaLike<TClass>
{
  static readonly Types = SchemaTypes;

  obj: Record<string, any> = {};
  paths: Record<string, MongooseSchemaType<any>> = {};
  options: SchemaOptions;
  methods: Record<string, (this: any, ...args: any[]) => unknown> = {};
  statics: Record<string, (this: any, ...args: any[]) => unknown> = {};
  query: Record<string, (this: any, ...args: any[]) => any> = {};
  virtuals: Record<string, MongooseVirtualType<TClass>> = {};
  discriminators?: Record<string, MongooseSchema<any>>;
  childSchemas: Array<{ schema: MongooseSchema<any>; model: any }> = [];

  readonly preHooks: RegisteredHook[] = [];
  readonly postHooks: RegisteredHook[] = [];
  private readonly indexList: Array<[IndexDefinition, IndexOptions]> = [];
  private readonly searchIndexes: SearchIndexDescription[] = [];
  private readonly callQueue: Array<[string, any[]]> = [];

  constructor(definition: Record<string, any> = {}, options: SchemaOptions = {}) {
    super();
    this.options = {
      id: true,
      versionKey: "__v",
      discriminatorKey: "__t",
      strict: true,
      timestamps: false,
      ...options,
    };

    if (options.methods) {
      Object.assign(this.methods, options.methods);
    }
    if (options.statics) {
      Object.assign(this.statics, options.statics);
    }
    if (options.query) {
      Object.assign(this.query, options.query);
    }

    this.add(definition);

    // Ensure `_id` path exists unless explicitly disabled
    if (!this.paths._id && this.obj._id !== false) {
      this.paths._id = new MongooseSchemaType("_id", { auto: true }, "ObjectId");
    }

    // Default `id` virtual getter unless `id: false`
    if (this.options.id !== false && !this.virtuals.id) {
      this.virtual("id").get(function (this: any) {
        if (this?._id === undefined || this?._id === null) {
          return undefined;
        }
        return typeof this._id.toHexString === "function"
          ? this._id.toHexString()
          : String(this._id);
      });
    }

    // Register options.virtuals if provided
    if (options.virtuals) {
      for (const [vName, vOpts] of Object.entries(options.virtuals)) {
        this.virtual(vName, vOpts);
      }
    }
  }

  add(obj: Record<string, any> | MongooseSchemaLike<any>, prefix = ""): this {
    if (!obj || typeof obj !== "object") {
      return this;
    }
    const source = obj instanceof MongooseSchema ? obj.obj : obj;
    const typeKey = this.options.typeKey ?? "type";

    for (const [key, rawVal] of Object.entries(source)) {
      const fullPath = prefix ? `${prefix}${key}` : key;
      if (!prefix) {
        this.obj[key] = rawVal;
      }

      if (rawVal instanceof MongooseSchema) {
        this.childSchemas.push({ schema: rawVal, model: null });
        this.paths[fullPath] = new MongooseSchemaType(
          fullPath,
          { schema: rawVal },
          "Embedded",
        );
        this.add(rawVal.obj, `${fullPath}.`);
        continue;
      }

      if (rawVal instanceof MongooseSchemaType) {
        this.paths[fullPath] = rawVal;
        continue;
      }

      if (Array.isArray(rawVal)) {
        const st = new MongooseSchemaType(fullPath, { type: rawVal }, "Array");
        if (rawVal.length > 0) {
          const itemDef = rawVal[0];
          if (itemDef instanceof MongooseSchema) {
            this.childSchemas.push({ schema: itemDef, model: null });
            st.setEmbeddedSchemaType(
              new MongooseSchemaType(fullPath, { schema: itemDef }, "Embedded"),
            );
          } else if (isPlainObject(itemDef) && typeKey in itemDef) {
            st.setEmbeddedSchemaType(
              new MongooseSchemaType(
                fullPath,
                itemDef,
                inferSchemaTypeInstance(itemDef[typeKey]),
              ),
            );
          } else {
            st.setEmbeddedSchemaType(
              new MongooseSchemaType(
                fullPath,
                { type: itemDef },
                inferSchemaTypeInstance(itemDef),
              ),
            );
          }
        }
        this.paths[fullPath] = st;
        continue;
      }

      if (typeof rawVal === "function") {
        this.paths[fullPath] = new MongooseSchemaType(
          fullPath,
          { type: rawVal },
          inferSchemaTypeInstance(rawVal),
        );
        continue;
      }

      if (isPlainObject(rawVal)) {
        const isRawObj = Boolean((rawVal as any)[RAW_OBJECT_DEFINITION]);
        if (!isRawObj && typeKey in rawVal && typeof rawVal[typeKey] !== "object") {
          const st = new MongooseSchemaType(
            fullPath,
            rawVal,
            inferSchemaTypeInstance(rawVal[typeKey]),
          );
          if (rawVal.index || rawVal.unique) {
            const idxOpts: IndexOptions =
              typeof rawVal.index === "object" ? { ...rawVal.index } : {};
            if (rawVal.unique) idxOpts.unique = true;
            if (rawVal.sparse) idxOpts.sparse = true;
            this.indexList.push([{ [fullPath]: 1 }, idxOpts]);
          }
          this.paths[fullPath] = st;
          continue;
        }
        if (!isRawObj && typeKey in rawVal && Array.isArray(rawVal[typeKey])) {
          const st = new MongooseSchemaType(fullPath, rawVal, "Array");
          const first = rawVal[typeKey][0];
          if (first !== undefined) {
            const innerType =
              isPlainObject(first) && typeKey in first ? first[typeKey] : first;
            st.setEmbeddedSchemaType(
              new MongooseSchemaType(
                fullPath,
                isPlainObject(first) ? first : { type: first },
                inferSchemaTypeInstance(innerType),
              ),
            );
          }
          this.paths[fullPath] = st;
          continue;
        }
        if (!isRawObj && typeKey in rawVal && rawVal[typeKey] instanceof MongooseSchema) {
          const sub = rawVal[typeKey] as MongooseSchema<any>;
          this.childSchemas.push({ schema: sub, model: null });
          this.paths[fullPath] = new MongooseSchemaType(
            fullPath,
            { ...rawVal, schema: sub },
            "Embedded",
          );
          this.add(sub.obj, `${fullPath}.`);
          continue;
        }
        // Nested object definition (e.g. `raw({ firstName: String, lastName: String })` or nested class definition)
        this.paths[fullPath] = new MongooseSchemaType(fullPath, { type: rawVal }, "Mixed");
        this.add(rawVal, `${fullPath}.`);
        continue;
      }

      this.paths[fullPath] = new MongooseSchemaType(fullPath, { type: rawVal }, "Mixed");
    }

    return this;
  }

  remove(paths: string | string[]): this {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const p of list) {
      delete this.paths[p];
      delete this.obj[p];
    }
    return this;
  }

  eachPath(fn: (path: string, type: MongooseSchemaType<any>) => void): this {
    for (const [path, st] of Object.entries(this.paths)) {
      fn(path, st);
    }
    return this;
  }

  path(path: string, obj?: any): any {
    if (obj === undefined) {
      return this.paths[path];
    }
    this.add({ [path]: obj });
    return this;
  }

  pathType(path: string): string {
    if (path in this.paths) return "real";
    if (path in this.virtuals) return "virtual";
    const prefix = `${path}.`;
    if (Object.keys(this.paths).some((k) => k.startsWith(prefix))) {
      return "nested";
    }
    return "adhocOrUndefined";
  }

  requiredPaths(): string[] {
    return Object.entries(this.paths)
      .filter(([, st]) => Boolean(st.isRequired))
      .map(([p]) => p);
  }

  virtual(
    name: string,
    options?: VirtualTypeOptions<TClass>,
  ): MongooseVirtualType<TClass> {
    if (this.virtuals[name] && !options) {
      return this.virtuals[name]!;
    }
    const v = new MongooseVirtualType<TClass>(name, options);
    this.virtuals[name] = v;
    return v;
  }

  virtualpath(name: string): MongooseVirtualType<TClass> | undefined {
    return this.virtuals[name];
  }

  index(fields: IndexDefinition, options: IndexOptions = {}): this {
    this.indexList.push([fields, options]);
    return this;
  }

  indexes(): Array<[IndexDefinition, IndexOptions]> {
    return this.indexList.map(([fields, opts]) => [{ ...fields }, { ...opts }]);
  }

  clearIndexes(): this {
    this.indexList.length = 0;
    return this;
  }

  removeIndex(index: string | AnyObject): this {
    for (let i = this.indexList.length - 1; i >= 0; i--) {
      const [fields, opts] = this.indexList[i]!;
      if (typeof index === "string" && opts.name === index) {
        this.indexList.splice(i, 1);
      } else if (
        typeof index === "object" &&
        JSON.stringify(fields) === JSON.stringify(index)
      ) {
        this.indexList.splice(i, 1);
      }
    }
    return this;
  }

  searchIndex(description: SearchIndexDescription): this {
    this.searchIndexes.push(description);
    return this;
  }

  method(
    nameOrObj: string | Record<string, (this: any, ...args: any[]) => unknown>,
    fn?: (this: any, ...args: any[]) => unknown,
  ): this {
    if (typeof nameOrObj === "string" && fn) {
      this.methods[nameOrObj] = fn;
    } else if (typeof nameOrObj === "object") {
      Object.assign(this.methods, nameOrObj);
    }
    return this;
  }

  static(
    nameOrObj: string | Record<string, (this: any, ...args: any[]) => unknown>,
    fn?: (this: any, ...args: any[]) => unknown,
  ): this {
    if (typeof nameOrObj === "string" && fn) {
      this.statics[nameOrObj] = fn;
    } else if (typeof nameOrObj === "object") {
      Object.assign(this.statics, nameOrObj);
    }
    return this;
  }

  queryHelper(name: string, fn: (this: any, ...args: any[]) => any): this {
    this.query[name] = fn;
    return this;
  }

  pre(
    method: HookMethod | HookMethod[] | RegExp,
    optionsOrFn: MiddlewareOptions | ((this: any, ...args: any[]) => any),
    fn?: (this: any, ...args: any[]) => any,
  ): this {
    const methods = Array.isArray(method) ? method : [method];
    const options: MiddlewareOptions =
      typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const callback = typeof optionsOrFn === "function" ? optionsOrFn : fn;
    if (typeof callback === "function") {
      for (const m of methods) {
        this.preHooks.push({ method: m, options, fn: callback });
      }
    }
    return this;
  }

  post(
    method: HookMethod | HookMethod[] | RegExp,
    optionsOrFn: MiddlewareOptions | ((this: any, ...args: any[]) => any),
    fn?: (this: any, ...args: any[]) => any,
  ): this {
    const methods = Array.isArray(method) ? method : [method];
    const options: MiddlewareOptions =
      typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const callback = typeof optionsOrFn === "function" ? optionsOrFn : fn;
    if (typeof callback === "function") {
      for (const m of methods) {
        this.postHooks.push({ method: m, options, fn: callback });
      }
    }
    return this;
  }

  plugin<POptions = any>(
    fn: PluginFunction<TClass, POptions>,
    opts?: POptions,
  ): this {
    fn(this, opts);
    return this;
  }

  loadClass(model: Function, onlyVirtuals = false): this {
    const proto = model.prototype;
    if (proto) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc) continue;
        if (desc.get || desc.set) {
          const v = this.virtual(name);
          if (desc.get) v.get(desc.get);
          if (desc.set) v.set(desc.set);
        } else if (!onlyVirtuals && typeof desc.value === "function") {
          this.methods[name] = desc.value;
        }
      }
    }
    if (!onlyVirtuals) {
      for (const name of Object.getOwnPropertyNames(model)) {
        if (name === "prototype" || name === "length" || name === "name") {
          continue;
        }
        const desc = Object.getOwnPropertyDescriptor(model, name);
        if (desc && typeof desc.value === "function") {
          this.statics[name] = desc.value;
        }
      }
    }
    return this;
  }

  clone(): MongooseSchema<TClass> {
    const cloned = new MongooseSchema<TClass>({ ...this.obj }, { ...this.options });
    Object.assign(cloned.methods, this.methods);
    Object.assign(cloned.statics, this.statics);
    Object.assign(cloned.query, this.query);
    for (const [k, v] of Object.entries(this.virtuals)) {
      const nv = cloned.virtual(k, { ...v.options });
      for (const g of v.getters) nv.get(g);
      for (const s of v.setters) nv.set(s);
    }
    for (const h of this.preHooks) cloned.preHooks.push({ ...h });
    for (const h of this.postHooks) cloned.postHooks.push({ ...h });
    for (const [f, o] of this.indexList) cloned.index({ ...f }, { ...o });
    return cloned;
  }

  pick(paths: string[], options?: SchemaOptions): MongooseSchema<any> {
    const subObj: Record<string, any> = {};
    for (const p of paths) {
      if (p in this.obj) {
        subObj[p] = this.obj[p];
      }
    }
    return new MongooseSchema(subObj, options ?? { ...this.options });
  }

  omit(paths: string[], options?: SchemaOptions): MongooseSchema<any> {
    const excluded = new Set(paths);
    const subObj: Record<string, any> = {};
    for (const [k, v] of Object.entries(this.obj)) {
      if (!excluded.has(k)) {
        subObj[k] = v;
      }
    }
    return new MongooseSchema(subObj, options ?? { ...this.options });
  }

  discriminator<DisSchema = MongooseSchemaLike<any>>(
    name: string,
    schema: DisSchema,
    _value?: string,
  ): this {
    if (!this.discriminators) {
      this.discriminators = {};
    }
    this.discriminators[name] = schema as unknown as MongooseSchema<any>;
    return this;
  }

  queue(name: string, args: any[]): this {
    this.callQueue.push([name, args]);
    return this;
  }
}
