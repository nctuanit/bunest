import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  IsEmail,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
  validate,
} from "class-validator";
import { Type as TransformType, plainToInstance } from "class-transformer";
import {
  applyDecorators,
  BODY_SANITIZED_SYMBOL,
  Controller,
  FileTypeValidator,
  FileValidator,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  IntersectionType,
  isStandardSchema,
  MaxFileSizeValidator,
  METADATA_KEYS,
  MetadataRegistry,
  OmitType,
  Optional,
  ParseDatePipe,
  ParseFilePipe,
  ParseIntPipe,
  PartialType,
  PickType,
  RawBody,
  registerMappedTypeMetadataHook,
  Scope,
  SetMetadata,
  StreamableFile,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
  VersioningType,
  detectMagicMimeType,
  type BunestApplicationOptions,
  type CanActivate,
  type MicroserviceInstance,
  type StandardSchemaV1,
  type StaticAssetsOptions,
  type UploadedFileInfo,
  type VersioningOptions,
} from "../src";

const SWAGGER_API_PROPERTIES = Symbol.for("bunest:swagger:api_properties");

function makeUploadedFile(
  bytes: Uint8Array,
  mimetype: string,
  originalname = "file.bin",
  fieldname = "file",
): UploadedFileInfo {
  const file = new File([bytes], originalname, { type: mimetype });
  return {
    fieldname,
    originalname,
    mimetype,
    size: bytes.byteLength,
    buffer: bytes,
    file,
  };
}

class GuardOne implements CanActivate {
  canActivate() {
    return true;
  }
}

class GuardTwo implements CanActivate {
  canActivate() {
    return true;
  }
}

describe("applyDecorators()", () => {
  it("composes class, method, property, and parameter decorators without mutating inputs", () => {
    const PROP_TAG = Symbol("prop:tag");
    const PARAM_TAG = Symbol("param:tag");
    const TOKEN = Symbol("TOKEN");

    const PropTag =
      (tag: string): PropertyDecorator =>
      (target, propertyKey) => {
        MetadataRegistry.prependOwnArray(PROP_TAG, [tag], target, propertyKey);
      };

    const ParamTag =
      (tag: string): ParameterDecorator =>
      (target, propertyKey, index) => {
        if (propertyKey !== undefined) {
          MetadataRegistry.prependOwnArray(
            PARAM_TAG,
            [`${index}:${tag}`],
            target,
            propertyKey,
          );
        }
      };

    const classDecList = [
      Controller("orders"),
      UseGuards(GuardOne),
      UseGuards(GuardTwo),
      SetMetadata("feature", "orders"),
      Version("1"),
    ];
    const OrdersControllerMeta = applyDecorators(...classDecList);
    // Mutating caller's input array afterwards must have zero effect
    classDecList.push(SetMetadata("mutated", true));

    const ReadEndpoint = applyDecorators(
      Get("list"),
      HttpCode(202),
      Header("X-First", "1"),
      Header("X-Second", "2"),
      UseGuards(GuardOne),
      UseGuards(GuardTwo),
      Version(["1", "2"]),
    );

    const TaggedField = applyDecorators(PropTag("first"), PropTag("second"));
    const OptionalInjectedToken = applyDecorators(Inject(TOKEN), Optional());
    const RawTaggedParam = applyDecorators(RawBody(ParseIntPipe), ParamTag("raw"));

    @OrdersControllerMeta
    class OrdersController {
      @TaggedField
      title!: string;

      constructor(@OptionalInjectedToken public readonly dep?: unknown) {}

      @ReadEndpoint
      list(@RawTaggedParam payload: unknown) {
        return payload;
      }
    }

    expect(
      MetadataRegistry.get(METADATA_KEYS.CONTROLLER, OrdersController),
    ).toEqual({ path: "orders" });
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.GUARDS, OrdersController),
    ).toEqual([GuardOne, GuardTwo]);
    expect(MetadataRegistry.get("feature", OrdersController)).toBe("orders");
    expect(MetadataRegistry.get("mutated", OrdersController)).toBeUndefined();
    expect(
      MetadataRegistry.get(METADATA_KEYS.VERSION, OrdersController),
    ).toBe("1");

    expect(MetadataRegistry.getControllerRoutes(OrdersController)).toEqual([
      { method: "GET", path: "list", handlerKey: "list" },
    ]);
    expect(
      MetadataRegistry.get(
        METADATA_KEYS.HTTP_CODE,
        OrdersController.prototype.list,
      ),
    ).toBe(202);
    expect(
      MetadataRegistry.getHeaders(OrdersController.prototype.list),
    ).toEqual([
      { name: "X-First", value: "1" },
      { name: "X-Second", value: "2" },
    ]);
    expect(
      MetadataRegistry.get(METADATA_KEYS.GUARDS, OrdersController.prototype.list),
    ).toEqual([GuardOne, GuardTwo]);
    expect(
      MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        OrdersController.prototype.list,
      ),
    ).toEqual(["1", "2"]);

    expect(
      MetadataRegistry.get(PROP_TAG, OrdersController.prototype, "title"),
    ).toEqual(["first", "second"]);

    expect(MetadataRegistry.getInjectTokens(OrdersController)).toEqual([
      { index: 0, token: TOKEN },
    ]);
    expect(MetadataRegistry.getOptionalDeps(OrdersController)).toEqual([0]);

    const params = MetadataRegistry.getRouteParameters(OrdersController, "list");
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      index: 0,
      source: "rawBody",
      pipes: [ParseIntPipe],
    });
    expect(
      MetadataRegistry.get(PARAM_TAG, OrdersController.prototype, "list"),
    ).toEqual(["0:raw"]);
  });

  it("propagates replaced descriptors and replaced class constructors", () => {
    const WrapReturn =
      (suffix: string): MethodDecorator =>
      <T>(
        _target: object,
        _key: string | symbol,
        descriptor: TypedPropertyDescriptor<T>,
      ) => {
        const original = descriptor.value as unknown as (
          ...args: unknown[]
        ) => string;
        return {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]) {
            return `${original.apply(this, args)}:${suffix}`;
          } as unknown as T,
        };
      };

    const Combined = applyDecorators(WrapReturn("outer"), WrapReturn("inner"));

    class Service {
      @Combined
      greet() {
        return "hi";
      }
    }

    expect(new Service().greet()).toBe("hi:inner:outer");
  });
});

describe("API Versioning, @RawBody, BODY_SANITIZED_SYMBOL & Options", () => {
  it("supports VersioningType, VERSION_NEUTRAL, @Version inheritance safety, and @Controller({ version })", () => {
    expect<string>(VersioningType.URI).toBe("uri");
    expect<string>(VersioningType.HEADER).toBe("header");
    expect<string>(VersioningType.MEDIA_TYPE).toBe("media_type");
    expect<string>(VersioningType.CUSTOM).toBe("custom");
    expect<symbol>(VERSION_NEUTRAL).toBe(Symbol.for("bunest:version_neutral"));

    const versionList: Array<string | typeof VERSION_NEUTRAL> = [
      "1",
      VERSION_NEUTRAL,
    ];

    @Controller({ path: "users", version: versionList })
    class BaseUsersController {
      @Get()
      @Version("1")
      findAll() {}
    }

    // Defensive copy: mutating input array must not mutate stored metadata
    versionList.push("99");

    @Controller("users-v2")
    @Version("2")
    class ChildUsersController extends BaseUsersController {
      @Get()
      @Version(["2", "3"])
      override findAll() {}
    }

    expect(
      MetadataRegistry.get(METADATA_KEYS.CONTROLLER, BaseUsersController),
    ).toEqual({ path: "users", version: ["1", VERSION_NEUTRAL] });
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.VERSION, BaseUsersController),
    ).toEqual(["1", VERSION_NEUTRAL]);
    expect(
      MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        BaseUsersController.prototype.findAll,
      ),
    ).toBe("1");

    // Subclass overrides never mutate parent
    expect(
      MetadataRegistry.getOwn(METADATA_KEYS.VERSION, ChildUsersController),
    ).toBe("2");
    expect(
      MetadataRegistry.get(
        METADATA_KEYS.VERSION,
        ChildUsersController.prototype.findAll,
      ),
    ).toEqual(["2", "3"]);

    // Type-level verification of all VersioningOptions variants
    const variants: VersioningOptions[] = [
      { type: VersioningType.URI, prefix: "v", defaultVersion: "1" },
      { type: VersioningType.URI, prefix: false },
      { type: VersioningType.HEADER, header: "X-API-Version" },
      { type: VersioningType.MEDIA_TYPE, key: "v=" },
      {
        type: VersioningType.CUSTOM,
        extractor: (req) => req.headers.get("x-v") ?? "1",
        defaultVersion: VERSION_NEUTRAL,
      },
    ];
    expect(variants).toHaveLength(5);
  });

  it("exports BODY_SANITIZED_SYMBOL, @RawBody, rawBody/StaticAssetsOptions, and durable metadata", () => {
    expect<symbol>(BODY_SANITIZED_SYMBOL).toBe(
      Symbol.for("bunest:http:body_sanitized"),
    );

    @Injectable({ scope: Scope.REQUEST, durable: true })
    class TenantService {}

    @Controller({ path: "webhooks", scope: Scope.REQUEST, durable: true })
    class WebhookController {
      @Get()
      handle(@RawBody() raw: Uint8Array) {
        return raw;
      }
    }

    expect(MetadataRegistry.get(METADATA_KEYS.INJECTABLE, TenantService)).toEqual(
      { scope: Scope.REQUEST, durable: true },
    );
    expect(
      MetadataRegistry.get(METADATA_KEYS.CONTROLLER, WebhookController),
    ).toEqual({ path: "webhooks", scope: Scope.REQUEST, durable: true });
    expect(
      MetadataRegistry.getRouteParameters(WebhookController, "handle"),
    ).toMatchObject([{ index: 0, source: "rawBody" }]);

    const appOpts: BunestApplicationOptions = { rawBody: true };
    const staticOpts: StaticAssetsOptions = {
      prefix: "/assets",
      index: "index.html",
      cacheControl: "public, max-age=3600",
      dotfiles: "deny",
    };
    const ms: MicroserviceInstance = {
      listen: async () => {},
      close: async () => {},
    };
    expect(appOpts.rawBody).toBe(true);
    expect(staticOpts.dotfiles).toBe("deny");
    expect(typeof ms.listen).toBe("function");
  });
});

describe("ParseDatePipe", () => {
  it("parses ISO strings, Date instances, and epoch timestamps while rejecting invalid values", () => {
    const pipe = new ParseDatePipe();
    const iso = "2026-11-20T06:00:00.000Z";
    const parsedIso = pipe.transform(iso);
    expect(parsedIso).toBeInstanceOf(Date);
    expect(parsedIso?.toISOString()).toBe(iso);

    const epoch = 1795154400000;
    const parsedEpoch = pipe.transform(epoch);
    expect(parsedEpoch).toBeInstanceOf(Date);
    expect(parsedEpoch?.getTime()).toBe(epoch);

    const srcDate = new Date(iso);
    const parsedDate = pipe.transform(srcDate);
    expect(parsedDate).toBeInstanceOf(Date);
    expect(parsedDate).not.toBe(srcDate);
    expect(parsedDate?.getTime()).toBe(srcDate.getTime());

    for (const bad of [
      "",
      "   ",
      "not-a-date",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date("invalid"),
      null,
      undefined,
      true,
      {},
    ]) {
      expect(() => pipe.transform(bad)).toThrow(HttpException);
    }

    const optPipe = new ParseDatePipe({
      optional: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(optPipe.transform(undefined)).toBeUndefined();
    expect(optPipe.transform(null)).toBeUndefined();
    try {
      optPipe.transform("bad-date");
      throw new Error("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(422);
    }
  });
});

describe("ParseFilePipe & Built-in File Validators", () => {
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  ]);
  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
  const WEBP_BYTES = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
  const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
  const MP4_BYTES = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]);
  const WAV_BYTES = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  ]);
  const SVG_BYTES = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
  );
  const TEXT_BYTES = new TextEncoder().encode("hello plain text\n");
  const UNKNOWN_BIN = new Uint8Array([0x01, 0x02, 0x00, 0x04, 0x05, 0x06]);

  it("detects magic-byte MIME types across all supported binary & text formats", () => {
    expect(detectMagicMimeType(PNG_BYTES)).toBe("image/png");
    expect(detectMagicMimeType(JPEG_BYTES)).toBe("image/jpeg");
    expect(detectMagicMimeType(GIF_BYTES)).toBe("image/gif");
    expect(detectMagicMimeType(WEBP_BYTES)).toBe("image/webp");
    expect(detectMagicMimeType(PDF_BYTES)).toBe("application/pdf");
    expect(detectMagicMimeType(ZIP_BYTES)).toBe("application/zip");
    expect(detectMagicMimeType(GZIP_BYTES)).toBe("application/gzip");
    expect(detectMagicMimeType(MP4_BYTES)).toBe("video/mp4");
    expect(detectMagicMimeType(MP3_BYTES)).toBe("audio/mpeg");
    expect(detectMagicMimeType(WAV_BYTES)).toBe("audio/wav");
    expect(detectMagicMimeType(SVG_BYTES)).toBe("image/svg+xml");
    expect(detectMagicMimeType(TEXT_BYTES)).toBe("text/plain");
    expect(detectMagicMimeType(UNKNOWN_BIN)).toBeUndefined();
  });

  it("catches spoofed MIME types by default and respects skipMagicNumbersValidation & fallbackToMimetype", async () => {
    const pngValidator = new FileTypeValidator({ fileType: "image/png" });
    const genuinePng = makeUploadedFile(PNG_BYTES, "image/png", "ok.png");
    const spoofedTextAsPng = makeUploadedFile(
      TEXT_BYTES,
      "image/png",
      "evil.png",
    );
    const spoofedPdfAsPng = makeUploadedFile(
      PDF_BYTES,
      "image/png",
      "fake.png",
    );

    expect(await pngValidator.isValid(genuinePng)).toBe(true);
    expect(await pngValidator.isValid(spoofedTextAsPng)).toBe(false);
    expect(await pngValidator.isValid(spoofedPdfAsPng)).toBe(false);
    expect(pngValidator.buildErrorMessage(spoofedPdfAsPng)).toContain(
      "application/pdf",
    );

    // Regex fileType and SVG literal '+' matching
    const imageRegexValidator = new FileTypeValidator({
      fileType: /^image\/(png|jpeg|webp)$/,
    });
    expect(
      await imageRegexValidator.isValid(
        makeUploadedFile(WEBP_BYTES, "image/webp"),
      ),
    ).toBe(true);
    expect(
      await imageRegexValidator.isValid(
        makeUploadedFile(GIF_BYTES, "image/gif"),
      ),
    ).toBe(false);

    const svgValidator = new FileTypeValidator({ fileType: "image/svg+xml" });
    expect(
      await svgValidator.isValid(makeUploadedFile(SVG_BYTES, "image/svg+xml")),
    ).toBe(true);

    // Text-based JSON accepted when bytes are valid UTF-8 and mimetype is application/json
    const jsonValidator = new FileTypeValidator({
      fileType: "application/json",
    });
    expect(
      await jsonValidator.isValid(
        makeUploadedFile(
          new TextEncoder().encode('{"ok":true}'),
          "application/json",
        ),
      ),
    ).toBe(true);

    // Unknown binary rejected unless fallbackToMimetype is enabled
    const unknownFile = makeUploadedFile(
      UNKNOWN_BIN,
      "application/x-custom",
      "data.bin",
    );
    const strictCustom = new FileTypeValidator({
      fileType: "application/x-custom",
    });
    expect(await strictCustom.isValid(unknownFile)).toBe(false);

    const fallbackCustom = new FileTypeValidator({
      fileType: "application/x-custom",
      fallbackToMimetype: true,
    });
    expect(await fallbackCustom.isValid(unknownFile)).toBe(true);

    // skipMagicNumbersValidation trusts header MIME
    const skipMagic = new FileTypeValidator({
      fileType: "image/png",
      skipMagicNumbersValidation: true,
    });
    expect(await skipMagic.isValid(spoofedTextAsPng)).toBe(true);

    // Regression (#111): stateful /g RegExp must not alternate true/false across calls
    const globalRegexValidator = new FileTypeValidator({
      fileType: /image\/png/g,
    });
    expect(await globalRegexValidator.isValid(genuinePng)).toBe(true);
    expect(await globalRegexValidator.isValid(genuinePng)).toBe(true);
    expect(await globalRegexValidator.isValid(genuinePng)).toBe(true);

    // Regression (#111): concurrent async isValid() calls must not clobber buildErrorMessage()
    const sharedValidator = new FileTypeValidator({ fileType: "image/png" });
    const delayedJpeg: UploadedFileInfo = {
      fieldname: "file",
      originalname: "spoof.png",
      mimetype: "image/png",
      size: JPEG_BYTES.byteLength,
      buffer: new Uint8Array(0),
      file: {
        arrayBuffer: async () => {
          await new Promise((r) => setTimeout(r, 15));
          return JPEG_BYTES.buffer.slice(
            JPEG_BYTES.byteOffset,
            JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength,
          );
        },
      } as unknown as File,
    };
    const fastPng = makeUploadedFile(PNG_BYTES, "image/png", "fast.png");
    const [jpegValid, pngValid] = await Promise.all([
      sharedValidator.isValid(delayedJpeg),
      sharedValidator.isValid(fastPng),
    ]);
    expect(jpegValid).toBe(false);
    expect(pngValid).toBe(true);
    expect(sharedValidator.buildErrorMessage(delayedJpeg)).toContain(
      "image/jpeg",
    );
  });

  it("validates single files, file arrays, optional files, MaxFileSizeValidator, and custom async validators", async () => {
    class NonEmptyNameValidator extends FileValidator<{ minLen: number }> {
      async isValid(file?: UploadedFileInfo): Promise<boolean> {
        await Promise.resolve();
        return Boolean(
          file && file.originalname.length >= this.validationOptions.minLen,
        );
      }
      buildErrorMessage(file: UploadedFileInfo): string {
        return `Filename "${file.originalname}" is too short`;
      }
    }

    const pipe = new ParseFilePipe({
      validators: [
        new MaxFileSizeValidator({ maxSize: 32 }),
        new FileTypeValidator({ fileType: /^image\/(png|jpeg)$/ }),
        new NonEmptyNameValidator({ minLen: 5 }),
      ],
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    });

    const goodPng = makeUploadedFile(PNG_BYTES, "image/png", "photo.png");
    const goodJpg = makeUploadedFile(JPEG_BYTES, "image/jpeg", "cover.jpg");
    expect(await pipe.transform(goodPng)).toBe(goodPng);
    expect(await pipe.transform([goodPng, goodJpg])).toEqual([goodPng, goodJpg]);

    // Missing file fails by default
    await expect(pipe.transform(undefined)).rejects.toThrow(HttpException);
    await expect(pipe.transform([])).rejects.toThrow(HttpException);

    // Oversized file fails
    const bigPng = makeUploadedFile(
      new Uint8Array([...PNG_BYTES, ...new Uint8Array(64)]),
      "image/png",
      "large.png",
    );
    try {
      await pipe.transform(bigPng);
      throw new Error("should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(422);
      expect((err as HttpException).message).toContain("32");
    }

    // Spoofed file in array fails
    await expect(
      pipe.transform([goodPng, makeUploadedFile(PDF_BYTES, "image/png", "bad.png")]),
    ).rejects.toThrow(HttpException);

    // Optional file pipe passes undefined and empty arrays through
    const optPipe = new ParseFilePipe({ fileIsRequired: false });
    expect(await optPipe.transform(undefined)).toBeUndefined();
    expect(await optPipe.transform([])).toEqual([]);
  });
});

describe("StreamableFile", () => {
  it("wraps Uint8Array, Blob, and ReadableStream with accurate headers and streams", async () => {
    const bytes = new TextEncoder().encode("streamable-content");
    const fromBytes = new StreamableFile(bytes, {
      type: "text/plain",
      disposition: 'attachment; filename="hello.txt"',
    });
    expect(fromBytes.getHeaders()).toEqual({
      type: "text/plain",
      disposition: 'attachment; filename="hello.txt"',
      length: bytes.byteLength,
    });
    expect(await new Response(fromBytes.getStream()).text()).toBe(
      "streamable-content",
    );

    const blob = new Blob(["blob-body"], { type: "application/json" });
    const fromBlob = new StreamableFile(blob);
    expect(fromBlob.getHeaders()).toEqual({
      type: blob.type,
      length: blob.size,
    });
    expect(fromBlob.getHeaders().type.startsWith("application/json")).toBe(true);
    expect(await new Response(fromBlob.getStream()).text()).toBe("blob-body");

    const rawStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-1"));
        controller.close();
      },
    });
    const fromStream = new StreamableFile(rawStream, { length: 7 });
    expect(fromStream.getStream()).toBe(rawStream);
    expect(fromStream.getHeaders()).toEqual({
      type: "application/octet-stream",
      length: 7,
    });
    expect(await new Response(fromStream.getStream()).text()).toBe("chunk-1");
  });
});

describe("Mapped DTO Types (PartialType, PickType, OmitType, IntersectionType)", () => {
  function ApiProp(options: { required?: boolean; description?: string } = {}): PropertyDecorator {
    return (target, propertyKey) => {
      MetadataRegistry.appendOwnArray(
        SWAGGER_API_PROPERTIES,
        [{ propertyKey: String(propertyKey), ...options }],
        target.constructor,
      );
    };
  }

  class CreateUserDto {
    @ApiProp({ required: true, description: "Full name" })
    @IsString()
    @MinLength(2)
    name!: string;

    @ApiProp({ required: true, description: "Email address" })
    @IsEmail()
    email!: string;

    @ApiProp({ required: true })
    @IsInt()
    @Min(18)
    age!: number;

    @ApiProp({ required: true })
    @IsString()
    @MinLength(8)
    password!: string;
  }

  class AuditMetaDto {
    @ApiProp({ required: true })
    @IsString()
    traceId!: string;
  }

  it("PartialType marks all properties optional while enforcing validators when provided", async () => {
    class UpdateUserDto extends PartialType(CreateUserDto) {}

    // Empty payload is valid
    const emptyErrors = await validate(new UpdateUserDto(), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(emptyErrors).toHaveLength(0);

    // Valid subset passes
    const validSubset = Object.assign(new UpdateUserDto(), {
      email: "ada@example.com",
      age: 30,
    });
    expect(
      await validate(validSubset, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toHaveLength(0);

    // Invalid value fails validation
    const invalidSubset = Object.assign(new UpdateUserDto(), {
      email: "not-an-email",
      age: 12,
    });
    const errs = await validate(invalidSubset);
    expect(errs.map((e) => e.property).sort()).toEqual(["age", "email"]);

    // Original CreateUserDto is untouched (all fields still required!)
    const baseErrs = await validate(new CreateUserDto());
    expect(baseErrs.map((e) => e.property).sort()).toEqual([
      "age",
      "email",
      "name",
      "password",
    ]);

    // Swagger API_PROPERTIES metadata copied with required: false & design:type preserved
    const baseProto = Object.getPrototypeOf(UpdateUserDto) as Function;
    const swaggerProps = MetadataRegistry.getOwn<
      Array<{ propertyKey: string; required?: boolean }>
    >(SWAGGER_API_PROPERTIES, baseProto);
    expect(swaggerProps).toHaveLength(4);
    expect(swaggerProps?.every((p) => p.required === false)).toBe(true);
    expect(MetadataRegistry.getType(UpdateUserDto.prototype, "age")).toBe(Number);
  });

  it("PickType keeps only picked keys and rejects unpicked fields under whitelist", async () => {
    class PublicContactDto extends PickType(CreateUserDto, ["email", "age"]) {}

    const valid = Object.assign(new PublicContactDto(), {
      email: "a@b.com",
      age: 21,
    });
    expect(
      await validate(valid, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0);

    // Unpicked field "password" must be rejected as non-whitelisted
    const withUnpicked = Object.assign(new PublicContactDto(), {
      email: "a@b.com",
      age: 21,
      password: "secretpassword",
    });
    const errs = await validate(withUnpicked, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errs.some((e) => e.property === "password")).toBe(true);
  });

  it("OmitType removes omitted keys and supports composition with PartialType", async () => {
    class SafeUserDto extends OmitType(CreateUserDto, ["password"]) {}

    const valid = Object.assign(new SafeUserDto(), {
      name: "Grace",
      email: "grace@example.com",
      age: 35,
    });
    expect(
      await validate(valid, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0);

    const withPassword = Object.assign(new SafeUserDto(), {
      name: "Grace",
      email: "grace@example.com",
      age: 35,
      password: "should-be-rejected",
    });
    const errs = await validate(withPassword, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errs.some((e) => e.property === "password")).toBe(true);

    // Composition: PartialType(OmitType(...))
    class PatchSafeUserDto extends PartialType(
      OmitType(CreateUserDto, ["password"]),
    ) {}
    expect(
      await validate(Object.assign(new PatchSafeUserDto(), { name: "Lin" }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toHaveLength(0);
    const badPatch = await validate(
      Object.assign(new PatchSafeUserDto(), { password: "secretpassword" }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(badPatch.some((e) => e.property === "password")).toBe(true);
  });

  it("IntersectionType merges fields & metadata from both classes and invokes custom hooks", async () => {
    const seenOps: string[] = [];
    const unregister = registerMappedTypeMetadataHook((ctx) => {
      seenOps.push(`${ctx.operation}:${ctx.source.name}`);
    });

    try {
      class TrackedContactDto extends IntersectionType(
        PickType(CreateUserDto, ["email"]),
        AuditMetaDto,
      ) {}

      const missingTrace = Object.assign(new TrackedContactDto(), {
        email: "ops@example.com",
      });
      const errs = await validate(missingTrace);
      expect(errs.map((e) => e.property)).toEqual(["traceId"]);

      const complete = Object.assign(new TrackedContactDto(), {
        email: "ops@example.com",
        traceId: "trace-123",
      });
      expect(
        await validate(complete, {
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      ).toHaveLength(0);
      expect(seenOps).toContain("intersection:AuditMetaDto");
    } finally {
      unregister();
    }
  });

  it("clones class-transformer @Type() nested metadata and makes @ValidateIf() fields optional in PartialType (Regression #111)", async () => {
    class AddressDto {
      @IsString()
      city!: string;
    }

    class UserWithNestedDto {
      @IsString()
      mode!: string;

      @ValidateIf((o: UserWithNestedDto) => o.mode === "strict")
      @IsString()
      code!: string;

      @ValidateNested()
      @TransformType(() => AddressDto)
      address!: AddressDto;
    }

    class PartialUserWithNestedDto extends PartialType(UserWithNestedDto) {}

    // 1. @Type(() => AddressDto) is preserved by PartialType -> nested plainToInstance works!
    const inst = plainToInstance(PartialUserWithNestedDto, {
      mode: "strict",
      address: { city: "Hanoi" },
    });
    expect(inst.address).toBeInstanceOf(AddressDto);
    // 2. @ValidateIf(mode === 'strict') field `code` is optional under PartialType when omitted!
    expect(await validate(inst)).toHaveLength(0);

    // 3. When provided with invalid type under mode === 'strict', validation still triggers!
    const badCode = plainToInstance(PartialUserWithNestedDto, {
      mode: "strict",
      code: 123,
    });
    const codeErrs = await validate(badCode);
    expect(codeErrs.map((e) => e.property)).toEqual(["code"]);

    // 4. Nested DTO validation still rejects invalid AddressDto fields!
    const badAddr = plainToInstance(PartialUserWithNestedDto, {
      address: { city: 42 },
    });
    const addrErrs = await validate(badAddr);
    expect(addrErrs.map((e) => e.property)).toEqual(["address"]);
  });
});

describe("Standard Schema v1", () => {
  it("detects compliant object & callable schemas and validates synchronously/asynchronously", async () => {
    const objSchema: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "custom-test",
        validate(value) {
          if (typeof value === "string" && /^\d+$/.test(value)) {
            return { value: Number(value) };
          }
          return {
            issues: [{ message: "Expected numeric string", path: ["count"] }],
          };
        },
      },
    };

    const callableSchema = Object.assign((x: unknown) => x, {
      "~standard": {
        version: 1 as const,
        vendor: "arktype-like",
        async validate(value: unknown) {
          return typeof value === "string"
            ? { value: value.toUpperCase() }
            : { issues: [{ message: "Expected string" }] };
        },
      },
    });

    expect(isStandardSchema(objSchema)).toBe(true);
    expect(isStandardSchema(callableSchema)).toBe(true);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema({})).toBe(false);
    expect(
      isStandardSchema({ "~standard": { version: 2, vendor: "x", validate() {} } }),
    ).toBe(false);

    const ok = await objSchema["~standard"].validate("42");
    expect(ok.issues).toBeUndefined();
    expect("value" in ok && ok.value).toBe(42);

    const fail = await objSchema["~standard"].validate("abc");
    expect(fail.issues?.[0]?.message).toBe("Expected numeric string");

    const asyncOk = await callableSchema["~standard"].validate("bunest");
    expect("value" in asyncOk && asyncOk.value).toBe("BUNEST");
  });
});
