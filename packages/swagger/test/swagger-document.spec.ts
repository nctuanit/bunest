import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import {
  All,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  UploadedFile,
  type UploadedFileInfo,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from "class-validator";
import {
  ApiApiKey,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExcludeController,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "../src/index";

enum UserRole {
  ADMIN = "admin",
  MEMBER = "member",
}

class AddressDto {
  @ApiProperty({ example: "Tokyo" })
  city!: string;

  @ApiPropertyOptional({ example: "100-0001", nullable: true })
  zipCode?: string | null;
}

class BaseEntityDto {
  @ApiProperty({ format: "uuid", readOnly: true })
  id!: string;
}

class CreateUserDto {
  @IsEmail()
  @ApiProperty({ description: "User email address", example: "ada@bun.sh" })
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(120)
  age?: number;

  @IsEnum(UserRole)
  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty({ type: AddressDto })
  address!: AddressDto;

  @ApiPropertyOptional({ type: [String], example: ["ts", "bun"] })
  tags?: string[];
}

class UserResponseDto extends BaseEntityDto {
  @ApiProperty({ example: "ada@bun.sh" })
  email!: string;
}

class TreeNodeDto {
  @ApiProperty()
  label!: string;

  @ApiPropertyOptional({
    type: () => TreeNodeDto,
    nullable: true,
    description: "Parent tree node",
    deprecated: true,
  })
  parent?: TreeNodeDto | null;

  @ApiPropertyOptional({ type: () => [TreeNodeDto] })
  children?: TreeNodeDto[];
}

class AuthorDto {
  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ type: () => [BookDto] })
  books?: BookDto[];
}

class BookDto {
  @ApiProperty()
  title!: string;

  @ApiProperty({ type: () => AuthorDto })
  author!: AuthorDto;
}

class ExtraStandaloneDto {
  @ApiProperty()
  code!: string;
}

describe("DocumentBuilder & OpenAPI 3.1 Document Generation", () => {
  test("builds complete OpenAPI 3.1 document with parameters, DTOs, validator hints, inheritance, circular refs, security, and exclusions", async () => {
    @ApiTags("Users")
    @ApiBearerAuth()
    @ApiHeader({ name: "X-Tenant-Id", required: true, description: "Tenant ID" })
    @Controller("/users")
    class UsersController {
      @Post()
      @ApiOperation({
        summary: "Create a user",
        description: "Registers a new user account",
      })
      @ApiCreatedResponse({ type: UserResponseDto, description: "User created" })
      @ApiBadRequestResponse({ description: "Validation error" })
      create(@Body() dto: CreateUserDto) {
        return dto;
      }

      @Get(":id(\\d+)")
      @ApiOperation({ summary: "Get user by ID" })
      @ApiParam({ name: "id", type: "integer", description: "Numeric user ID" })
      @ApiQuery({ name: "expand", required: false, enum: ["address", "roles"] })
      @ApiOkResponse({ type: UserResponseDto })
      @ApiNotFoundResponse({ description: "User not found" })
      findOne(
        @Param("id") id: string,
        @Query("expand") expand?: string,
        @Headers("x-trace-id") traceId?: string,
      ) {
        return { id, expand, traceId };
      }

      @Get("tree")
      @ApiOkResponse({ type: TreeNodeDto })
      getTree() {
        return {};
      }

      @Get("authors")
      @ApiApiKey("x-api-key")
      @ApiOkResponse({ type: AuthorDto, isArray: true })
      getAuthors() {
        return [];
      }

      @Post("avatar")
      @HttpCode(200)
      uploadAvatar(@UploadedFile("avatar") file: UploadedFileInfo) {
        return { size: file?.size ?? 0 };
      }

      @Get("internal-secret")
      @ApiExcludeEndpoint()
      internalOnly() {
        return { secret: true };
      }

      @All("any-verb")
      handleAny() {
        return { any: true };
      }
    }

    @ApiExcludeController()
    @Controller("/hidden")
    class HiddenController {
      @Get()
      index() {
        return { hidden: true };
      }
    }

    @Module({
      controllers: [UsersController, HiddenController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      const config = new DocumentBuilder()
        .setTitle("Bunest Users API")
        .setDescription("OpenAPI 3.1 test specification")
        .setVersion("2.0.0")
        .addServer("https://api.example.com", "Production")
        .addTag("Users", "User management endpoints")
        .addBearerAuth()
        .addApiKey({ name: "X-API-Key" }, "x-api-key")
        .build();

      const doc = SwaggerModule.createDocument(app, config, {
        extraModels: [ExtraStandaloneDto],
      });

      expect(doc.openapi).toBe("3.1.0");
      expect(doc.info.title).toBe("Bunest Users API");
      expect(doc.info.version).toBe("2.0.0");
      expect(doc.servers).toEqual([
        { url: "https://api.example.com", description: "Production" },
      ]);
      expect(doc.components?.securitySchemes).toEqual({
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "x-api-key": { type: "apiKey", in: "header", name: "X-API-Key" },
      });

      // Exclusions honored
      expect(doc.paths["/hidden"]).toBeUndefined();
      expect(doc.paths["/users/internal-secret"]).toBeUndefined();

      // POST /users
      const createOp = doc.paths["/users"]?.post;
      expect(createOp).toBeDefined();
      expect(createOp?.tags).toEqual(["Users"]);
      expect(createOp?.summary).toBe("Create a user");
      expect(createOp?.security).toEqual([{ bearer: [] }]);
      expect(
        createOp?.requestBody?.content["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/CreateUserDto" });
      expect(
        createOp?.responses["201"]?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/UserResponseDto" });
      expect(createOp?.responses["400"]?.description).toBe("Validation error");

      // GET /users/{id} (regex constraint converted to OpenAPI template!)
      const findOneOp = doc.paths["/users/{id}"]?.get;
      expect(findOneOp).toBeDefined();
      const idParam = findOneOp?.parameters?.find((p) => p.name === "id");
      expect(idParam).toMatchObject({
        name: "id",
        in: "path",
        required: true,
        description: "Numeric user ID",
        schema: { type: "integer" },
      });
      const expandParam = findOneOp?.parameters?.find(
        (p) => p.name === "expand",
      );
      expect(expandParam).toMatchObject({
        name: "expand",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["address", "roles"] },
      });
      const tenantHeader = findOneOp?.parameters?.find(
        (p) => p.name === "X-Tenant-Id",
      );
      expect(tenantHeader).toMatchObject({
        name: "X-Tenant-Id",
        in: "header",
        required: true,
      });

      // Multipart file upload endpoint
      const uploadOp = doc.paths["/users/avatar"]?.post;
      expect(
        uploadOp?.requestBody?.content["multipart/form-data"]?.schema,
      ).toEqual({
        type: "object",
        properties: {
          avatar: { type: "string", format: "binary" },
        },
      });
      expect(uploadOp?.responses["200"]).toBeDefined();

      // Array response & merged method + controller security
      const authorsOp = doc.paths["/users/authors"]?.get;
      expect(
        authorsOp?.responses["200"]?.content?.["application/json"]?.schema,
      ).toEqual({
        type: "array",
        items: { $ref: "#/components/schemas/AuthorDto" },
      });
      expect(authorsOp?.security).toEqual([{ bearer: [] }, { "x-api-key": [] }]);

      // Schemas: DTO properties + class-validator hints + nested DTO + inheritance + OpenAPI 3.1 nullable
      const schemas = doc.components?.schemas ?? {};
      expect(schemas.CreateUserDto?.properties?.email).toMatchObject({
        type: "string",
        format: "email",
        description: "User email address",
        example: "ada@bun.sh",
      });
      expect(schemas.CreateUserDto?.properties?.name).toMatchObject({
        type: "string",
        minLength: 2,
      });
      expect(schemas.CreateUserDto?.properties?.age).toMatchObject({
        type: "integer",
        minimum: 13,
        maximum: 120,
      });
      expect(schemas.CreateUserDto?.properties?.role).toMatchObject({
        enum: ["admin", "member"],
      });
      expect(schemas.CreateUserDto?.properties?.address).toEqual({
        $ref: "#/components/schemas/AddressDto",
      });
      expect(schemas.CreateUserDto?.required).toContain("email");
      expect(schemas.CreateUserDto?.required).toContain("name");
      expect(schemas.CreateUserDto?.required).not.toContain("age");

      // OpenAPI 3.1 nullable primitive
      expect(schemas.AddressDto?.properties?.zipCode).toMatchObject({
        type: ["string", "null"],
      });

      // DTO inheritance (UserResponseDto inherits BaseEntityDto.id without mutating BaseEntityDto)
      expect(schemas.UserResponseDto?.properties?.id).toMatchObject({
        type: "string",
        format: "uuid",
        readOnly: true,
      });
      expect(schemas.UserResponseDto?.properties?.email).toBeDefined();

      // Self-circular DTO (TreeNodeDto) with OpenAPI 3.1 nullable $ref preserving sibling metadata
      expect(schemas.TreeNodeDto?.properties?.parent).toEqual({
        description: "Parent tree node",
        deprecated: true,
        anyOf: [{ $ref: "#/components/schemas/TreeNodeDto" }, { type: "null" }],
      });
      expect(schemas.TreeNodeDto?.properties?.children).toEqual({
        type: "array",
        items: { $ref: "#/components/schemas/TreeNodeDto" },
      });

      // @All() expanded operations MUST have unique operationIds per HTTP method
      const anyVerbItem = doc.paths["/users/any-verb"];
      expect(anyVerbItem).toBeDefined();
      const expandedOpIds = [
        anyVerbItem?.get?.operationId,
        anyVerbItem?.post?.operationId,
        anyVerbItem?.put?.operationId,
        anyVerbItem?.patch?.operationId,
        anyVerbItem?.delete?.operationId,
      ];
      expect(new Set(expandedOpIds).size).toBe(5);
      expect(expandedOpIds).toEqual([
        "UsersController_handleAny_get",
        "UsersController_handleAny_post",
        "UsersController_handleAny_put",
        "UsersController_handleAny_patch",
        "UsersController_handleAny_delete",
      ]);

      // Mutually circular DTOs (AuthorDto <-> BookDto)
      expect(schemas.AuthorDto?.properties?.books).toEqual({
        type: "array",
        items: { $ref: "#/components/schemas/BookDto" },
      });
      expect(schemas.BookDto?.properties?.author).toEqual({
        $ref: "#/components/schemas/AuthorDto",
      });

      // extraModels registered
      expect(schemas.ExtraStandaloneDto?.properties?.code).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
