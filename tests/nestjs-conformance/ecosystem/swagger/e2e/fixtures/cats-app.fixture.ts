import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from "../../../../../../packages/common/src";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCallbacks,
  ApiConsumes,
  ApiDefaultGetter,
  ApiExtension,
  ApiExtraModels,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiSchema,
  ApiSecurity,
  ApiTags,
  getSchemaPath,
  type StandardJSONSchemaV1,
} from "../../../../../../packages/swagger/src";

export function makeStandardSchema(
  schema: Record<string, unknown>,
  vendor = "zod",
): StandardJSONSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  } as unknown as StandardJSONSchemaV1;
}

export enum CatBreed {
  Persian = "persian",
  Siamese = "siamese",
  MaineCoon = "maine-coon",
}

export enum XEnumTest {
  APPROVED = 1,
  PENDING,
  REJECTED,
}

export enum LettersEnum {
  A = "A",
  B = "B",
  C = "C",
}

export class TagDto {
  @ApiProperty({ description: "name" })
  name!: string;
}

@ApiSchema({
  name: "ExtraModel",
  description: "ExtraModel description",
})
export class ExtraModelDto {
  @ApiProperty()
  readonly one!: string;

  @ApiProperty()
  readonly two!: number;
}

export class ValidationErrorDto {
  @ApiProperty({
    type: "number",
    description: "HTTP status code",
  })
  status!: number;

  @ApiProperty({
    type: "string",
    description: "Error description",
  })
  description!: string;
}

export class CatCreatedEvent {
  @ApiProperty({ description: "The name of the created Cat" })
  name!: string;
}

@ApiExtension("x-schema-extension", { test: "test" })
@ApiExtension("x-schema-extension-multiple", { test: "test*2" })
export class Cat {
  @ApiProperty({ example: "Kitty", description: "The name of the Cat" })
  name!: string;

  @ApiProperty({ example: 1, minimum: 0, description: "The age of the Cat" })
  age!: number;

  @ApiProperty({
    example: "Maine Coon",
    description: "The breed of the Cat",
  })
  breed!: string;

  @ApiProperty({
    name: "_tags",
    type: [String],
  })
  tags?: string[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    type: String,
    isArray: true,
  })
  urls?: string[];

  @ApiProperty({
    name: "_options",
    type: "array",
    items: {
      type: "object",
      properties: {
        isReadonly: {
          type: "string",
        },
      },
    },
  })
  options?: Record<string, any>[];

  @ApiProperty({
    type: "object",
    properties: {
      name: {
        type: "string",
        example: "ErrorName",
      },
      status: {
        type: "number",
        example: 400,
      },
    },
    required: ["name", "status"],
    selfRequired: true,
  })
  rawDefinition!: Record<string, any>;

  @ApiProperty({
    type: "object",
    additionalProperties: { type: "boolean" },
    selfRequired: false,
  })
  optionalRawDefinition?: Record<string, boolean>;

  @ApiProperty({
    enum: LettersEnum,
  })
  enum!: LettersEnum;

  @ApiProperty({
    enum: LettersEnum,
    isArray: true,
  })
  enumArr!: LettersEnum[];

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
    description: "A small assortment of letters?",
    default: "A",
    deprecated: true,
  })
  enumWithRef!: LettersEnum;

  @ApiProperty({
    oneOf: [
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "number" } },
      { type: "array", items: { type: "boolean" } },
    ],
    description: 'Array of values that uses "oneOf"',
  })
  oneOfExample?: string[] | number[] | boolean[];

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
    oneOf: [{ type: "string" }, { type: "number" }],
    description: "Enum named reference combined with oneOf combinators",
  })
  enumNamedWithOneOf?: LettersEnum | string | number;

  @ApiProperty({ type: [String], link: () => Cat })
  kittenIds?: string[];
}

@ApiExtraModels(ExtraModelDto)
@ApiExtension("x-tags", ["foo", "bar"])
export class CreateCatDto {
  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ minimum: 1, maximum: 200 })
  readonly age!: number;

  @ApiProperty({ name: "_breed", type: String })
  readonly breed!: string;

  @ApiProperty({
    format: "uri",
    type: [String],
  })
  readonly tags?: string[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    type: "string",
    isArray: true,
  })
  readonly urls?: string[];

  @ApiProperty({
    type: "array",
    items: {
      type: "object",
      properties: {
        isReadonly: {
          type: "string",
        },
      },
    },
  })
  readonly options?: Record<string, any>[];

  @ApiProperty({
    type: "object",
    properties: {
      name: {
        type: "string",
        example: "ErrorName",
      },
      status: {
        type: "number",
        example: 400,
      },
    },
    required: ["name", "status"],
    selfRequired: true,
  })
  rawDefinition!: Record<string, any>;

  @ApiProperty({
    description: "Enum with description",
  })
  readonly enumWithDescription!: LettersEnum;

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
  })
  readonly enum!: LettersEnum;

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
    isArray: true,
    description: "This is a description for the enumArr attribute",
  })
  readonly enumArr!: LettersEnum[];

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
    description: "A small assortment of letters (in DTO)?",
    default: "A",
    deprecated: true,
    enumSchema: {
      description: "This is a description for the LettersEnum schema",
      deprecated: true,
    },
  })
  readonly enumWithRef!: LettersEnum;

  @ApiProperty({ description: "tag", required: false })
  readonly tag!: TagDto;

  @ApiProperty({
    description: "nullable tag",
    nullable: true,
    type: () => TagDto,
  })
  readonly nullableTag!: TagDto;

  @ApiProperty({
    description: "nullable primitive union",
    nullable: true,
    oneOf: [{ type: "string" }, { type: "number" }],
  })
  readonly nullablePrimitiveUnion!: string | number | null;

  @ApiProperty({
    description: "nullable primitive",
    type: String,
    nullable: true,
  })
  readonly nullablePrimitive!: string | null;

  @ApiProperty({
    description: "nullable enum",
    enum: LettersEnum,
    nullable: true,
  })
  readonly nullableEnum!: LettersEnum | null;

  nested!: {
    first: string;
    second: number;
  };

  @ApiProperty({
    description: "The x-enumNames test",
    enum: XEnumTest,
    enumName: "XEnumTest",
    "x-enumNames": ["APPROVED", "PENDING", "REJECTED"],
  })
  xEnumTest!: XEnumTest;
}

export class PaginationQuery {
  @ApiProperty({
    minimum: 0,
    maximum: 10000,
    title: "Page",
    exclusiveMaximum: true,
    exclusiveMinimum: true,
    format: "int32",
    default: 0,
    example: 123,
  })
  page!: number;

  @ApiProperty({
    name: "_sortBy",
    nullable: true,
    example: ["sort1", "sort2"],
    type: [String],
  })
  sortBy!: string[];

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    oneOf: [
      {
        minimum: 0,
        maximum: 10,
        format: "int32",
      },
      {
        minimum: 100,
        maximum: 100,
        format: "int32",
      },
    ],
  })
  constrainedLimit?: number;

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
  })
  enum!: LettersEnum;

  @ApiProperty({
    enum: LettersEnum,
    enumName: "LettersEnum",
    isArray: true,
  })
  enumArr!: LettersEnum[];

  @ApiProperty({
    enum: LettersEnum,
    enumName: "Letter",
    isArray: true,
  })
  letters!: LettersEnum[];

  @ApiProperty()
  beforeDate!: Date;

  @ApiProperty({
    type: "object",
    properties: {
      name: {
        type: "string",
      },
      age: {
        type: "number",
      },
    },
    additionalProperties: true,
  })
  filter!: Record<string, any>;

  @ApiProperty({
    required: false,
    externalDocs: { url: "https://example.com/docs/pagination" },
  })
  cursor?: string;

  static _OPENAPI_METADATA_FACTORY() {
    return {
      sortBy: { type: () => [String] },
      strArray: { required: true, type: () => [String] },
      raw: {
        required: true,
        type: () => ({ foo: { required: true, type: () => String } }),
      },
      rawArray: {
        required: false,
        type: () => [{ foo: { required: true, type: () => String } }],
      },
    };
  }
}

const standardBodySchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "Cat name from Zod",
        example: "Milo",
      },
      age: { type: "integer", minimum: 1 },
      breed: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name", "age", "breed"],
  },
  "zod",
);

const standardBodyRichSchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      species: {
        type: "string",
        enum: ["cat", "dog"],
        title: "Species",
        description: "Species enum from Zod",
        example: "cat",
      },
      contact: {
        title: "PreferredContact",
        description: "Preferred contact from Zod",
        example: "owner@example.com",
        anyOf: [
          { type: "string", format: "email" },
          {
            type: "object",
            properties: {
              phone: {
                type: "string",
                description: "Phone number from Zod",
                example: "123-456",
              },
            },
            required: ["phone"],
          },
        ],
      },
      profile: {
        type: "object",
        title: "CatProfile",
        description: "Nested cat profile from Zod",
        properties: {
          nickname: {
            type: "string",
            description: "Nested nickname from Zod",
            example: "Captain Whiskers",
          },
          temperament: {
            type: "string",
            enum: ["playful", "calm"],
            description: "Nested temperament from Zod",
            example: "playful",
          },
          notes: {
            type: "string",
            default: "Indoor only",
            description: "Nested notes from Zod",
            example: "Indoor only",
            deprecated: true,
          },
          traits: {
            type: "array",
            description: "Nested trait list from Zod",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Trait label from Zod",
                  example: "affectionate",
                },
                score: {
                  type: "number",
                  minimum: 0,
                  maximum: 10,
                  description: "Trait score from Zod",
                  example: 8,
                },
              },
              required: ["label", "score"],
            },
          },
        },
        required: ["nickname", "temperament", "notes", "traits"],
      },
    },
    required: ["species", "contact", "profile"],
  },
  "zod",
);

const standardBodyConflictSchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      override: {
        type: "string",
        description: "Body override from Zod",
        example: "zod-body",
      },
      count: { type: "integer", minimum: 1 },
    },
    required: ["override", "count"],
  },
  "zod",
);

const standardQuerySchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      page: { type: "number", description: "Page number from Valibot" },
      search: { type: "string", title: "Search term" },
    },
    required: ["page"],
  },
  "valibot",
);

const standardQueryRichSchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["simple", "advanced"],
        description: "Mode enum from Valibot",
        example: "simple",
      },
      filter: {
        title: "FilterTitle",
        description: "Filter union from Valibot",
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              nested: {
                type: "string",
                description: "Nested filter from Valibot",
                example: "persian",
              },
            },
            required: ["nested"],
          },
        ],
      },
      details: {
        type: "object",
        title: "Details title from Valibot",
        description: "Nested details from Valibot",
        properties: {
          label: {
            type: "string",
            description: "Nested label from Valibot",
            example: "primary",
          },
          flags: {
            type: "array",
            title: "Flag list from Valibot",
            items: { type: "boolean" },
          },
        },
        required: ["label", "flags"],
      },
    },
    required: ["mode", "filter", "details"],
  },
  "valibot",
);

const standardQueryConflictSchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      filter: {
        type: "integer",
        minimum: 1,
        description: "Query override from Zod",
        example: 3,
      },
      active: {
        type: "boolean",
        description: "Boolean flag from Zod",
        example: true,
      },
    },
    required: ["filter", "active"],
  },
  "zod",
);

const standardParamSchema = makeStandardSchema(
  {
    type: "string",
    minLength: 3,
    pattern: "^cat_[0-9]+$",
    description: "Cat identifier from Zod",
  },
  "zod",
);

const standardParamRichSchema = makeStandardSchema(
  {
    type: "string",
    enum: ["available", "resting"],
    title: "CatState",
    description: "Cat state enum from Zod",
    example: "available",
  },
  "zod",
);

const standardParamConflictSchema = makeStandardSchema(
  {
    type: "string",
    enum: ["available", "resting"],
    description: "Param override from Zod",
    example: "resting",
  },
  "zod",
);

const standardResponseRichSchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["available", "resting"],
        title: "CatResponseState",
        description: "Response status enum from Zod",
        example: "available",
      },
      result: {
        title: "StandardResponseResult",
        description: "Response union from Zod",
        example: { kind: "message", message: "No cat available" },
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["cat"] },
              cat: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Returned cat name from Zod",
                    example: "Milo",
                  },
                },
                required: ["name"],
              },
            },
            required: ["kind", "cat"],
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["message"] },
              message: {
                type: "string",
                description: "Returned message from Zod",
                example: "No cat available",
              },
            },
            required: ["kind", "message"],
          },
        ],
      },
      meta: {
        type: "object",
        title: "ResponseMeta",
        description: "Nested response metadata from Zod",
        properties: {
          source: {
            type: "string",
            description: "Nested response source from Zod",
            example: "cache",
          },
          tags: {
            type: "array",
            description: "Response tags from Zod",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Response tag label from Zod",
                  example: "featured",
                },
              },
              required: ["label"],
            },
          },
        },
        required: ["source", "tags"],
      },
    },
    required: ["status", "result", "meta"],
  },
  "zod",
);

const standardResponseConflictSchema = makeStandardSchema(
  {
    type: "object",
    properties: {
      result: {
        type: "string",
        description: "Response override from Zod",
        example: "ok",
      },
      count: { type: "integer", minimum: 1 },
    },
    required: ["result", "count"],
  },
  "zod",
);

@Injectable()
export class CatsService {
  private readonly cats: Cat[] = [];

  create(cat: CreateCatDto): Cat {
    this.cats.push(cat as unknown as Cat);
    return cat as unknown as Cat;
  }

  findOne(id: number): Cat {
    return this.cats[id] as Cat;
  }
}

@ApiSecurity("basic")
@ApiBearerAuth()
@ApiSecurity({ key2: [], key1: [] })
@ApiTags("cats")
@ApiHeader({
  name: "header",
  required: false,
  description: "Test",
  schema: { default: "test" },
  example: "test",
})
@ApiExtension("x-foo", { "from-controller": true })
@Controller("cats")
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @ApiCallbacks({
    name: "catCreated",
    callbackUrl: "{$request.body#/callbackUrl}",
    method: "post",
    requestBody: { type: CatCreatedEvent },
    expectedResponse: { status: 200 },
  })
  @ApiCallbacks({
    name: "mySecondEvent",
    callbackUrl: "{$request.body#/callbackUrl}",
    method: "post",
    requestBody: { type: Cat },
    expectedResponse: { status: 200 },
  })
  @ApiCallbacks({
    name: "myEvent",
    callbackUrl: "{$request.body#/callbackUrl}",
    method: "post",
    requestBody: { type: Cat },
    expectedResponse: { status: 200 },
  })
  @ApiTags("create cats")
  @Post()
  @ApiOperation({ summary: "Create cat" })
  @ApiResponse({
    status: 201,
    description: "The record has been successfully created.",
    type: () => Cat,
  })
  @ApiResponse({ status: 403, description: "Forbidden." })
  @ApiExtension("x-foo", { "from-method": "bar" })
  async create(@Body() createCatDto: CreateCatDto): Promise<Cat> {
    return this.catsService.create(createCatDto);
  }

  @Post("explicit-body")
  @ApiBody({
    type: CreateCatDto,
    examples: {
      mau: {
        summary: "Mau example",
        value: { name: "Mau cat", age: 5, breed: "Mau" },
      },
    },
  })
  async createExplicitBody(@Body() createCatDto: CreateCatDto): Promise<Cat> {
    return this.catsService.create(createCatDto);
  }

  @Post("standard-body")
  async createWithStandardBody(
    @Body({ schema: standardBodySchema } as any)
    createCatDto: CreateCatDto,
  ): Promise<Cat> {
    return this.catsService.create(createCatDto);
  }

  @Post("standard-body-rich")
  async createWithRichStandardBody(
    @Body({ schema: standardBodyRichSchema } as any)
    createCatDto: CreateCatDto,
  ): Promise<Cat> {
    return this.catsService.create(createCatDto);
  }

  @Post("standard-body-conflict")
  @ApiBody({
    type: TagDto,
    description: "Explicit body decorator metadata",
    required: false,
    examples: {
      legacy: {
        summary: "Explicit body example",
        value: { legacy: true },
      },
    },
  })
  async createWithConflictingStandardBody(
    @Body({ schema: standardBodyConflictSchema } as any)
    createCatDto: CreateCatDto,
  ): Promise<Cat> {
    return this.catsService.create(createCatDto);
  }

  @Get(":id")
  @ApiResponse({
    status: 200,
    description: "The found record",
    type: Cat,
  })
  @ApiExtension("x-auth-type", "NONE")
  @ApiDefaultGetter(Cat, "id")
  findOne(@Param("id") id: string): Cat {
    return this.catsService.findOne(+id);
  }

  @Get()
  @ApiExtension("x-codeSamples", [
    { lang: "JavaScript", source: "console.log('Hello World');" },
  ])
  @ApiExtension("x-multiple", { test: "test" })
  @ApiQuery({
    name: "catBreeds",
    enum: CatBreed,
    isArray: true,
  })
  @ApiTags("tag1")
  @ApiTags("tag2")
  findAll(@Query() _paginationQuery: PaginationQuery) {}

  @ApiQuery({ type: PaginationQuery })
  @Get("explicit-query")
  findAllWithExplicitQuery(_paginationQuery: PaginationQuery) {}

  @Get("standard-query")
  findAllWithStandardQuery(
    @Query({ schema: standardQuerySchema } as any)
    _query: PaginationQuery,
  ) {}

  @Get("standard-query-rich")
  findAllWithRichStandardQuery(
    @Query({ schema: standardQueryRichSchema } as any)
    _query: PaginationQuery,
  ) {}

  @Get("standard-query-conflict")
  @ApiQuery({
    name: "filter",
    type: String,
    required: false,
    description: "Explicit query decorator description",
  })
  findAllWithConflictingStandardQuery(
    @Query({ schema: standardQueryConflictSchema } as any)
    _query: PaginationQuery,
  ) {}

  @Get("bulk")
  findAllBulk(@Query() _paginationQuery: PaginationQuery[]) {}

  @Post("bulk")
  async createBulk(@Body() _createCatDto: CreateCatDto[]): Promise<Cat | null> {
    return null;
  }

  @ApiConsumes("application/x-www-form-urlencoded")
  @Post("as-form-data")
  @ApiOperation({ summary: "Create cat" })
  @ApiResponse({
    status: 201,
    description: "The record has been successfully created.",
    type: Cat,
  })
  @ApiResponse({ status: 403, description: "Forbidden." })
  async createAsFormData(@Body() createCatDto: CreateCatDto): Promise<Cat> {
    return this.catsService.create(createCatDto);
  }

  @Get("wildcard/*")
  getWildcard() {}

  @Get("with-enum/:type")
  @ApiParam({
    name: "type",
    enum: LettersEnum,
  })
  getWithEnumParam(@Param("type") _type: LettersEnum) {}

  @Get("standard-param/:id")
  getWithStandardParam(
    @Param("id", { schema: standardParamSchema } as any)
    _id: string,
  ) {}

  @Get("standard-param-rich/:state")
  getWithRichStandardParam(
    @Param("state", { schema: standardParamRichSchema } as any)
    _state: string,
  ) {}

  @Get("standard-param-conflict/:state")
  @ApiParam({
    name: "state",
    type: String,
    description: "Explicit param decorator description",
  })
  getWithConflictingStandardParam(
    @Param("state", { schema: standardParamConflictSchema } as any)
    _state: string,
  ) {}

  @Get("standard-response")
  @ApiResponse({
    status: 200,
    standardSchema: standardResponseRichSchema,
    description: "Standard schema response override",
  })
  getWithStandardResponse(): Cat {
    return this.catsService.findOne(1);
  }

  @Get("standard-response-conflict")
  @ApiResponse({
    status: 200,
    type: Number,
    description: "Standard schema response conflict override",
    examples: {
      legacy: {
        summary: "Decorator response example",
        value: { legacy: true },
      },
    },
    standardSchema: standardResponseConflictSchema,
  })
  getWithConflictingStandardResponse(): Cat {
    return this.catsService.findOne(1);
  }

  @Get("with-enum-named/:type")
  @ApiParam({
    name: "type",
    enum: LettersEnum,
    enumName: "Letter",
    enumSchema: {
      description: "This is a description for the Letters schema",
      deprecated: true,
    },
    description: "This is a description for 'type' query parameter",
    deprecated: false,
  })
  getWithEnumNamedParam(@Param("type") _type: LettersEnum) {}

  @Get("with-named-type-example")
  @ApiQuery({
    name: "filter",
    type: TagDto,
    example: "example-tag",
  })
  getWithNamedTypeExample(@Query("filter") _filter: TagDto) {}

  @Get("with-random-query")
  @ApiQuery({
    name: "type",
    type: String,
    minLength: 10,
    maxLength: 100,
  })
  @ApiQuery({
    name: "filter",
    required: false,
    content: {
      "application/json": {
        schema: { type: "string" },
      },
    },
  })
  getWithRandomQuery(@Query("type") _type: string) {}

  @Get("download")
  @ApiOperation({
    responses: {
      "200": {
        description: "binary file for download",
        content: {
          "application/pdf": { schema: { type: "string", format: "binary" } },
          "image/jpeg": { schema: { type: "string", format: "binary" } },
        },
      },
    },
  })
  download() {}

  @Get("raw-schema-response")
  @ApiResponse({
    status: HttpStatus.OK,
    description: "The paginated response",
    schema: {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { $ref: getSchemaPath(Cat) },
        },
        pageInfo: {
          type: "object",
          properties: {
            hasPreviousPage: { type: "boolean" },
            hasNextPage: { type: "boolean" },
            startCursor: { type: "string" },
            endCursor: { type: "string" },
          },
        },
      },
    },
  })
  rawSchemaResponse() {}

  @Get("scalar-with-example")
  @ApiResponse({ status: 200, type: Number, example: 42 })
  scalarWithExample(): number {
    return 42;
  }

  @Get("scalar-with-examples")
  @ApiResponse({
    status: 200,
    type: Number,
    examples: {
      adult: { value: 5, summary: "Adult cat age" },
      kitten: { value: 1, summary: "Kitten age" },
    },
  })
  scalarWithExamples(): number {
    return 5;
  }

  @Get("array-of-scalar-with-example")
  @ApiResponse({
    status: 200,
    type: String,
    isArray: true,
    example: ["Mau", "Persian"],
  })
  arrayOfScalarWithExample(): string[] {
    return ["Mau", "Persian"];
  }

  @Get("date-response")
  @ApiResponse({ status: 200, type: Date })
  dateResponse(): Date {
    return new Date();
  }

  @Post("date-body")
  @ApiBody({ type: Date })
  dateBody(@Body() date: Date): Date {
    return date;
  }

  @Get("nullable-schema-response")
  @ApiResponse({
    status: 200,
    schema: { type: "object", properties: { name: { type: "string" } } },
    nullable: true,
  })
  nullableSchemaResponse() {
    return null;
  }
}

@Module({
  controllers: [CatsController],
  providers: [CatsService],
})
export class CatsModule {}

@Controller({
  version: ["1", "2"],
})
export class AppController {
  @Get()
  getHello(): string {
    return "Hello world!";
  }

  @Get(["alias1", "alias2"])
  withAliases(): string {
    return "Hello world!";
  }
}

@Controller({
  version: ["1", "2"],
})
export class ExpressController {
  @Get("express\\:colon\\:another/:prop")
  withColons(): string {
    return "Hello world!";
  }
}

@Module({
  imports: [CatsModule],
  controllers: [AppController],
})
export class ApplicationModule {}

@Module({
  imports: [ApplicationModule],
  controllers: [ExpressController],
})
export class FullSwaggerAppModule {}
