import { describe, expect, it } from "bun:test";
import { Prop } from "@bunest/validation";
import {
  ApiProperty,
  DeepPartialType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  SchemaExplorer,
  generateSchema,
} from "../src/index";
import { isSchemaDecoratedClass } from "../src/schema-explorer";

describe("@Prop() OpenAPI / Swagger integration", () => {
  enum OrderStatus {
    Pending = "pending",
    Paid = "paid",
    Shipped = "shipped",
  }

  class AddressDto {
    @Prop({ string: true, description: "Street line" })
    street!: string;

    @Prop({ string: true, optional: true })
    zip?: string;
  }

  class ItemDto {
    @Prop({ notEmpty: true, description: "Item SKU", example: "SKU-001" })
    sku!: string;
  }

  class OrderDto {
    @Prop({
      email: true,
      description: "Customer email",
      example: "buyer@bunest.dev",
    })
    email!: string;

    @Prop({
      int: true,
      min: 1,
      max: 99,
      optional: true,
      default: 1,
      deprecated: true,
    })
    priority?: number;

    @Prop({ nullable: true, string: true, description: "Optional note" })
    note!: string | null;

    @Prop({ nested: () => ItemDto, each: true, minItems: 1 })
    items!: ItemDto[];

    @Prop({ hide: true, optional: true })
    internalToken?: string;

    @ApiProperty({ description: "Explicit ApiProperty wins" })
    @Prop({ string: true, description: "Prop description" })
    overridden!: string;
  }

  it("generates OpenAPI schema directly from @Prop() without @ApiProperty()", () => {
    const { schema, schemas } = generateSchema(OrderDto);
    const props = schema.properties as Record<string, Record<string, unknown>>;

    expect(props.email).toMatchObject({
      type: "string",
      format: "email",
      description: "Customer email",
      example: "buyer@bunest.dev",
    });

    expect(props.priority).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 99,
      default: 1,
      deprecated: true,
    });
    expect(schema.required).toContain("email");
    expect(schema.required).not.toContain("priority");

    // Nullable property (OAS 3.1 default)
    expect(props.note?.description).toBe("Optional note");
    expect(props.note?.type).toEqual(["string", "null"]);

    // Nested array DTO resolved via @Prop({ nested: () => ItemDto, each: true })
    expect(props.items?.type).toBe("array");
    expect(props.items?.minItems).toBe(1);
    expect(props.items?.items).toEqual({ $ref: "#/components/schemas/ItemDto" });
    expect(schemas.ItemDto?.properties).toHaveProperty("sku");

    // Hidden property omitted
    expect(props.internalToken).toBeUndefined();

    // Explicit @ApiProperty overrides @Prop doc metadata
    expect(props.overridden?.description).toBe("Explicit ApiProperty wins");
  });

  it("supports title, format (including array items), readOnly, writeOnly, exclude, expose, nested: true, enum, and isIn", () => {
    class RichPropDto {
      @Prop({
        string: true,
        title: "Display Name",
        readOnly: true,
        description: "Computed name",
      })
      displayName!: string;

      @Prop({ string: true, writeOnly: true, format: "password" })
      secret!: string;

      @Prop({ string: true, each: true, format: "email" })
      ccEmails!: string[];

      @Prop({ exclude: true, string: true })
      excludedField!: string;

      @Prop({ expose: "user_name", string: true })
      userName!: string;

      @Prop({ nested: true })
      address!: AddressDto;

      @Prop({ enum: OrderStatus })
      status!: OrderStatus;

      @Prop({ isIn: ["a", 1] })
      mixedChoice!: "a" | 1;

      @Prop({ string: true })
      unionString!: string | number;
    }

    const { schema, schemas } = generateSchema(RichPropDto);
    const props = schema.properties as Record<string, Record<string, unknown>>;

    expect(props.displayName).toMatchObject({
      type: "string",
      title: "Display Name",
      readOnly: true,
      description: "Computed name",
    });
    expect(props.secret).toMatchObject({
      type: "string",
      writeOnly: true,
      format: "password",
    });

    // format on array property applies to items, not the array itself
    expect(props.ccEmails).toMatchObject({
      type: "array",
      items: { type: "string", format: "email" },
    });
    expect(props.ccEmails?.format).toBeUndefined();

    // exclude & expose rename
    expect(props.excludedField).toBeUndefined();
    expect(props.userName).toBeUndefined();
    expect(props.user_name).toMatchObject({ type: "string" });
    expect(schema.required).toContain("user_name");

    // Single nested DTO via design:type
    expect(props.address).toEqual({ $ref: "#/components/schemas/AddressDto" });
    expect(schemas.AddressDto?.properties).toHaveProperty("street");

    // enum & isIn & union type overriding design:type = Object
    expect(props.status).toMatchObject({
      type: "string",
      enum: ["pending", "paid", "shipped"],
    });
    expect(props.mixedChoice).toMatchObject({
      type: "string",
      enum: ["a", 1],
    });
    expect(props.unionString).toMatchObject({ type: "string" });
  });

  it("handles OpenAPI 3.0 vs 3.1 compatibility for nullable and examples", () => {
    class VersionedDto {
      @Prop({
        string: true,
        nullable: true,
        examples: {
          primary: "alpha",
          wrapped: { summary: "Wrapped", value: "beta" },
        },
      })
      code!: string | null;

      @Prop({
        string: true,
        examples: ["x", "y"] as unknown as Record<string, unknown>,
      })
      tag!: string;

      @Prop({ nested: () => AddressDto, nullable: true })
      shipping!: AddressDto | null;
    }

    // OpenAPI 3.1
    const exp31 = new SchemaExplorer({ openApiVersion: "3.1.0" });
    const name31 = exp31.registerDtoSchema(VersionedDto);
    const props31 = exp31.getSchemas()[name31]?.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props31.code?.type).toEqual(["string", "null"]);
    expect(props31.code?.nullable).toBeUndefined();
    expect(props31.code?.examples).toEqual(["alpha", "beta"]);
    expect(props31.tag?.examples).toEqual(["x", "y"]);
    expect(props31.shipping).toEqual({
      anyOf: [{ $ref: "#/components/schemas/AddressDto" }, { type: "null" }],
    });

    // OpenAPI 3.0.3
    const exp30 = new SchemaExplorer({ openApiVersion: "3.0.3" });
    const name30 = exp30.registerDtoSchema(VersionedDto);
    const props30 = exp30.getSchemas()[name30]?.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(props30.code?.type).toBe("string");
    expect(props30.code?.nullable).toBe(true);
    expect(props30.code?.examples).toBeUndefined();
    expect(props30.code?.example).toBe("alpha");
    expect(props30.tag?.examples).toBeUndefined();
    expect(props30.tag?.example).toBe("x");
    expect(props30.shipping).toEqual({
      type: "object",
      nullable: true,
      allOf: [{ $ref: "#/components/schemas/AddressDto" }],
    });
  });

  it("honors excludeDynamicDefaults, function defaults, exampleMaxDepth, and sanitizes @Prop({ hide: true }) defaults", () => {
    class SecretInnerDto {
      @Prop({ string: true })
      publicField = "ok";

      @Prop({ hide: true, string: true })
      secret = "top-secret";
    }

    class DefaultAndDepthDto {
      @Prop({ string: true, default: () => "computed-default" })
      computed!: string;

      @Prop({
        object: true,
        example: { a: { b: { c: 1 } } },
        examples: { deep: { x: { y: 2 } } },
      })
      nestedExample!: Record<string, unknown>;

      @Prop({
        nested: () => SecretInnerDto,
        default: new SecretInnerDto(),
      })
      inner!: SecretInnerDto;

      @ApiProperty({ type: () => SecretInnerDto, default: new SecretInnerDto() })
      apiInner!: SecretInnerDto;
    }

    // Default behavior (excludeDynamicDefaults = false): invokes function default & sanitizes hidden fields
    const expDefault = new SchemaExplorer({ exampleMaxDepth: 1 });
    const defName = expDefault.registerDtoSchema(DefaultAndDepthDto);
    const defProps = expDefault.getSchemas()[defName]?.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(defProps.computed?.default).toBe("computed-default");
    expect(defProps.nestedExample?.example).toEqual({ a: {} });
    expect(defProps.nestedExample?.examples).toEqual([{ x: {} }]);
    expect(defProps.inner?.default).toEqual({ publicField: "ok" });
    expect(defProps.apiInner?.default).toEqual({ publicField: "ok" });

    // excludeDynamicDefaults = true strips function & class-instance defaults
    const expNoDyn = new SchemaExplorer({ excludeDynamicDefaults: true });
    const noDynName = expNoDyn.registerDtoSchema(DefaultAndDepthDto);
    const noDynProps = expNoDyn.getSchemas()[noDynName]?.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(noDynProps.computed?.default).toBeUndefined();
    expect(noDynProps.inner?.default).toBeUndefined();
  });

  it("recognizes @Prop-only DTOs without validator hints via isSchemaDecoratedClass()", () => {
    class MetaOnlyDto {
      @Prop({ description: "Arbitrary metadata" })
      meta!: Record<string, unknown>;
    }

    expect(isSchemaDecoratedClass(MetaOnlyDto)).toBe(true);
    const { schema } = generateSchema(MetaOnlyDto);
    expect(schema.properties?.meta).toMatchObject({
      type: "object",
      description: "Arbitrary metadata",
    });
    expect(schema.required).toEqual(["meta"]);
  });

  it("merges @Prop doc metadata as fallback for @ApiProperty({ enumName }) and @ApiProperty({ schema })", () => {
    class CombinedApiPropDto {
      @ApiProperty({ enum: OrderStatus, enumName: "OrderStatus" })
      @Prop({
        enum: OrderStatus,
        description: "Order lifecycle status",
        nullable: true,
        deprecated: true,
        readOnly: true,
      })
      status!: OrderStatus | null;

      @ApiProperty({ schema: { type: "string", format: "uuid" } })
      @Prop({ nullable: true })
      correlationId!: string | null;
    }

    const { schema } = generateSchema(CombinedApiPropDto);
    const props = schema.properties as Record<string, Record<string, unknown>>;

    expect(props.status).toMatchObject({
      description: "Order lifecycle status",
      deprecated: true,
      readOnly: true,
      anyOf: [{ $ref: "#/components/schemas/OrderStatus" }, { type: "null" }],
    });
    expect(props.correlationId).toMatchObject({
      type: ["string", "null"],
      format: "uuid",
    });
  });

  it("works with inheritance and Mapped Types (PartialType, PickType, OmitType, IntersectionType, DeepPartialType)", () => {
    class BaseDto {
      @Prop({ email: true, description: "User email" })
      email!: string;

      @Prop({ description: "Opaque metadata" })
      meta!: Record<string, unknown>;

      @Prop({ nested: () => AddressDto })
      address!: AddressDto;

      @Prop({ hide: true, string: true })
      hidden!: string;
    }

    class ChildDto extends BaseDto {
      @Prop({ string: true, description: "Child label" })
      label!: string;
    }

    // Inheritance
    const childSchema = generateSchema(ChildDto).schema;
    expect(childSchema.properties).toHaveProperty("email");
    expect(childSchema.properties).toHaveProperty("meta");
    expect(childSchema.properties).toHaveProperty("label");
    expect(childSchema.properties).not.toHaveProperty("hidden");
    expect(childSchema.required).toEqual(
      expect.arrayContaining(["email", "meta", "address", "label"]),
    );

    // PartialType (default & skipNullProperties: false) makes all inherited @Prop fields optional
    const PartialDefault = PartialType(BaseDto);
    expect(generateSchema(PartialDefault).schema.required).toBeUndefined();

    const PartialKeepNull = PartialType(BaseDto, { skipNullProperties: false });
    expect(generateSchema(PartialKeepNull).schema.required).toBeUndefined();

    // Subclass extending PartialType keeps newly declared @Prop fields required
    class UpdateWithReasonDto extends PartialType(BaseDto) {
      @Prop({ string: true })
      reason!: string;
    }
    expect(generateSchema(UpdateWithReasonDto).schema.required).toEqual([
      "reason",
    ]);

    // PickType & OmitType get distinct suffixed names and preserve @Prop metadata
    const PickEmail = PickType(BaseDto, ["email"]);
    const PickMeta = PickType(BaseDto, ["meta"]);
    expect(PickEmail.name).toBe("PickBaseDtoEmail");
    expect(PickMeta.name).toBe("PickBaseDtoMeta");
    const pickEmailSchema = generateSchema(PickEmail).schema;
    expect(Object.keys(pickEmailSchema.properties ?? {})).toEqual(["email"]);
    expect(pickEmailSchema.properties?.email).toMatchObject({
      type: "string",
      format: "email",
      description: "User email",
    });

    const OmitEmail = OmitType(BaseDto, ["email"]);
    expect(OmitEmail.name).toBe("OmitBaseDtoEmail");
    expect(generateSchema(OmitEmail).schema.properties).not.toHaveProperty(
      "email",
    );
    expect(generateSchema(OmitEmail).schema.properties).toHaveProperty("meta");

    // IntersectionType
    class ExtraDto {
      @Prop({ int: true, min: 0 })
      version!: number;
    }
    const Combined = IntersectionType(PickEmail, ExtraDto);
    const combinedSchema = generateSchema(Combined).schema;
    expect(combinedSchema.properties).toHaveProperty("email");
    expect(combinedSchema.properties).toHaveProperty("version");
    expect(combinedSchema.required).toEqual(
      expect.arrayContaining(["email", "version"]),
    );

    // DeepPartialType recursively wraps nested @Prop DTOs
    const DeepPartialBase = DeepPartialType(BaseDto);
    const deepRes = generateSchema(DeepPartialBase);
    expect(deepRes.schema.required).toBeUndefined();
    expect(deepRes.schema.properties?.address).toEqual({
      $ref: "#/components/schemas/DeepPartialAddressDto",
    });
    expect(deepRes.schemas.DeepPartialAddressDto?.required).toBeUndefined();
    expect(
      deepRes.schemas.DeepPartialAddressDto?.properties?.street,
    ).toMatchObject({
      type: "string",
      description: "Street line",
    });
  });
});
