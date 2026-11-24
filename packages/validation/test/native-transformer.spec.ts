import "@bunest/core";
import { describe, expect, it } from "bun:test";
import * as upstreamCT from "class-transformer";
import * as nativeCT from "../src/transformer";
import {
  ClassTransformer,
  Exclude,
  Expose,
  Transform,
  TransformInstanceToInstance,
  TransformInstanceToPlain,
  TransformPlainToInstance,
  TransformationType,
  Type,
  classToClassFromExist,
  classToPlain,
  classToPlainFromExist,
  defaultMetadataStorage,
  deserialize,
  deserializeArray,
  getMetadataStorage,
  instanceToInstance,
  instanceToPlain,
  plainToClass,
  plainToClassFromExist,
  plainToInstance,
  serialize,
} from "../src/transformer";

describe("@bunest/validation/transformer (Zero-Dep Bun-Native Engine)", () => {
  it("exports 100% of upstream class-transformer runtime API plus storage helpers", () => {
    const missing = Object.keys(upstreamCT).filter(
      (k) => k !== "default" && !(k in nativeCT),
    );
    expect(missing).toEqual([]);
    expect(getMetadataStorage()).toBe(defaultMetadataStorage);
    expect(
      (globalThis as Record<PropertyKey, unknown>)[
        Symbol.for("bunest:class-transformer:storage")
      ],
    ).toBe(defaultMetadataStorage);
    expect(new ClassTransformer()).toBeInstanceOf(ClassTransformer);
  });

  it("handles @Expose renaming, @Exclude, getters, groups, versions, and @Transform stacking", () => {
    @Exclude()
    class UserModel {
      @Expose()
      id!: number;

      @Expose({ name: "first_name" })
      @Transform(({ value }) =>
        typeof value === "string" ? value.trim() : value,
      )
      @Transform(({ value }) =>
        typeof value === "string" ? value.toUpperCase() : value,
      )
      firstName!: string;

      @Expose({ groups: ["admin"] })
      role!: string;

      @Expose({ since: 2, until: 4 })
      v2Field!: string;

      secret = "hidden";

      @Expose()
      get displayLabel(): string {
        return `#${this.id}:${this.firstName}`;
      }
    }

    const inst = plainToInstance(
      UserModel,
      {
        id: 7,
        first_name: "  ada  ",
        role: "superadmin",
        v2Field: "hello",
        secret: "leak",
        extra: "ignored",
      },
      { groups: ["admin"], version: 2 },
    );

    expect(inst).toBeInstanceOf(UserModel);
    expect(inst.id).toBe(7);
    expect(inst.firstName).toBe("ADA");
    expect(inst.role).toBe("superadmin");
    expect(inst.v2Field).toBe("hello");
    expect((inst as any).extra).toBeUndefined();

    // Serialize without admin group & version 5 (outside [2, 4))
    const plainPublic = instanceToPlain(inst, { version: 5 });
    expect(plainPublic).toEqual({
      id: 7,
      first_name: "ADA",
      displayLabel: "#7:ADA",
    });

    // Serialize with admin group & version 3
    const plainAdmin = classToPlain(inst, { groups: ["admin"], version: 3 });
    expect(plainAdmin).toEqual({
      id: 7,
      first_name: "ADA",
      role: "superadmin",
      v2Field: "hello",
      displayLabel: "#7:ADA",
    });
  });

  it("supports @Type() nested classes, arrays, and polymorphic discriminators", () => {
    abstract class Shape {
      kind!: string;
    }
    class Circle extends Shape {
      radius!: number;
    }
    class Square extends Shape {
      side!: number;
    }
    class Canvas {
      @Type(() => Shape, {
        discriminator: {
          property: "kind",
          subTypes: [
            { value: Circle, name: "circle" },
            { value: Square, name: "square" },
          ],
        },
        keepDiscriminatorProperty: false,
      })
      shapes!: Shape[];
    }

    const canvas = plainToInstance(Canvas, {
      shapes: [
        { kind: "circle", radius: 10 },
        { kind: "square", side: 5 },
      ],
    });
    expect(canvas).toBeInstanceOf(Canvas);
    expect(canvas.shapes[0]).toBeInstanceOf(Circle);
    expect((canvas.shapes[0] as Circle).radius).toBe(10);
    expect((canvas.shapes[0] as any).kind).toBeUndefined();
    expect(canvas.shapes[1]).toBeInstanceOf(Square);
    expect((canvas.shapes[1] as Square).side).toBe(5);
  });

  it("enforces ADR-015 safe enableImplicitConversion (never Boolean('false')===true or Number('')===0)", () => {
    class QueryDto {
      @Type(() => Boolean)
      active!: unknown;

      @Type(() => Boolean)
      invalidBool!: unknown;

      @Type(() => Number)
      page!: unknown;

      @Type(() => Number)
      emptyNum!: unknown;

      @Type(() => Date)
      since!: unknown;
    }

    const dto = plainToInstance(
      QueryDto,
      {
        active: "false",
        invalidBool: "maybe",
        page: "42",
        emptyNum: "",
        since: "2026-11-22T00:00:00.000Z",
      },
      { enableImplicitConversion: true },
    );

    expect(dto.active).toBe(false);
    expect(dto.invalidBool).toBe("maybe"); // untouched so @IsBoolean() rejects it
    expect(dto.page).toBe(42);
    expect(dto.emptyNum).toBe(""); // untouched so @IsNumber() rejects it
    expect(dto.since).toBeInstanceOf(Date);
    expect((dto.since as Date).toISOString()).toBe("2026-11-22T00:00:00.000Z");
  });

  it("is immune to prototype pollution and preserves Web/Bun built-ins", () => {
    class BuiltinHolder {
      createdAt!: Date;
      pattern!: RegExp;
      endpoint!: URL;
      bytes!: Uint8Array;
      tags!: Set<string>;
      meta!: Map<string, number>;
    }

    const poisoned = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"x":1},"createdAt":"2026-01-01T00:00:00.000Z"}',
    );
    const transformed = plainToInstance(BuiltinHolder, poisoned);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.hasOwn(transformed, "__proto__")).toBe(false);
    expect(Object.hasOwn(transformed, "constructor")).toBe(false);
    expect(Object.hasOwn(transformed, "prototype")).toBe(false);

    const src = new BuiltinHolder();
    src.createdAt = new Date("2026-06-01T00:00:00.000Z");
    src.pattern = /bunest/gi;
    src.endpoint = new URL("https://bunest.dev/docs");
    src.bytes = new Uint8Array([1, 2, 3]);
    src.tags = new Set(["a", "b"]);
    src.meta = new Map([["k", 9]]);

    const cloned = instanceToInstance(src);
    expect(cloned).toBeInstanceOf(BuiltinHolder);
    expect(cloned.createdAt).toBeInstanceOf(Date);
    expect(cloned.createdAt).not.toBe(src.createdAt);
    expect(cloned.pattern).toBeInstanceOf(RegExp);
    expect(cloned.endpoint).toBeInstanceOf(URL);
    expect(cloned.bytes).toBeInstanceOf(Uint8Array);
    expect(cloned.tags).toBeInstanceOf(Set);
    expect(cloned.meta).toBeInstanceOf(Map);
  });

  it("supports FromExist, serialize/deserialize, circular check, method decorators, and cloneClassMetadata", async () => {
    class Item {
      @Expose()
      name!: string;

      @Exclude({ toPlainOnly: true })
      internal = "x";

      parent?: Item;
    }

    const existing = new Item();
    existing.internal = "keep";
    plainToClassFromExist(existing, { name: "widget" });
    expect(existing.name).toBe("widget");
    expect(existing.internal).toBe("keep");

    const plainTarget: Record<string, any> = { pre: 1 };
    classToPlainFromExist(existing, plainTarget);
    expect(plainTarget).toEqual({ pre: 1, name: "widget" });

    const clonedInto = new Item();
    classToClassFromExist(existing, clonedInto);
    expect(clonedInto.name).toBe("widget");

    const json = serialize(existing);
    const back = deserialize(Item, json);
    expect(back).toBeInstanceOf(Item);
    expect(back.name).toBe("widget");

    const arrBack = deserializeArray(Item, JSON.stringify([{ name: "a" }, { name: "b" }]));
    expect(arrBack).toHaveLength(2);
    expect(arrBack[1]).toBeInstanceOf(Item);

    // Circular reference check (exact upstream class-transformer@0.5.1 parity:
    // instanceToPlain omits back-edge so JSON.stringify succeeds; instanceToInstance handles cycle)
    const node = new Item();
    node.name = "loop";
    node.parent = node;
    const plainLoop = instanceToPlain(node, { enableCircularCheck: true });
    expect(plainLoop).toEqual({ name: "loop" });
    expect(() => JSON.stringify(plainLoop)).not.toThrow();
    const clonedLoop = instanceToInstance(node, { enableCircularCheck: true });
    expect(clonedLoop).toBeInstanceOf(Item);
    expect(clonedLoop.name).toBe("loop");
    expect(clonedLoop.parent).toBeDefined();

    // Method decorators (sync + async)
    class Service {
      @TransformPlainToInstance(Item)
      getSync(): any {
        return { name: "from-sync" };
      }

      @TransformInstanceToPlain()
      async getAsyncPlain(): Promise<Item> {
        return plainToClass(Item, { name: "from-async", internal: "secret" });
      }

      @TransformInstanceToInstance()
      cloneItem(item: Item): Item {
        return item;
      }
    }

    const svc = new Service();
    const sRes = svc.getSync();
    expect(sRes).toBeInstanceOf(Item);
    expect((await svc.getAsyncPlain()) as unknown).toEqual({
      name: "from-async",
    });
    const cRes = svc.cloneItem(existing);
    expect(cRes).toBeInstanceOf(Item);
    expect(cRes).not.toBe(existing);

    // TransformationType enum values match upstream
    expect(TransformationType.PLAIN_TO_CLASS).toBe(0);
    expect(TransformationType.CLASS_TO_PLAIN).toBe(1);
    expect(TransformationType.CLASS_TO_CLASS).toBe(2);

    // cloneClassMetadata
    class DerivedItem {}
    const clonedKeys = defaultMetadataStorage.cloneClassMetadata(
      Item,
      DerivedItem,
      (k) => k === "name",
    );
    expect(clonedKeys).toEqual(["name"]);
    expect(defaultMetadataStorage.hasMetadataFor(DerivedItem)).toBe(true);
  });
});
