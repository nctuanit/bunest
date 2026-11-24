import { describe, expect, it } from "bun:test";
import { ensureDir, join, removePath } from "@bunest/core";
import { bunestMetadataPlugin, transformDtoMetadataSource } from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const SWAGGER_API_PROPERTIES = Symbol.for("bunest:swagger:api_properties");
const GRAPHQL_FIELDS = Symbol.for("bunest:graphql:fields");

describe("bunestMetadataPlugin & transformDtoMetadataSource", () => {
  it("extracts primitives, optional/nullable/default, arrays, unions, enums, nested refs, and JSDoc while ignoring comments/strings/methods/type-only imports", () => {
    const source = `
import { AddressDto } from "./address.dto";
import type { GhostInterface } from "./ghost";

export enum OrderStatus {
  PENDING = "pending",
  PAID = "paid",
}

export type RoleName = "admin" | "member";

export interface InternalShape {
  secret: string;
}

/*
 * export class CommentedOutDto {
 *   fakeField!: string;
 * }
 */
const example = \`export class StringTemplateDto { nope!: number }\`;

export class CreateOrderDto {
  /** Customer email address */
  email!: string;

  /** Total amount in cents */
  amount!: number;

  active: boolean = true;

  createdAt!: Date;

  tags!: string[];

  nickname?: string | null;

  role!: RoleName;

  status!: OrderStatus;

  shippingAddress!: AddressDto;

  billingAddresses!: Array<AddressDto>;

  meta!: GhostInterface;

  shape!: InternalShape;

  @ApiHideProperty()
  internalSecret!: string;

  static version: number = 1;

  private hidden: string = "x";

  get computed(): string {
    return this.email;
  }

  summarize(prefix: string): string {
    return prefix + this.email;
  }
}
`;

    const result = transformDtoMetadataSource(source, "create-order.dto.ts", {
      swagger: true,
      graphql: true,
      introspectComments: true,
    });

    expect(result.modified).toBe(true);
    expect(result.classes).toHaveLength(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("CreateOrderDto");

    const byName = new Map(cls.properties.map((p) => [p.name, p]));
    expect([...byName.keys()]).toEqual([
      "email",
      "amount",
      "active",
      "createdAt",
      "tags",
      "nickname",
      "role",
      "status",
      "shippingAddress",
      "billingAddresses",
      "meta",
      "shape",
      "internalSecret",
    ]);

    expect(byName.get("email")).toMatchObject({
      typeExpr: "String",
      required: true,
      nullable: false,
      isArray: false,
      description: "Customer email address",
    });
    expect(byName.get("amount")).toMatchObject({
      typeExpr: "Number",
      required: true,
      description: "Total amount in cents",
    });
    expect(byName.get("active")).toMatchObject({
      typeExpr: "Boolean",
      required: false,
    });
    expect(byName.get("createdAt")).toMatchObject({
      typeExpr: "Date",
      required: true,
    });
    expect(byName.get("tags")).toMatchObject({
      typeExpr: "String",
      isArray: true,
      required: true,
    });
    expect(byName.get("nickname")).toMatchObject({
      typeExpr: "String",
      required: false,
      nullable: true,
    });
    expect(byName.get("role")).toMatchObject({
      typeExpr: "String",
      enumLiterals: ["admin", "member"],
      required: true,
    });
    expect(byName.get("status")).toMatchObject({
      enumExpr: "OrderStatus",
      required: true,
    });
    expect(byName.get("shippingAddress")).toMatchObject({
      typeExpr: "() => AddressDto",
      isArray: false,
    });
    expect(byName.get("billingAddresses")).toMatchObject({
      typeExpr: "() => AddressDto",
      isArray: true,
    });
    // Type-only imports and interfaces MUST safely fall back to Object (never reference erased types at runtime!)
    expect(byName.get("meta")?.typeExpr).toBe("Object");
    expect(byName.get("shape")?.typeExpr).toBe("Object");
    expect(byName.get("internalSecret")?.hideSwagger).toBe(true);

    // Generated code should NOT reference erased GhostInterface or InternalShape or fake classes
    expect(result.code).not.toContain("() => GhostInterface");
    expect(result.code).not.toContain("() => InternalShape");
    expect(result.code).not.toContain("CommentedOutDto,");
    expect(result.code).not.toContain("StringTemplateDto,");
    expect(result.code).toContain(
      'Symbol.for("bunest:swagger:api_properties")',
    );
    expect(result.code).toContain('Symbol.for("bunest:graphql:fields")');
  });

  it("integrates with real Bun.build({ plugins: [bunestMetadataPlugin()] }) and populates runtime Swagger & GraphQL metadata without overwriting explicit decorators", async () => {
    const tmpDir = join(
      TMP_DIR,
      `bunest-meta-plugin-${crypto.randomUUID().slice(0, 8)}`,
    );
    await ensureDir(tmpDir);
    try {
      const addressFile = join(tmpDir, "address.dto.ts");
      const userFile = join(tmpDir, "user.dto.ts");
      const entryFile = join(tmpDir, "index.ts");
      const outDir = join(tmpDir, "dist");

      await Bun.write(
        join(tmpDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
            },
          },
          null,
          2,
        ),
      );

      await Bun.write(
        addressFile,
        `
export class AddressDto {
  /** Street address line */
  street!: string;
  zipCode!: string;
}
`,
      );

      await Bun.write(
        userFile,
        `
import { AddressDto } from "./address.dto";

const API_PROPS = Symbol.for("bunest:swagger:api_properties");
function ExplicitOverride(description: string): PropertyDecorator {
  return (target, propertyKey) => {
    const existing = Reflect.getOwnMetadata(API_PROPS, target.constructor) ?? [];
    Reflect.defineMetadata(
      API_PROPS,
      [...existing, { propertyKey: String(propertyKey), description, example: "custom@bunest.dev" }],
      target.constructor,
    );
  };
}

export enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

export class CreateUserDto {
  /** Auto description that explicit decorator should override */
  @ExplicitOverride("Explicit email override")
  email!: string;

  /** User age in years */
  age?: number;

  scores!: number[];

  role!: UserRole;

  address!: AddressDto;

  tier!: "free" | "pro";
}
`,
      );

      await Bun.write(
        entryFile,
        `
export { AddressDto } from "./address.dto";
export { CreateUserDto, UserRole } from "./user.dto";
`,
      );

      const buildResult = await Bun.build({
        entrypoints: [entryFile],
        outdir: outDir,
        target: "bun",
        format: "esm",
        plugins: [
          bunestMetadataPlugin({
            dtoFileNameSuffix: [".dto.ts"],
            swagger: true,
            graphql: true,
          }),
        ],
      });

      expect(buildResult.success).toBe(true);
      expect(buildResult.outputs).toHaveLength(1);

      const builtModuleUrl = `${Bun.pathToFileURL(buildResult.outputs[0]!.path).href}?t=${Date.now()}`;
      const built = (await import(builtModuleUrl)) as {
        AddressDto: Function;
        CreateUserDto: Function;
        UserRole: Record<string, string>;
      };

      const addressSwagger = Reflect.getOwnMetadata(
        SWAGGER_API_PROPERTIES,
        built.AddressDto,
      ) as Array<Record<string, unknown>>;
      expect(addressSwagger).toEqual([
        {
          propertyKey: "street",
          type: String,
          required: true,
          description: "Street address line",
        },
        {
          propertyKey: "zipCode",
          type: String,
          required: true,
        },
      ]);

      const userSwagger = Reflect.getOwnMetadata(
        SWAGGER_API_PROPERTIES,
        built.CreateUserDto,
      ) as Array<Record<string, unknown>>;
      const swaggerMap = new Map(
        userSwagger.map((item) => [String(item.propertyKey), item]),
      );

      // Explicit decorator fields won over plugin defaults, while plugin type/required were merged in!
      expect(swaggerMap.get("email")).toEqual({
        propertyKey: "email",
        type: String,
        required: true,
        description: "Explicit email override",
        example: "custom@bunest.dev",
      });
      expect(swaggerMap.get("age")).toEqual({
        propertyKey: "age",
        type: Number,
        required: false,
        description: "User age in years",
      });
      expect(swaggerMap.get("scores")).toEqual({
        propertyKey: "scores",
        type: Number,
        isArray: true,
        required: true,
      });
      expect(swaggerMap.get("role")).toEqual({
        propertyKey: "role",
        required: true,
        enum: built.UserRole,
      });
      expect(swaggerMap.get("tier")).toEqual({
        propertyKey: "tier",
        type: String,
        required: true,
        enum: ["free", "pro"],
      });

      const addrMeta = swaggerMap.get("address");
      expect(typeof addrMeta?.type).toBe("function");
      expect((addrMeta?.type as () => Function)()).toBe(built.AddressDto);

      // GraphQL metadata also registered cleanly
      const userGql = Reflect.getOwnMetadata(
        GRAPHQL_FIELDS,
        built.CreateUserDto,
      ) as Array<{
        propertyKey: string;
        name: string;
        typeFn: () => unknown;
        nullable?: boolean;
      }>;
      const gqlMap = new Map(userGql.map((f) => [f.propertyKey, f]));
      expect(gqlMap.get("email")?.typeFn()).toBe(String);
      expect(gqlMap.get("age")?.nullable).toBe(true);
      expect(gqlMap.get("scores")?.typeFn()).toEqual([Number]);
      expect(gqlMap.get("address")?.typeFn()).toBe(built.AddressDto);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles regex literals in decorators, erased const enums, and explicit undefined-key metadata merges (Regression #114)", async () => {
    const src = `
export const enum Mode {
  FAST = "fast",
  SAFE = "safe",
}

export class UrlDto {
  @Matches(/^https?:\\/\\//)
  url!: string;

  @Matches(/a'b/)
  label!: string;

  mode!: Mode;
}
`;
    const res = transformDtoMetadataSource(src, "url.dto.ts", {
      swagger: true,
      graphql: true,
    });
    expect(res.modified).toBe(true);
    expect(res.classes).toHaveLength(1);
    expect(res.classes[0]?.properties.map((p) => p.name)).toEqual([
      "url",
      "label",
      "mode",
    ]);
    // Erased `const enum Mode` MUST NOT be referenced at runtime; literals are inlined safely
    expect(res.code).not.toContain("enum: Mode");
    expect(res.code).not.toContain("() => Mode");
    expect(res.code).toContain('enum: ["fast","safe"]');

    // Runtime check with real Bun.build(): explicit @Field({ nullable: true }) with `typeFn: undefined`
    // MUST NOT clobber plugin-inferred `typeFn: () => [String]`!
    const tmpDir = join(
      TMP_DIR,
      `bunest-meta-reg114-${crypto.randomUUID().slice(0, 8)}`,
    );
    await ensureDir(tmpDir);
    try {
      await Bun.write(
        join(tmpDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
          },
        }),
      );
      await Bun.write(
        join(tmpDir, "tags.model.ts"),
        `
const GQL_FIELDS = Symbol.for("bunest:graphql:fields");
function FakeField(opts: { nullable?: boolean }): PropertyDecorator {
  return (target, propertyKey) => {
    const existing = Reflect.getOwnMetadata(GQL_FIELDS, target.constructor) ?? [];
    Reflect.defineMetadata(
      GQL_FIELDS,
      [...existing, { propertyKey: String(propertyKey), name: String(propertyKey), typeFn: undefined, ...opts }],
      target.constructor,
    );
  };
}

function Matches(_re: RegExp): PropertyDecorator {
  return () => {};
}

export const enum Mode {
  FAST = "fast",
  SAFE = "safe",
}

export class TaggedModel {
  @Matches(/^https?:\\/\\//)
  homepage!: string;

  @FakeField({ nullable: true })
  tags!: string[];

  mode!: Mode;
}
`,
      );
      const buildRes = await Bun.build({
        entrypoints: [join(tmpDir, "tags.model.ts")],
        outdir: join(tmpDir, "dist"),
        target: "bun",
        format: "esm",
        plugins: [bunestMetadataPlugin({ swagger: true, graphql: true })],
      });
      expect(buildRes.success).toBe(true);
      const mod = (await import(
        `${Bun.pathToFileURL(buildRes.outputs[0]!.path).href}?t=${Date.now()}`
      )) as { TaggedModel: Function };

      const gqlFields = Reflect.getOwnMetadata(
        GRAPHQL_FIELDS,
        mod.TaggedModel,
      ) as Array<{
        propertyKey: string;
        typeFn?: () => unknown;
        nullable?: boolean;
      }>;
      const byKey = new Map(gqlFields.map((f) => [f.propertyKey, f]));
      expect(byKey.get("homepage")?.typeFn?.()).toBe(String);
      expect(byKey.get("tags")?.nullable).toBe(true);
      expect(byKey.get("tags")?.typeFn?.()).toEqual([String]);

      const swaggerProps = Reflect.getOwnMetadata(
        SWAGGER_API_PROPERTIES,
        mod.TaggedModel,
      ) as Array<{ propertyKey: string; enum?: unknown }>;
      expect(swaggerProps.find((p) => p.propertyKey === "mode")?.enum).toEqual([
        "fast",
        "safe",
      ]);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });
});
