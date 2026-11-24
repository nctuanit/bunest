import { afterEach, describe, expect, it } from "bun:test";
import {
  Accessors,
  Builder,
  CUSTOM_MACROS_REGISTRY_SYMBOL,
  Data,
  EqualsAndHashCode,
  FieldNameConstants,
  GLOBAL_MACRO_DEFAULTS_SYMBOL,
  Getter,
  JsonSerializable,
  Logger,
  METADATA_KEYS,
  MetadataRegistry,
  Secret,
  Setter,
  SuperBuilder,
  ToString,
  UtilityClass,
  Value,
  With,
  WithBy,
  WithLogger,
  clearCustomMacros,
  collectCustomMacroDelombokBlocks,
  collectCustomMacroTypegenMembers,
  defineBunestConfig,
  defineClassMacro,
  defineMacroPreset,
  getCustomMacro,
  getGlobalMacroDefaults,
  listCustomMacros,
  registerCustomMacro,
  registerMacroFields,
  resetGlobalMacroDefaults,
  resolveGlobalToStringDefaults,
  setGlobalMacroDefaults,
  unregisterCustomMacro,
  type ClassMacroConfig,
  type CustomMacroDefinition,
} from "../../src/common";

describe("Customizable Class Macros, Global Defaults & BunestConfig (@bunest/core)", () => {
  afterEach(() => {
    resetGlobalMacroDefaults();
    clearCustomMacros();
  });

  // ==========================================================================
  // 1. defineClassMacro & Global Registry
  // ==========================================================================

  describe("defineClassMacro & global registry", () => {
    it("registers on Symbol.for('bunest:custom_macros:registry') and exposes registry CRUD helpers", () => {
      const Auditable = defineClassMacro({
        name: "Auditable",
        fields: [
          { name: "createdAt", type: "Date", defaultValue: () => new Date() },
        ],
      });

      expect(Auditable.macroName).toBe("Auditable");
      expect(Auditable.macroDefinition.name).toBe("Auditable");
      expect(getCustomMacro("Auditable")).toBe(Auditable.macroDefinition);
      expect(listCustomMacros().map((m) => m.name)).toEqual(["Auditable"]);

      const rawRegistry = (
        globalThis as Record<
          symbol,
          Map<string, CustomMacroDefinition<any>> | undefined
        >
      )[CUSTOM_MACROS_REGISTRY_SYMBOL];
      expect(rawRegistry).toBeInstanceOf(Map);
      expect(rawRegistry?.get("Auditable")).toBe(Auditable.macroDefinition);
      expect(CUSTOM_MACROS_REGISTRY_SYMBOL).toBe(
        Symbol.for("bunest:custom_macros:registry"),
      );

      registerCustomMacro({ name: "ManualMacro" });
      expect(listCustomMacros().map((m) => m.name)).toEqual([
        "Auditable",
        "ManualMacro",
      ]);

      expect(unregisterCustomMacro("ManualMacro")).toBe(true);
      expect(unregisterCustomMacro("NonExistent")).toBe(false);
      expect(getCustomMacro("ManualMacro")).toBeUndefined();

      expect(() => registerCustomMacro({ name: "   " })).toThrow(TypeError);
    });

    it("injects fields with defaults (without breaking plain `new`), methods, statics, and respects @Tolerate", () => {
      let seq = 0;

      const Auditable = defineClassMacro<{ prefix?: string }>({
        name: "Auditable",
        fields: [
          {
            name: "auditId",
            type: "string",
            readonly: true,
            defaultValue: () => `aud_${++seq}`,
          },
          {
            name: "version",
            type: "number",
            defaultValue: 1,
          },
          {
            name: "updatedBy",
            type: "string",
            optional: true,
          },
        ],
        methods: {
          touch: {
            signature: "(by?: string): this",
            impl(self, by?: string) {
              self.version = (self.version ?? 0) + 1;
              if (by !== undefined) self.updatedBy = by;
              return self;
            },
            delombokBody:
              "this.version = (this.version ?? 0) + 1;\nreturn this;",
          },
          summary: {
            signature: "(): string",
            impl(self) {
              return `macro:${self.auditId}`;
            },
          },
        },
        statics: {
          auditFields: {
            signature: "(): readonly string[]",
            impl() {
              return ["auditId", "version", "updatedBy"];
            },
            delombokBody: 'return ["auditId", "version", "updatedBy"];',
          },
          customStatic: {
            signature: "(): string",
            impl() {
              return "from-macro";
            },
          },
        },
      });

      @Auditable({ prefix: "inv" })
      class Invoice {
        amount = 100;

        // User-defined method must NEVER be overwritten (@Tolerate)
        summary(): string {
          return `user:${this.amount}`;
        }

        // User-defined static must NEVER be overwritten (@Tolerate)
        static customStatic(): string {
          return "from-user";
        }
      }

      const i1 = new Invoice() as any;
      const i2 = new Invoice() as any;

      expect(i1).toBeInstanceOf(Invoice);
      expect(i1.amount).toBe(100);
      expect(i1.auditId).toBe("aud_1");
      expect(i1.auditId).toBe("aud_1"); // memoized own property on instance
      expect(i2.auditId).toBe("aud_2"); // distinct factory invocation per instance
      expect(i1.version).toBe(1);

      // readonly field throws on mutation after initialization
      expect(() => {
        i1.auditId = "mutated";
      }).toThrow();

      // Method works and mutates writable default field
      expect(i1.touch("alice")).toBe(i1);
      expect(i1.version).toBe(2);
      expect(i1.updatedBy).toBe("alice");

      // Statics & @Tolerate
      expect((Invoice as any).auditFields()).toEqual([
        "auditId",
        "version",
        "updatedBy",
      ]);
      expect(i1.summary()).toBe("user:100");
      expect(Invoice.customStatic()).toBe("from-user");
    });

    it("integrates custom macro fields seamlessly with @Data, @Value, of(), with(), toJSON(), and toString()", () => {
      let tick = 1000;
      const Timestamped = defineClassMacro({
        name: "Timestamped",
        fields: [
          {
            name: "createdAt",
            type: "number",
            readonly: true,
            defaultValue: () => ++tick,
          },
          {
            name: "revision",
            type: "number",
            defaultValue: 0,
          },
        ],
      });

      @Timestamped()
      @Data()
      class Order {
        code!: string;
      }

      const o1 = (Order as any).of({ code: "ORD-1" });
      expect(o1.code).toBe("ORD-1");
      expect(o1.createdAt).toBe(1001);
      expect(o1.revision).toBe(0);
      expect(o1.getCreatedAt()).toBe(1001);
      expect(o1.getRevision()).toBe(0);
      expect(o1.toJSON()).toEqual({
        code: "ORD-1",
        createdAt: 1001,
        revision: 0,
      });
      expect(o1.toString()).toContain("createdAt=1001");

      // Explicit prop overrides defaultValue without wasting factory
      const o2 = (Order as any).of({ code: "ORD-2", createdAt: 500 });
      expect(o2.createdAt).toBe(500);
      expect(tick).toBe(1001);

      // Immutable with() can even produce a new copy with patched readonly field
      const o3 = o2.with({ createdAt: 777, revision: 3 });
      expect(o3.createdAt).toBe(777);
      expect(o3.revision).toBe(3);
      expect(o2.createdAt).toBe(500);

      // Combined with frozen @Value()
      @Timestamped()
      @Value()
      class FrozenEvent {
        kind!: string;
      }

      const ev = (FrozenEvent as any).of({ kind: "PAID" });
      expect(Object.isFrozen(ev)).toBe(true);
      expect(ev.createdAt).toBe(1002);
      expect(ev.revision).toBe(0);
      expect(ev.getCreatedAt()).toBe(1002);
    });

    it("executes apply(ctx) with target, options, fields, and global defaults, and supports typegen + delombok hooks", () => {
      setGlobalMacroDefaults({ toString: { maskValue: "[MASK]" } });

      const captured: Array<{
        targetName: string;
        tag: string;
        fields: readonly string[];
        maskValue: string | undefined;
      }> = [];

      const Tagged = defineClassMacro<{ tag: string; includeDebug?: boolean }>({
        name: "Tagged",
        fields: [{ name: "tag", type: "string", defaultValue: "default" }],
        methods: {
          debugTag: {
            signature: "(): string",
            when: (opts) => opts?.includeDebug === true,
            impl(self) {
              return `debug:${self.tag}`;
            },
            delombokBody: "return `debug:${this.tag}`;",
          },
        },
        apply(ctx) {
          captured.push({
            targetName: ctx.target.name,
            tag: ctx.options.tag,
            fields: ctx.fields,
            maskValue: resolveGlobalToStringDefaults(ctx.defaults)?.maskValue,
          });
          Object.defineProperty(ctx.target, "__tag__", {
            value: ctx.options.tag,
            enumerable: false,
            configurable: true,
          });
        },
        typegen(ctx) {
          return [
            {
              kind: "static",
              name: "TAG",
              signature: `static readonly TAG: ${JSON.stringify(ctx.options.tag)}`,
            },
            {
              kind: "builder",
              name: "tag",
              signature: `tag(value: string): this`,
            },
          ];
        },
        delombok(ctx) {
          const indent = ctx.indent ?? "  ";
          return [
            `${indent}static readonly TAG = ${JSON.stringify(ctx.options.tag)};`,
          ];
        },
      });

      @Tagged({ tag: "billing", includeDebug: true })
      class BillingItem {
        sku = "SKU-1";
      }

      expect((BillingItem as any).__tag__).toBe("billing");
      expect(captured).toHaveLength(1);
      expect(captured[0]!.targetName).toBe("BillingItem");
      expect(captured[0]!.tag).toBe("billing");
      expect(captured[0]!.fields).toContain("sku");
      expect(captured[0]!.fields).toContain("tag");
      expect(captured[0]!.maskValue).toBe("[MASK]");
      expect((new BillingItem() as any).debugTag()).toBe("debug:default");

      // Single-source typegen member collector
      const generatedMembers = collectCustomMacroTypegenMembers(
        Tagged.macroDefinition,
        {
          className: "BillingItem",
          options: { tag: "billing", includeDebug: true },
          fields: [{ name: "sku", typeText: "string" }],
        },
      );
      expect(generatedMembers).toEqual([
        {
          kind: "instance",
          name: "tag",
          signature: "tag: string",
          sourceDecorator: "@Tagged",
        },
        {
          kind: "instance",
          name: "debugTag",
          signature: "debugTag(): string",
          sourceDecorator: "@Tagged",
        },
        {
          kind: "static",
          name: "TAG",
          signature: 'static readonly TAG: "billing"',
          sourceDecorator: "@Tagged",
        },
        {
          kind: "builder",
          name: "tag",
          signature: "tag(value: string): this",
          sourceDecorator: "@Tagged",
        },
      ]);

      // `when` predicate filters out debugTag when includeDebug is false
      const withoutDebug = collectCustomMacroTypegenMembers(
        Tagged.macroDefinition,
        {
          className: "BillingItem",
          options: { tag: "billing", includeDebug: false },
          fields: [{ name: "sku", typeText: "string" }],
        },
      );
      expect(withoutDebug.some((m) => m.name === "debugTag")).toBe(false);

      // Single-source delombok block collector
      const blocks = collectCustomMacroDelombokBlocks(Tagged.macroDefinition, {
        className: "BillingItem",
        options: { tag: "billing", includeDebug: true },
        fields: [{ name: "sku", typeText: "string" }],
        indent: "  ",
      });
      expect(blocks).toEqual([
        '  tag: string = "default";',
        "  debugTag(): string {\n    return `debug:${this.tag}`;\n  }",
        '  static readonly TAG = "billing";',
      ]);
    });
  });

  // ==========================================================================
  // 2. defineMacroPreset
  // ==========================================================================

  describe("defineMacroPreset", () => {
    it("composes built-in macros with explicit and auto-inferred composedNames", () => {
      const DomainEntity = defineMacroPreset(
        "DomainEntity",
        [Data(), Builder({ toBuilder: true }), FieldNameConstants()],
        ["Data", "Builder", "FieldNameConstants"],
      );

      expect(DomainEntity.macroName).toBe("DomainEntity");
      expect(DomainEntity.macroDefinition.composedNames).toEqual([
        "Data",
        "Builder",
        "FieldNameConstants",
      ]);
      expect(getCustomMacro("DomainEntity")).toBe(DomainEntity.macroDefinition);

      // Auto-inferred composedNames when omitted for static array
      const AutoPreset = defineMacroPreset("AutoPreset", [
        Value(),
        WithBy(),
        WithLogger(),
      ]);
      expect(AutoPreset.macroDefinition.composedNames).toEqual([
        "Value",
        "WithBy",
        "WithLogger",
      ]);

      @DomainEntity()
      class Customer {
        id!: number;
        name!: string;
      }

      const c1 = (Customer as any).builder().id(1).name("Alice").build();
      expect(c1).toBeInstanceOf(Customer);
      expect(c1.getName()).toBe("Alice");
      expect(c1.toBuilder().name("Bob").build().name).toBe("Bob");
      expect((Customer as any).Fields.name).toBe("name");
    });

    it("supports parameterized preset factories and constructor-replacing macros", () => {
      const ApiDto = defineMacroPreset<{
        exclude?: string[];
        setterPrefix?: string;
      }>(
        "ApiDto",
        (opts) => [
          Data({ exclude: opts?.exclude }),
          Builder({ setterPrefix: opts?.setterPrefix }),
        ],
        ["Data", "Builder"],
      );

      @ApiDto({ exclude: ["internal"], setterPrefix: "set" })
      class ProductDto {
        sku!: string;
        internal!: string;
      }

      const dto = (ProductDto as any)
        .builder()
        .setSku("ABC")
        .setInternal("hidden")
        .build();
      expect(dto.sku).toBe("ABC");
      expect(dto.toString()).not.toContain("internal");

      const StaticOnly = defineMacroPreset("StaticOnly", [UtilityClass()]);

      @StaticOnly()
      class HelperBag {
        static ping(): string {
          return "pong";
        }
      }

      expect(HelperBag.ping()).toBe("pong");
      expect(() => new HelperBag()).toThrow(TypeError);
    });
  });

  // ==========================================================================
  // 3. registerMacroFields (Compile-Time AST Field Registration)
  // ==========================================================================

  describe("registerMacroFields", () => {
    it("enables zero-initializer classes for @Data, @Getter, @Setter, @Value, @With, @WithBy, @Builder, @FieldNameConstants when called AFTER decorators", () => {
      @Data()
      @Builder({ toBuilder: true })
      @FieldNameConstants({ uppercase: true })
      class User {
        id!: number;
        email!: string;
        firstName!: string;
      }
      registerMacroFields(User, ["id", "email", "firstName"]);

      // Plain `new` works with zero manual `fields: [...]`
      const u = new User() as any;
      u.setId(42).setEmail("tuan@bunest.dev").setFirstName("Tuan");
      expect(u.getId()).toBe(42);
      expect(u.getEmail()).toBe("tuan@bunest.dev");
      expect(u.getFirstName()).toBe("Tuan");

      const u2 = u.withFirstName("Alex");
      expect(u2.getFirstName()).toBe("Alex");
      expect(u.getFirstName()).toBe("Tuan");

      // @FieldNameConstants updated in-place with exact camelCase values for UPPER_SNAKE keys
      expect((User as any).Fields.FIRST_NAME).toBe("firstName");
      expect((User as any).Fields.EMAIL).toBe("email");
      expect(Object.keys((User as any).Fields)).toEqual([
        "ID",
        "EMAIL",
        "FIRST_NAME",
      ]);

      // @Builder toBuilder sees all registered fields
      const u3 = u.toBuilder().email("new@bunest.dev").build();
      expect(u3.getEmail()).toBe("new@bunest.dev");
      expect(u3.getFirstName()).toBe("Tuan");

      // Standalone @Getter + @Setter + @Accessors
      @Accessors({ fluent: true, prefix: "_" })
      @Getter()
      @Setter()
      class Profile {
        _displayName!: string;
      }
      registerMacroFields(Profile, ["_displayName"]);

      const p = new Profile() as any;
      expect(p.displayName("Bunest")).toBe(p);
      expect(p.displayName()).toBe("Bunest");

      // Standalone @Value + @WithBy
      @Value()
      @WithBy()
      class Price {
        amount!: number;
        currency!: string;
      }
      registerMacroFields(Price, ["amount", "currency"]);

      const rawPrice = new Price() as any;
      rawPrice.amount = 10;
      rawPrice.currency = "USD";
      expect(rawPrice.getAmount()).toBe(10);
      expect(rawPrice.setAmount).toBeUndefined();
      const doubled = rawPrice.withAmountBy((n: number) => n * 2);
      expect(doubled.getAmount()).toBe(20);
      expect(Object.isFrozen(doubled)).toBe(true);

      // Standalone @With
      @With()
      class Point {
        x!: number;
        y!: number;
      }
      registerMacroFields(Point, ["x", "y"]);
      const pt = new Point() as any;
      pt.x = 1;
      pt.y = 2;
      expect(pt.withX(9).x).toBe(9);
      expect(pt.withY(8).y).toBe(8);
    });

    it("works when called BEFORE decorators, across inheritance, and deduplicates safely", () => {
      class PreRegistered {
        alpha!: string;
        beta!: number;
      }
      registerMacroFields(PreRegistered, ["alpha", "beta", "alpha", ""]);
      Data()(PreRegistered);

      const cfg = MetadataRegistry.getOwn<ClassMacroConfig>(
        METADATA_KEYS.CLASS_MACROS,
        PreRegistered,
      );
      expect(cfg?.explicitFields).toEqual(["alpha", "beta"]);

      const inst = new PreRegistered() as any;
      inst.setAlpha("ok").setBeta(7);
      expect(inst.getAlpha()).toBe("ok");
      expect(inst.getBeta()).toBe(7);

      // Inheritance
      class BaseModel {
        id!: string;
      }
      registerMacroFields(BaseModel, ["id"]);

      @Data()
      class ChildModel extends BaseModel {
        title!: string;
      }
      registerMacroFields(ChildModel, ["title"]);

      const child = new ChildModel() as any;
      child.setId("b1").setTitle("hello");
      expect(child.getId()).toBe("b1");
      expect(child.getTitle()).toBe("hello");

      // Safe no-ops on empty input
      registerMacroFields(ChildModel, []);
      expect(child.getTitle()).toBe("hello");
    });
  });

  // ==========================================================================
  // 4. Global Macro Defaults & Per-Class Override Precedence
  // ==========================================================================

  describe("GlobalMacroDefaults & per-class override precedence", () => {
    it("stores defaults on Symbol.for('bunest:macro_defaults') and resets cleanly", () => {
      expect(GLOBAL_MACRO_DEFAULTS_SYMBOL).toBe(
        Symbol.for("bunest:macro_defaults"),
      );
      expect(getGlobalMacroDefaults()).toEqual({});

      setGlobalMacroDefaults({
        accessors: { fluent: true, chain: true },
        toString: { maskValue: "[REDACTED]" },
      });

      expect(getGlobalMacroDefaults()).toEqual({
        accessors: { fluent: true, chain: true },
        toString: { maskValue: "[REDACTED]" },
      });
      expect(
        (globalThis as Record<symbol, unknown>)[GLOBAL_MACRO_DEFAULTS_SYMBOL],
      ).toEqual(getGlobalMacroDefaults());

      resetGlobalMacroDefaults();
      expect(getGlobalMacroDefaults()).toEqual({});
    });

    it("applies global accessors, toString, equalsAndHashCode, data, and jsonSerializable defaults with per-class overrides", () => {
      setGlobalMacroDefaults({
        accessors: { fluent: true, chain: true, prefix: "_" },
        toString: { maskValue: "[REDACTED]", includeFieldNames: false },
        equalsAndHashCode: { deep: false, exclude: ["traceId"] },
        data: { mask: ["token"] },
        jsonSerializable: { exclude: ["internal"] },
      });

      @Data()
      class InheritedModel {
        _name = "alice";
        token = "top-secret";
        internal = "skip-json";
        traceId = "t1";
        meta: Record<string, number> = { a: 1 };
      }

      const a = new InheritedModel() as any;
      const b = new InheritedModel() as any;
      b.traceId = "t2";
      b.meta = a.meta; // same reference for shallow deep=false

      // Inherited fluent + prefix accessors
      expect(a.name()).toBe("alice");
      expect(a.name("bob")).toBe(a);
      expect(a.name()).toBe("bob");

      // Inherited toString maskValue + includeFieldNames: false + data.mask
      const str = a.toString();
      expect(str).toContain("[REDACTED]");
      expect(str).not.toContain("top-secret");
      expect(str).not.toContain("_name=");

      // Inherited equalsAndHashCode exclude + deep: false
      b._name = "bob";
      expect(a.equals(b)).toBe(true); // traceId excluded
      b.meta = { a: 1 }; // distinct object ref fails when deep: false
      expect(a.equals(b)).toBe(false);

      // Inherited jsonSerializable.exclude + data.mask
      const json = a.toJSON();
      expect(json.token).toBeUndefined();
      expect(json.internal).toBeUndefined();
      expect(json._name).toBe("bob");

      // Per-class overrides MUST win over global defaults
      @Accessors({ fluent: false, prefix: "" })
      @Data({
        mask: [],
        toStringOptions: { maskValue: "****", includeFieldNames: true },
        equalsAndHashCode: { deep: true, exclude: [] },
      })
      class OverriddenModel {
        _name = "alice";
        @Secret()
        secret = "pw";
        traceId = "t1";
        meta: Record<string, number> = { a: 1 };
      }

      const o1 = new OverriddenModel() as any;
      const o2 = new OverriddenModel() as any;
      o2.meta = { a: 1 }; // deep: true matches distinct ref
      expect(o1.get_name()).toBe("alice");
      expect(o1.toString()).toContain("_name=alice");
      expect(o1.toString()).toContain("secret=***"); // @Secret explicit default mask "***"
      expect(o1.equals(o2)).toBe(true);
      o2.traceId = "t2"; // exclude: [] includes traceId
      expect(o1.equals(o2)).toBe(false);
    });

    it("applies global defaults to @ToString, @EqualsAndHashCode, @Builder, @SuperBuilder, @Value, @JsonSerializable, @WithLogger, @FieldNameConstants", () => {
      setGlobalMacroDefaults({
        toString: { maskValue: "[HIDDEN]", mask: ["apiKey"] },
        equalsAndHashCode: { exclude: ["nonce"] },
        builder: {
          toBuilder: true,
          setterPrefix: "with",
          builderMethodName: "newBuilder",
          buildMethodName: "create",
        },
        value: { freeze: false },
        jsonSerializable: { omitSecrets: false },
        withLogger: { propertyName: "log", context: "AppDefault" },
        fieldNameConstants: { innerName: "COLS", uppercase: true },
      });

      @ToString()
      @EqualsAndHashCode()
      @JsonSerializable()
      class Standalone {
        id = 1;
        @Secret()
        apiKey = "xyz";
        nonce = 1;
      }

      const s1 = new Standalone() as any;
      const s2 = new Standalone() as any;
      s2.nonce = 999;
      expect(s1.toString()).toContain("apiKey=***");
      expect(s1.equals(s2)).toBe(true);
      expect(s1.toJSON().apiKey).toBe("xyz"); // omitSecrets: false inherited

      // Per-class @ToString override
      @ToString({ maskValue: "XXXX", mask: ["token"] })
      class MaskedOverride {
        token = "abc";
      }
      expect(new MaskedOverride().toString()).toBe("MaskedOverride(token=XXXX)");

      // @Builder inherits global builder defaults
      @Builder()
      class Built {
        name!: string;
      }
      const built = (Built as any).newBuilder().withName("hi").create();
      expect(built.name).toBe("hi");
      expect(built.toBuilder().withName("bye").create().name).toBe("bye");

      // @Builder per-class override wins
      @Builder({
        toBuilder: false,
        setterPrefix: "",
        builderMethodName: "builder",
        buildMethodName: "build",
      })
      class BuiltOverride {
        name!: string;
      }
      const bo = (BuiltOverride as any).builder().name("ok").build();
      expect(bo.name).toBe("ok");
      expect(bo.toBuilder).toBeUndefined();

      // @SuperBuilder inherits global builder defaults
      @SuperBuilder()
      class BaseBuilt {
        id!: number;
      }
      @SuperBuilder()
      class SubBuilt extends BaseBuilt {
        label!: string;
      }
      const sub = (SubBuilt as any)
        .newBuilder()
        .withId(5)
        .withLabel("sub")
        .create();
      expect(sub.id).toBe(5);
      expect(sub.label).toBe("sub");

      // @Value inherits freeze: false, overridden by freeze: true
      @Value()
      class UnfrozenVal {
        x!: number;
      }
      const uv = (UnfrozenVal as any).of({ x: 1 });
      expect(Object.isFrozen(uv)).toBe(false);

      @Value({ freeze: true })
      class FrozenVal {
        x!: number;
      }
      const fv = (FrozenVal as any).of({ x: 1 });
      expect(Object.isFrozen(fv)).toBe(true);

      // @WithLogger inherits propertyName: "log"
      @WithLogger()
      class LoggedA {}
      const la = new LoggedA() as any;
      expect(la.log).toBeInstanceOf(Logger);
      expect(la.logger).toBeUndefined();

      @WithLogger({ propertyName: "logger" })
      class LoggedB {}
      const lb = new LoggedB() as any;
      expect(lb.logger).toBeInstanceOf(Logger);

      // @FieldNameConstants inherits innerName: "COLS", uppercase: true
      @FieldNameConstants()
      class EntityCols {
        firstName = "a";
      }
      expect((EntityCols as any).COLS.FIRST_NAME).toBe("firstName");

      @FieldNameConstants({ innerName: "Fields", uppercase: false })
      class EntityColsOverride {
        firstName = "a";
      }
      expect((EntityColsOverride as any).Fields.firstName).toBe("firstName");
    });

    it("supports @Accessors({ fluent: false }) overriding global fluent: true cleanly on prototype", () => {
      setGlobalMacroDefaults({ accessors: { fluent: true } });

      @Accessors({ fluent: false })
      @Getter({ fields: ["title"] })
      @Setter({ fields: ["title"] })
      class Article {
        title!: string;
      }

      const art = new Article() as any;
      expect(typeof art.getTitle).toBe("function");
      expect(typeof art.setTitle).toBe("function");
      expect(art.title).toBeUndefined(); // old fluent prototype method was cleaned up!
      art.setTitle("Hello");
      expect(art.getTitle()).toBe("Hello");
    });
  });

  // ==========================================================================
  // 5. defineBunestConfig
  // ==========================================================================

  describe("defineBunestConfig", () => {
    it("strictly types and returns a complete unified bunest.config.ts configuration", () => {
      const Auditable = defineClassMacro({
        name: "ConfigAuditable",
        fields: [{ name: "createdAt", type: "Date" }],
      });

      const config = defineBunestConfig({
        macros: {
          defaults: {
            accessors: { fluent: false, chain: true },
            toString: { maskValue: "[MASKED]" },
            builder: { toBuilder: true },
          },
          presets: {
            DomainEntity: ["Data", "Builder", "FieldNameConstants"],
          },
          plugins: [Auditable.macroDefinition],
        },
        orm: {
          queryOperators: [
            {
              suffix: "Matches",
              arity: 1,
              description: "Full-text match operator",
              toSql: (ctx) => ({
                sql: `${ctx.quotedColumn} MATCH ${ctx.placeholder()}`,
                params: [ctx.args[0]],
              }),
            },
          ],
          defaultScopes: ["softDelete", "tenant"],
        },
        aop: {
          pointcuts: [
            {
              name: "service-audit",
              match: {
                className: /Service$/,
                excludeMethods: ["healthCheck"],
              },
              aspects: [],
            },
          ],
        },
        typegen: {
          enabled: true,
          outDir: ".bunest/types",
          fileName: "bunest.d.ts",
          include: ["routes", "macros", "i18n"],
          plugins: [
            {
              name: "custom-plugin",
              scan: () => ({ keys: ["hello"] }),
              emit: () => 'declare module "custom" {}',
            },
          ],
        },
        diagnostics: {
          presetRules: ["BUNEST_ARCH001", "BUNEST_ARCH002"],
          rules: [
            {
              code: "CUSTOM001",
              severity: "warning",
              description: "Custom rule",
              check: () => [],
            },
          ],
        },
        plugin: {
          classMacros: true,
          swaggerMetadata: true,
          ormCircularSafe: true,
          autoModuleManifest: true,
          transforms: [
            {
              name: "banner",
              filter: /\.ts$/,
              transform: (source) => source,
            },
          ],
        },
      });

      expect(config.macros?.presets?.DomainEntity).toEqual([
        "Data",
        "Builder",
        "FieldNameConstants",
      ]);
      expect(config.macros?.plugins).toHaveLength(1);
      expect(config.orm?.queryOperators?.[0]?.suffix).toBe("Matches");
      expect(config.orm?.defaultScopes).toEqual(["softDelete", "tenant"]);
      expect(config.aop?.pointcuts?.[0]?.name).toBe("service-audit");
      expect(config.typegen?.plugins?.[0]?.name).toBe("custom-plugin");
      expect(config.diagnostics?.rules?.[0]?.code).toBe("CUSTOM001");
      expect(config.plugin?.classMacros).toBe(true);
    });
  });
});
