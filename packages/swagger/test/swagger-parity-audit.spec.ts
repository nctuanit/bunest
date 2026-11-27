import { afterEach, describe, expect, it } from "bun:test";
import {
  BunestFactory,
  Controller,
  Get,
  Module,
  Post,
  Body,
  ensureDir,
  join,
  removePath,
} from "@bunest/core";
import {
  ArrayNotEmpty,
  Equals,
  IsDate,
  IsDivisibleBy,
  IsISO8601,
  IsInt,
  IsNegative,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from "@bunest/validation/validator";
import { Exclude, Expose, Type } from "@bunest/validation/transformer";
import {
  Column as OrmColumn,
  Entity as OrmEntity,
  ObjectIdColumn,
} from "../../orm/src";
import { generateMetadataFile } from "../../cli/src/plugins/metadata.plugin";
import {
  ApiProperty,
  CompositionType,
  DocumentBuilder,
  SchemaExplorer,
  SwaggerModule,
  defaultStandardSchemaConverter,
  generateSchema,
  type OpenApiSchema,
  type StandardJSONSchemaV1,
} from "../src";
import { clearPluginMetadataStore } from "../src/plugin-metadata-store";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearPluginMetadataStore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("@bunest/swagger Parity Audit Regressions", () => {
  it("emits OAS 3.1 numeric and OAS 3.0 boolean bounds for @IsPositive() / @IsNegative() and respects stricter @Min / @Max", () => {
    class NumericBoundsDto {
      @IsPositive()
      amount!: number;

      @IsNegative()
      deficit!: number;

      @IsPositive()
      @Min(5)
      minOverridesPositive!: number;

      @IsNegative()
      @Max(-5)
      maxOverridesNegative!: number;
    }

    // OAS 3.1 (default)
    const { schema: oas31 } = generateSchema(NumericBoundsDto);
    expect(oas31.properties?.amount).toEqual({
      type: "number",
      exclusiveMinimum: 0,
    });
    expect(oas31.properties?.deficit).toEqual({
      type: "number",
      exclusiveMaximum: 0,
    });
    expect(oas31.properties?.minOverridesPositive).toEqual({
      type: "number",
      minimum: 5,
    });
    expect(oas31.properties?.maxOverridesNegative).toEqual({
      type: "number",
      maximum: -5,
    });

    // OAS 3.0
    const explorer30 = new SchemaExplorer({ openApiVersion: "3.0.3" });
    explorer30.registerDtoSchema(NumericBoundsDto);
    const oas30 = explorer30.getSchemas().NumericBoundsDto!;
    expect(oas30.properties?.amount).toEqual({
      type: "number",
      minimum: 0,
      exclusiveMinimum: true,
    });
    expect(oas30.properties?.deficit).toEqual({
      type: "number",
      maximum: 0,
      exclusiveMaximum: true,
    });
    expect(oas30.properties?.minOverridesPositive).toEqual({
      type: "number",
      minimum: 5,
    });
    expect(oas30.properties?.maxOverridesNegative).toEqual({
      type: "number",
      maximum: -5,
    });
  });

  it("keeps @ValidateIf() properties required while marking @IsOptional() properties optional", () => {
    class ConditionalDto {
      @IsString()
      mode!: string;

      @ValidateIf((obj: { mode?: string }) => obj.mode === "custom")
      @IsString()
      conditionalField!: string;

      @IsOptional()
      @IsString()
      optionalField?: string;
    }

    const { schema } = generateSchema(ConditionalDto);
    expect(schema.required).toContain("mode");
    expect(schema.required).toContain("conditionalField");
    expect(schema.required).not.toContain("optionalField");
  });

  it("maps @Length, @IsDate, @IsISO8601, @IsObject, @IsDivisibleBy, @ArrayNotEmpty, @Equals, and each: true constraints", async () => {
    class ValidatorHintsDto {
      @Length(2, 10)
      code!: string;

      @IsDate()
      createdAt!: Date;

      @IsISO8601()
      publishedAt!: string;

      @IsObject()
      payload!: Record<string, unknown>;

      @IsInt()
      @IsDivisibleBy(5)
      stepCount!: number;

      @ArrayNotEmpty()
      @IsString({ each: true })
      @MinLength(3, { each: true })
      tags!: string[];

      @ArrayNotEmpty()
      @IsPositive({ each: true })
      weights!: number[];

      @Equals("active")
      status!: "active";
    }

    // OAS 3.1
    const { schema: oas31 } = generateSchema(ValidatorHintsDto);
    expect(oas31.properties?.code).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 10,
    });
    expect(oas31.properties?.createdAt).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(oas31.properties?.publishedAt).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(oas31.properties?.payload).toEqual({
      type: "object",
    });
    expect(oas31.properties?.stepCount).toEqual({
      type: "integer",
      multipleOf: 5,
    });
    expect(oas31.properties?.tags).toEqual({
      type: "array",
      minItems: 1,
      items: {
        type: "string",
        minLength: 3,
      },
    });
    expect(oas31.properties?.weights).toEqual({
      type: "array",
      minItems: 1,
      items: {
        type: "number",
        exclusiveMinimum: 0,
      },
    });
    expect(oas31.properties?.status).toEqual({
      type: "string",
      const: "active",
    });

    // OAS 3.0 via DocumentBuilder.setOpenAPIVersion("3.0.3")
    @Controller("hints")
    class HintsController {
      @Post()
      create(@Body() _dto: ValidatorHintsDto) {
        return { ok: true };
      }
    }

    @Module({ controllers: [HintsController] })
    class HintsModule {}

    const app = await BunestFactory.create(HintsModule, { logger: false });
    try {
      const doc30 = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("OAS 3.0 Hints")
          .setVersion("1.0")
          .setOpenAPIVersion("3.0.3")
          .build(),
      );
      const schema30 = doc30.components?.schemas
        ?.ValidatorHintsDto as OpenApiSchema;
      expect(schema30.properties?.status).toEqual({
        type: "string",
        enum: ["active"],
      });
      expect(schema30.properties?.weights).toEqual({
        type: "array",
        minItems: 1,
        items: {
          type: "number",
          minimum: 0,
          exclusiveMinimum: true,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("honors @bunest/validation/transformer class @Exclude(), property @Exclude(), @Expose({ name }), and @Type(() => NestedDto) including arrays", () => {
    class NestedAddressDto {
      @IsString()
      city!: string;
    }

    @Exclude()
    class ClassExcludedUserDto {
      @Expose({ name: "user_email" })
      @IsString()
      email!: string;

      @Expose()
      @Type(() => NestedAddressDto)
      primaryAddress!: NestedAddressDto;

      @Expose()
      @Type(() => NestedAddressDto)
      addresses!: NestedAddressDto[];

      @IsString()
      internalSecret!: string;
    }

    class PropertyExcludedDto {
      @Expose({ name: "public_name" })
      @IsString()
      publicName!: string;

      @Exclude()
      @IsString()
      passwordHash!: string;
    }

    const { schema: userSchema, schemas } =
      generateSchema(ClassExcludedUserDto);
    expect(schemas.NestedAddressDto).toBeDefined();
    expect(userSchema.properties?.internalSecret).toBeUndefined();
    expect(userSchema.properties?.email).toBeUndefined();
    expect(userSchema.properties?.user_email).toEqual({ type: "string" });
    expect(userSchema.properties?.primaryAddress).toEqual({
      $ref: "#/components/schemas/NestedAddressDto",
    });
    expect(userSchema.properties?.addresses).toEqual({
      type: "array",
      items: {
        $ref: "#/components/schemas/NestedAddressDto",
      },
    });
    expect(userSchema.required).toEqual([
      "user_email",
      "primaryAddress",
      "addresses",
    ]);

    const { schema: propExcludedSchema } = generateSchema(PropertyExcludedDto);
    expect(propExcludedSchema.properties?.passwordHash).toBeUndefined();
    expect(propExcludedSchema.properties?.publicName).toBeUndefined();
    expect(propExcludedSchema.properties?.public_name).toEqual({
      type: "string",
    });
    expect(propExcludedSchema.required).toEqual(["public_name"]);
  });

  it("composes schemas via CompositionType() wrapper from @bunest/swagger", () => {
    class IdentityPartDto {
      @ApiProperty({ example: "usr_1" })
      id!: string;
    }

    class ProfilePartDto {
      @ApiProperty({ required: false })
      bio?: string;

      @ApiProperty({ example: 3 })
      rank!: number;
    }

    class CombinedMemberDto extends CompositionType(
      IdentityPartDto,
      ProfilePartDto,
    ) {}

    const { schema } = generateSchema(CombinedMemberDto);
    expect(schema.properties?.id).toEqual({
      type: "string",
      example: "usr_1",
    });
    expect(schema.properties?.bio).toEqual({
      type: "string",
    });
    expect(schema.properties?.rank).toEqual({
      type: "number",
      example: 3,
    });
    expect(schema.required).toEqual(["id", "rank"]);
  });

  it("hides ORM @Column({ select: false }) unless explicitly @ApiProperty-decorated, emits format: 'date' for @Column({ type: 'date' }), and exposes @ObjectIdColumn() as primary string", () => {
    @OrmEntity({ tableName: "audit_members" })
    class AuditMemberEntity {
      @ObjectIdColumn({ description: "MongoDB ObjectId primary key" })
      _id!: string;

      @OrmColumn({ type: "date", description: "Date of birth" })
      birthDate!: string;

      @OrmColumn({ select: false })
      passwordHash!: string;

      @OrmColumn({ select: false })
      @ApiProperty({ description: "Explicitly exposed token" })
      apiToken!: string;
    }

    const { schema } = generateSchema(AuditMemberEntity);
    expect(schema.properties?._id).toEqual({
      type: "string",
      description: "MongoDB ObjectId primary key",
    });
    expect(schema.properties?.birthDate).toEqual({
      type: "string",
      format: "date",
      description: "Date of birth",
    });
    expect(schema.properties?.passwordHash).toBeUndefined();
    expect(schema.properties?.apiToken).toEqual({
      type: "string",
      description: "Explicitly exposed token",
    });
    expect(schema.required).toEqual(["birthDate", "apiToken"]);
  });

  it("integrates CLI generateMetadataFile() with SwaggerModule.loadPluginMetadata() for nested DTOs, controller returns, enums, and array constraints", async () => {
    const tmpProject = await makeTempDir("bunest-swagger-cli-meta-");
    await ensureDir(join(tmpProject, "src/nested"));

    await Bun.write(
      join(tmpProject, "src/nested/line-item.dto.ts"),
      `export class LineItemDto {\n  sku!: string;\n}\n`,
    );
    await Bun.write(
      join(tmpProject, "src/invoice.dto.ts"),
      `import { LineItemDto } from "./nested/line-item.dto";
function ArrayMinSize(_n: number): PropertyDecorator { return () => {}; }
function ArrayMaxSize(_n: number): PropertyDecorator { return () => {}; }
function ArrayUnique(): PropertyDecorator { return () => {}; }

export enum InvoiceStatus {
  Draft = "draft",
  Issued = "issued",
}

export class InvoiceDto {
  items!: LineItemDto[];
  status!: InvoiceStatus;

  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  labels!: string[];
}
`,
    );
    await Bun.write(
      join(tmpProject, "src/invoice.controller.ts"),
      `import { InvoiceDto } from "./invoice.dto";
function Get(): MethodDecorator { return () => {}; }
export class InvoiceController {
  @Get()
  getInvoice(): InvoiceDto {
    return {} as InvoiceDto;
  }
}
`,
    );

    const generated = await generateMetadataFile({
      rootDir: tmpProject,
      pathToSource: "src",
      outDir: "src",
      esmCompatible: false,
      esmCompatibleWasConfigured: true,
      autoFillEnumName: true,
    });

    expect(generated.code).toContain("type: () => LineItemDto");
    expect(generated.code).toContain("enum: InvoiceStatus");
    expect(generated.code).toContain('enumName: "InvoiceStatus"');
    expect(generated.code).toContain("minItems: 1");
    expect(generated.code).toContain("maxItems: 5");
    expect(generated.code).toContain("uniqueItems: true");
    expect(generated.code).toContain("type: () => InvoiceDto");

    const loadedMod = (await import(
      `${Bun.pathToFileURL(generated.outputPath).href}?t=${Date.now()}`
    )) as { default: () => Promise<Record<string, unknown>> };
    await SwaggerModule.loadPluginMetadata(loadedMod.default);

    const invoiceMod = (await import(
      `${Bun.pathToFileURL(join(tmpProject, "src/invoice.dto.ts")).href}?t=${Date.now()}`
    )) as { InvoiceDto: new () => unknown };

    const { schema, schemas } = generateSchema(invoiceMod.InvoiceDto);
    expect(schemas.LineItemDto).toBeDefined();
    expect(schemas.InvoiceStatus).toEqual({
      type: "string",
      enum: ["draft", "issued"],
    });
    expect(schema.properties?.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/LineItemDto" },
    });
    expect(schema.properties?.status).toEqual({
      $ref: "#/components/schemas/InvoiceStatus",
    });
    expect(schema.properties?.labels).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
    });

    // Also verify controller metadata return type via SwaggerModule.createDocument()
    const ctrlMod = (await import(
      `${Bun.pathToFileURL(join(tmpProject, "src/invoice.controller.ts")).href}?t=${Date.now()}`
    )) as { InvoiceController: new () => unknown };

    Controller("invoices")(ctrlMod.InvoiceController);
    const descriptor = Object.getOwnPropertyDescriptor(
      ctrlMod.InvoiceController.prototype,
      "getInvoice",
    )!;
    Get()(ctrlMod.InvoiceController.prototype, "getInvoice", descriptor);

    @Module({ controllers: [ctrlMod.InvoiceController as any] })
    class InvoiceModule {}

    const app = await BunestFactory.create(InvoiceModule, { logger: false });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Invoices").setVersion("1.0").build(),
      );
      expect(
        doc.paths["/invoices"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/InvoiceDto" });
    } finally {
      await app.close();
    }
  });

  it("defaults Standard Schema conversion to openapi-3.0 when openApiVersion is unset, while preserving draft-2020-12 for explicit OAS 3.1+", async () => {
    const requestedTargets: string[] = [];
    const standardSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: ({ target }: { target: string }) => {
            requestedTargets.push(target);
            return {
              type: "object",
              properties: {
                kind: { type: "string", const: "cat" },
                label: { type: "string", examples: ["Milo", "Luna"] },
              },
              required: ["kind"],
            };
          },
          output: ({ target }: { target: string }) => {
            requestedTargets.push(target);
            return {
              type: "object",
              properties: {
                kind: { type: "string", const: "cat" },
                label: { type: "string", examples: ["Milo", "Luna"] },
              },
              required: ["kind"],
            };
          },
        },
      },
    } as StandardJSONSchemaV1;

    // 1. Omitted openApiVersion -> defaults to openapi-3.0 and normalizes const/examples
    const defaultResult = defaultStandardSchemaConverter(standardSchema, {
      schemaType: "input",
    });
    expect(requestedTargets.at(-1)).toBe("openapi-3.0");
    expect(defaultResult?.schema).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["cat"] },
        label: { type: "string", example: "Milo" },
      },
      required: ["kind"],
    });

    // 2. SchemaExplorer with omitted openApiVersion omits openApiVersion on custom converter opts
    const seenOpts: Array<Record<string, unknown>> = [];
    const customExplorer = new SchemaExplorer({
      standardSchemaConverter: (_s, opts) => {
        seenOpts.push({ ...opts });
        return { schema: { type: "string" } };
      },
    });
    customExplorer.resolveStandardSchema(standardSchema, "input");
    expect(seenOpts).toEqual([{ schemaType: "input" }]);

    // 3. Explicit openApiVersion: "3.1.0" -> targets draft-2020-12 and preserves const/examples
    const explorer31 = new SchemaExplorer({ openApiVersion: "3.1.0" });
    const oas31Schema = explorer31.resolveStandardSchema(
      standardSchema,
      "input",
    );
    expect(requestedTargets.at(-1)).toBe("draft-2020-12");
    expect(oas31Schema).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", const: "cat" },
        label: { type: "string", examples: ["Milo", "Luna"] },
      },
      required: ["kind"],
    });

    // 4. DocumentBuilder.setOpenAPIVersion("3.0.3") vs ("3.1.0") through SwaggerModule.createDocument()
    @Controller("std-ver")
    class StdVerController {
      @Post()
      create(@Body({ schema: standardSchema } as any) _body: unknown) {
        return { ok: true };
      }
    }

    @Module({ controllers: [StdVerController] })
    class StdVerModule {}

    const app = await BunestFactory.create(StdVerModule, { logger: false });
    try {
      const doc30 = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("OAS 3.0 Std")
          .setOpenAPIVersion("3.0.3")
          .build(),
      );
      expect(
        doc30.paths["/std-ver"]?.post?.requestBody?.content?.["application/json"]
          ?.schema,
      ).toEqual({
        type: "object",
        properties: {
          kind: { type: "string", enum: ["cat"] },
          label: { type: "string", example: "Milo" },
        },
        required: ["kind"],
      });

      const doc31 = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("OAS 3.1 Std")
          .setOpenAPIVersion("3.1.0")
          .build(),
      );
      expect(
        doc31.paths["/std-ver"]?.post?.requestBody?.content?.["application/json"]
          ?.schema,
      ).toEqual({
        type: "object",
        properties: {
          kind: { type: "string", const: "cat" },
          label: { type: "string", examples: ["Milo", "Luna"] },
        },
        required: ["kind"],
      });
    } finally {
      await app.close();
    }
  });
});
