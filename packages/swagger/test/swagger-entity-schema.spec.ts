import { describe, expect, test } from "bun:test";
import {
  Body,
  Column,
  Controller,
  CreateDateColumn,
  Entity,
  Get,
  Module,
  Param,
  Post,
  PrimaryGeneratedColumn,
  PrimaryKey,
  Query,
  UpdateDateColumn,
} from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import { IsEmail } from "../../validation/src/validator";
import {
  ApiBadRequestResponse,
  ApiHideProperty,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  DocumentBuilder,
  SwaggerModule,
  generateSchema,
} from "../src/index";

@Entity({ tableName: "base_entities" })
class BaseAuditEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn({ description: "Creation timestamp" })
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity({ tableName: "articles", description: "Published blog article" })
class ArticleEntity extends BaseAuditEntity {
  @Column({
    minLength: 3,
    maxLength: 120,
    description: "Article headline",
    example: "Decorator-First Bunest",
  })
  title!: string;

  @Column({
    type: "varchar",
    length: 60,
    pattern: /^[a-z0-9-]+$/,
  })
  slug!: string;

  @Column({
    enum: ["draft", "published", "archived"],
    default: "draft",
    description: "Publication workflow status",
  })
  status!: string;

  @Column({ type: "integer", min: 0, max: 1_000_000, default: 0 })
  views!: number;

  @Column({ type: "real", min: 0, max: 5, nullable: true })
  rating?: number | null;

  @Column({ type: "boolean", default: false })
  featured!: boolean;

  @Column({ type: "uuid", nullable: true })
  authorUuid?: string | null;

  @Column({ type: "bigint", nullable: true })
  externalRef?: bigint | null;

  @Column({ type: "json", nullable: true })
  tags?: string[] | null;

  @Column({ type: "json", nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ type: "blob", nullable: true })
  thumbnail?: Uint8Array | null;
}

@Entity({ tableName: "accounts", description: "Default entity description" })
@ApiSchema({
  name: "AccountModel",
  description: "Overridden OpenAPI account description",
})
class AccountEntity {
  @PrimaryKey({ type: "uuid", description: "Client-assigned UUID primary key" })
  id!: string;

  @Column({ minLength: 5, maxLength: 100 })
  @IsEmail()
  @ApiProperty({ example: "ada@bunest.dev" })
  email!: string;

  @Column({ nullable: true, maxLength: 200 })
  @ApiProperty({ description: "Optional user biography" })
  bio?: string | null;

  @Column({ minLength: 2 })
  @ApiPropertyOptional({
    description: "Marked optional via @ApiPropertyOptional",
  })
  nickname?: string;

  @Column({ nullable: true })
  @ApiProperty({
    required: true,
    description: "Explicitly required in OpenAPI",
  })
  tenantCode!: string;

  @Column({ minLength: 8 })
  @ApiHideProperty()
  passwordHash!: string;
}

@Entity("article_query_filters")
class ArticleFilterEntity {
  @Column({
    enum: ["draft", "published"],
    nullable: true,
    description: "Filter by status",
  })
  status?: string | null;

  @Column({ type: "integer", min: 1, max: 100, default: 20 })
  limit?: number;
}

@Entity("article_path_params")
class ArticleParamEntity {
  @PrimaryKey({ type: "uuid", description: "Target article UUID" })
  articleId!: string;
}

class SummaryDto {
  @ApiProperty({ example: "ok" })
  summary!: string;
}

class UndecoratedHelper {
  internalOnly = 1;
}

describe("@bunest/swagger Entity Schema Auto-Generation & design:returntype Auto-Inference", () => {
  test("auto-generates complete OpenAPI 3.1 schemas for @Entity classes WITHOUT any @ApiProperty decorators", () => {
    const { schema } = generateSchema(ArticleEntity);

    expect(schema.type).toBe("object");
    expect(schema.description).toBe("Published blog article");

    // Inherited columns from BaseAuditEntity
    expect(schema.properties?.id).toEqual({ type: "integer" });
    expect(schema.properties?.createdAt).toEqual({
      type: "string",
      format: "date-time",
      description: "Creation timestamp",
    });
    expect(schema.properties?.updatedAt).toEqual({
      type: "string",
      format: "date-time",
    });

    // All column types, formats, constraints, defaults, examples, and OpenAPI 3.1 nullable
    expect(schema.properties?.title).toEqual({
      type: "string",
      description: "Article headline",
      example: "Decorator-First Bunest",
      minLength: 3,
      maxLength: 120,
    });
    expect(schema.properties?.slug).toEqual({
      type: "string",
      maxLength: 60,
      pattern: "^[a-z0-9-]+$",
    });
    expect(schema.properties?.status).toEqual({
      type: "string",
      description: "Publication workflow status",
      default: "draft",
      enum: ["draft", "published", "archived"],
    });
    expect(schema.properties?.views).toEqual({
      type: "integer",
      default: 0,
      minimum: 0,
      maximum: 1_000_000,
    });
    expect(schema.properties?.rating).toEqual({
      type: ["number", "null"],
      minimum: 0,
      maximum: 5,
    });
    expect(schema.properties?.featured).toEqual({
      type: "boolean",
      default: false,
    });
    expect(schema.properties?.authorUuid).toEqual({
      type: ["string", "null"],
      format: "uuid",
    });
    expect(schema.properties?.externalRef).toEqual({
      type: ["integer", "null"],
      format: "int64",
    });
    expect(schema.properties?.tags).toEqual({
      type: ["array", "null"],
      items: {},
    });
    expect(schema.properties?.metadata).toEqual({
      type: ["object", "null"],
    });
    expect(schema.properties?.thumbnail).toEqual({
      type: ["string", "null"],
      format: "binary",
    });

    // Only non-nullable, non-default, non-generated, non-timestamp columns are required
    expect(schema.required).toEqual(["title", "slug"]);
  });

  test("merges @Entity/@Column metadata with explicit @ApiProperty, @ApiSchema, @ApiHideProperty, and class-validator overrides", () => {
    const { schema, schemas } = generateSchema(AccountEntity);

    expect(schemas.AccountModel).toBe(schema);
    expect(schema.description).toBe("Overridden OpenAPI account description");

    // Non-generated @PrimaryKey is required with uuid format & description
    expect(schema.properties?.id).toEqual({
      type: "string",
      format: "uuid",
      description: "Client-assigned UUID primary key",
    });

    // @Column + @IsEmail + @ApiProperty merged cleanly
    expect(schema.properties?.email).toEqual({
      type: "string",
      format: "email",
      minLength: 5,
      maxLength: 100,
      example: "ada@bunest.dev",
    });

    // @Column({ nullable: true }) + @ApiProperty({ description }) stays optional & nullable
    expect(schema.properties?.bio).toEqual({
      type: ["string", "null"],
      maxLength: 200,
      description: "Optional user biography",
    });

    // @ApiHideProperty hides passwordHash column completely
    expect(schema.properties?.passwordHash).toBeUndefined();

    // Required array honors entity defaults AND explicit @ApiProperty required overrides
    expect(schema.required).toContain("id");
    expect(schema.required).toContain("email");
    expect(schema.required).toContain("tenantCode");
    expect(schema.required).not.toContain("bio");
    expect(schema.required).not.toContain("nickname");
    expect(schema.required).not.toContain("passwordHash");
  });

  test("SwaggerModule.createDocument() emits @Entity schemas for @Body/@Query/@Param AND auto-infers response $ref from design:returntype while safely ignoring built-ins and undecorated classes", async () => {
    @Controller("/articles")
    class ArticlesController {
      @Post()
      @ApiBadRequestResponse({ description: "Invalid article payload" })
      create(@Body() body: ArticleEntity): ArticleEntity {
        return body;
      }

      @Get()
      list(@Query() _filter: ArticleFilterEntity): ArticleEntity[] {
        return [];
      }

      @Get(":articleId")
      findOne(@Param() _params: ArticleParamEntity): ArticleEntity {
        return new ArticleEntity();
      }

      @Get("async/:id")
      async findOneAsync(@Param("id") _id: string): Promise<ArticleEntity> {
        return new ArticleEntity();
      }

      @Get("summary/dto")
      getSummaryDto(): SummaryDto {
        return { summary: "ok" };
      }

      @Get("explicit/override")
      @ApiOkResponse({
        type: SummaryDto,
        description: "Explicit response wins",
      })
      explicitOverride(): ArticleEntity {
        return new ArticleEntity();
      }

      @Get("raw/object")
      getRawObject(): Record<string, unknown> {
        return { ok: true };
      }

      @Get("raw/helper")
      getUndecorated(): UndecoratedHelper {
        return new UndecoratedHelper();
      }

      @Get("raw/fn")
      getFn(): () => void {
        return () => {};
      }
    }

    @Module({ controllers: [ArticlesController] })
    class ArticlesAppModule {}

    const app = await BunestFactory.create(ArticlesAppModule, {
      logger: false,
    });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("Entity Swagger API")
          .setVersion("1.0.0")
          .build(),
      );

      // 1. POST /articles: @Body() ArticleEntity + design:returntype auto-inferred 201 EVEN WITH @ApiBadRequestResponse!
      const createOp = doc.paths["/articles"]?.post;
      expect(
        createOp?.requestBody?.content["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/ArticleEntity" });
      expect(
        createOp?.responses["201"]?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/ArticleEntity" });
      expect(createOp?.responses["201"]?.description).toBe("Created");
      expect(createOp?.responses["400"]?.description).toBe(
        "Invalid article payload",
      );

      // 2. GET /articles: @Query() whole-entity expansion + Array return type safely ignored (no bogus Array $ref)
      const listOp = doc.paths["/articles"]?.get;
      const statusQuery = listOp?.parameters?.find(
        (p) => p.in === "query" && p.name === "status",
      );
      const limitQuery = listOp?.parameters?.find(
        (p) => p.in === "query" && p.name === "limit",
      );
      expect(statusQuery).toMatchObject({
        name: "status",
        in: "query",
        required: false,
        description: "Filter by status",
        schema: {
          type: ["string", "null"],
          enum: ["draft", "published", null],
        },
      });
      expect(limitQuery).toMatchObject({
        name: "limit",
        in: "query",
        required: false,
        schema: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      });
      expect(listOp?.responses["200"]?.content).toBeUndefined();

      // 3. GET /articles/{articleId}: @Param() whole-entity expansion + design:returntype 200 $ref
      const findOneOp = doc.paths["/articles/{articleId}"]?.get;
      const articleIdParam = findOneOp?.parameters?.find(
        (p) => p.in === "path" && p.name === "articleId",
      );
      expect(articleIdParam).toMatchObject({
        name: "articleId",
        in: "path",
        required: true,
        description: "Target article UUID",
        schema: { type: "string", format: "uuid" },
      });
      expect(
        findOneOp?.responses["200"]?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/ArticleEntity" });

      // 4. GET /articles/summary/dto: @ApiProperty-decorated DTO auto-inferred via design:returntype
      expect(
        doc.paths["/articles/summary/dto"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/SummaryDto" });

      // 5. Explicit @ApiOkResponse({ type: SummaryDto }) takes precedence over design:returntype
      expect(
        doc.paths["/articles/explicit/override"]?.get?.responses["200"]
          ?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/SummaryDto" });

      // 6. Promise, Object, Function, and undecorated classes are safely ignored
      expect(
        doc.paths["/articles/async/{id}"]?.get?.responses["200"]?.content,
      ).toBeUndefined();
      expect(
        doc.paths["/articles/raw/object"]?.get?.responses["200"]?.content,
      ).toBeUndefined();
      expect(
        doc.paths["/articles/raw/helper"]?.get?.responses["200"]?.content,
      ).toBeUndefined();
      expect(
        doc.paths["/articles/raw/fn"]?.get?.responses["200"]?.content,
      ).toBeUndefined();
      expect(doc.components?.schemas?.UndecoratedHelper).toBeUndefined();
      expect(doc.components?.schemas?.Promise).toBeUndefined();
      expect(doc.components?.schemas?.Object).toBeUndefined();

      // 7. ArticleEntity schema registered cleanly in components.schemas
      const articleSchema = doc.components?.schemas?.ArticleEntity;
      expect(articleSchema).toBeDefined();
      expect(articleSchema?.properties?.title).toMatchObject({
        type: "string",
        minLength: 3,
        maxLength: 120,
      });
      expect(articleSchema?.required).toEqual(["title", "slug"]);
    } finally {
      await app.close();
    }
  });
});
