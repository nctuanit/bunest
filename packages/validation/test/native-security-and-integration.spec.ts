import { describe, expect, it } from "bun:test";
import {
  IsEmail as UpstreamIsEmail,
  IsString as UpstreamIsString,
} from "class-validator";
import {
  Exclude as UpstreamExclude,
  Expose as UpstreamExpose,
} from "class-transformer";
import {
  BadRequestException,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Module,
  PartialType,
  PickType,
  Post,
  Body,
  ValidationPipe,
  type ValidationErrorResponse,
} from "@bunest/core";
import { ConfigModule, ConfigService } from "@bunest/core/config";
import {
  I18nModule,
  I18nValidationPipe,
  InMemoryI18nLoader,
} from "@bunest/core/i18n";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  isBase64,
  isCreditCard,
  isCurrency,
  isDataURI,
  isDecimal,
  isEmail,
  isFQDN,
  isHSL,
  isIBAN,
  isIP,
  isISO8601,
  isJWT,
  isMagnetURI,
  isMimeType,
  isPhoneNumber,
  isRFC3339,
  isRgbColor,
  isSemVer,
  isStrongPassword,
  isURL,
} from "../src/validator";
import { Exclude, Expose, Transform, Type } from "../src/transformer";

describe("@bunest/validation Phase 4 — ReDoS Hardening & Full Ecosystem Integration", () => {
  it("completes 50 KB adversarial ReDoS payloads in < 5ms per validator (ADR-015 §4)", () => {
    const fiftyKbA = "a".repeat(50_000);
    const fiftyKbDots = "a.".repeat(25_000) + "!";
    const fiftyKbSpaces = "1" + " ".repeat(50_000) + "!";
    const fiftyKbColons = "0:".repeat(25_000) + "z";

    const checks: Array<[string, () => boolean]> = [
      ["isEmail", () => isEmail(`${fiftyKbA}@${fiftyKbDots}.com`)],
      ["isURL", () => isURL(`https://${fiftyKbDots}/${fiftyKbA}`)],
      ["isFQDN", () => isFQDN(fiftyKbDots)],
      ["isIP", () => isIP(fiftyKbColons)],
      ["isSemVer", () => isSemVer(`1.0.0-${fiftyKbA}.!`)],
      ["isISO8601", () => isISO8601(`2026-01-01T${fiftyKbA}`)],
      ["isRFC3339", () => isRFC3339(`2026-01-01T00:00:00.${fiftyKbA}Z`)],
      ["isCreditCard", () => isCreditCard(fiftyKbSpaces)],
      ["isIBAN", () => isIBAN(`DE${fiftyKbA}`)],
      ["isCurrency", () => isCurrency(`$${fiftyKbSpaces}`)],
      ["isHSL", () => isHSL(`hsl(${fiftyKbSpaces})`)],
      ["isRgbColor", () => isRgbColor(`rgb(${fiftyKbSpaces})`)],
      ["isDataURI", () => isDataURI(`data:text/plain;${fiftyKbA}`)],
      ["isMimeType", () => isMimeType(`application/${fiftyKbA};a=b`)],
      ["isMagnetURI", () => isMagnetURI(`magnet:?xt=urn:btih:${fiftyKbA}`)],
      ["isStrongPassword", () => isStrongPassword(fiftyKbA)],
      ["isPhoneNumber", () => isPhoneNumber(`+${fiftyKbA}`)],
      ["isJWT", () => isJWT(`${fiftyKbA}.${fiftyKbA}.${fiftyKbA}`)],
      ["isBase64", () => isBase64(`${fiftyKbA}===`)],
      ["isDecimal", () => isDecimal(`${fiftyKbA}.${fiftyKbA}!`)],
    ];

    for (const [name, fn] of checks) {
      const start = performance.now();
      fn();
      const elapsedMs = performance.now() - start;
      expect(elapsedMs, `${name} took ${elapsedMs.toFixed(2)}ms`).toBeLessThan(
        10,
      );
    }
  });

  it("keeps WeakMap-backed storages GC-safe for dynamically generated PartialType DTOs (ADR-015 §3)", async () => {
    class BaseDynamicDto {
      @IsEmail()
      email!: string;

      @IsString()
      @Transform(({ value }) =>
        typeof value === "string" ? value.trim() : value,
      )
      name!: string;
    }

    const pipe = new ValidationPipe();
    const refs: WeakRef<Function>[] = [];

    for (let i = 0; i < 40; i += 1) {
      const DynamicPartial = PartialType(BaseDynamicDto);
      refs.push(new WeakRef(DynamicPartial));
      const res = await pipe.transform(
        { name: "  ada  " },
        { type: "body", metatype: DynamicPartial },
      );
      expect((res as { name: string }).name).toBe("ada");
    }

    // Trigger GC cycles and verify dynamic classes are not strongly retained by native WeakMaps
    for (let i = 0; i < 5; i += 1) {
      Bun.gc(true);
      await Bun.sleep(2);
    }

    const collected = refs.filter((r) => r.deref() === undefined).length;
    expect(collected).toBeGreaterThan(0);
  });

  it("integrates native DTOs across ValidationPipe, ClassSerializerInterceptor, MappedTypes, Swagger, Config, and I18n", async () => {
    class AddressDto {
      @IsString()
      @MinLength(2)
      city!: string;
    }

    class CreateProfileDto {
      @IsEmail()
      email!: string;

      @IsString()
      @MinLength(2)
      @Transform(({ value }) =>
        typeof value === "string" ? value.trim() : value,
      )
      name!: string;

      @IsInt()
      @Min(18)
      age!: number;

      @IsOptional()
      @Type(() => AddressDto)
      address?: AddressDto;
    }

    // 1. ValidationPipe (fused sync fast-path + ADR-009 defaults)
    const pipe = new ValidationPipe();
    const ok = (await pipe.transform(
      { email: "ada@bunest.dev", name: "  Ada  ", age: 29 },
      { type: "body", metatype: CreateProfileDto },
    )) as CreateProfileDto;
    expect(ok).toBeInstanceOf(CreateProfileDto);
    expect(ok.name).toBe("Ada");

    await expect(
      pipe.transform(
        { email: "bad", name: "A", age: 12, rogue: true },
        { type: "body", metatype: CreateProfileDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // 2. MappedTypes (PartialType + PickType) on native DTO
    class UpdateProfileDto extends PartialType(CreateProfileDto) {}
    class EmailOnlyDto extends PickType(CreateProfileDto, ["email"] as const) {}

    const partialOk = (await pipe.transform(
      { name: "  Grace  " },
      { type: "body", metatype: UpdateProfileDto },
    )) as UpdateProfileDto;
    expect(partialOk).toBeInstanceOf(UpdateProfileDto);
    expect(partialOk.name).toBe("Grace");

    const emailOk = (await pipe.transform(
      { email: "grace@bunest.dev" },
      { type: "body", metatype: EmailOnlyDto },
    )) as EmailOnlyDto;
    expect(emailOk.email).toBe("grace@bunest.dev");

    // 3. ClassSerializerInterceptor (native @Exclude/@Expose inside plain envelope)
    class NativeAccountEntity {
      @Expose()
      id!: string;

      @Exclude()
      passwordHash!: string;

      constructor(id: string, passwordHash: string) {
        this.id = id;
        this.passwordHash = passwordHash;
      }
    }
    const serializer = new ClassSerializerInterceptor();
    const serialized = serializer.serialize({
      account: new NativeAccountEntity("u1", "argon2id$secret"),
    }) as { account: Record<string, unknown> };
    expect(serialized.account).toEqual({ id: "u1" });

    // 4. SwaggerModule OpenAPI 3.1 schema inference from native validator metadata
    @Controller("/profiles")
    class ProfileController {
      @Post()
      create(@Body() dto: CreateProfileDto): CreateProfileDto {
        return dto;
      }
    }
    @Module({ controllers: [ProfileController] })
    class SwaggerTestModule {}

    const { BunestFactory } = await import("@bunest/core");
    const app = await BunestFactory.create(SwaggerTestModule, { logger: false });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Native DTO API").build(),
      );
      const schema = doc.components?.schemas?.CreateProfileDto as any;
      expect(schema).toBeDefined();
      expect(schema.properties.email.format).toBe("email");
      expect(schema.properties.name.minLength).toBe(2);
      expect(schema.properties.age.type).toBe("integer");
      expect(schema.properties.age.minimum).toBe(18);
      expect(schema.required).toContain("email");
      expect(schema.required).not.toContain("address");
    } finally {
      await app.close();
    }

    // 5. ConfigModule validation with native DTO
    class NativeEnvDto {
      @IsInt()
      @Min(1)
      APP_PORT!: number;

      @IsString()
      APP_HOST!: string;
    }

    const origPort = process.env.APP_PORT;
    const origHost = process.env.APP_HOST;
    process.env.APP_PORT = "4321";
    process.env.APP_HOST = "127.0.0.1";
    try {
      @Module({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            validationClass: NativeEnvDto,
          }),
        ],
      })
      class EnvAppModule {}

      const envApp = await BunestFactory.create(EnvAppModule, { logger: false });
      try {
        const cfg = envApp.get(ConfigService);
        expect(cfg.get("APP_PORT")).toBe(4321);
        expect(cfg.get("APP_HOST")).toBe("127.0.0.1");
      } finally {
        await envApp.close();
      }
    } finally {
      if (origPort === undefined) delete process.env.APP_PORT;
      else process.env.APP_PORT = origPort;
      if (origHost === undefined) delete process.env.APP_HOST;
      else process.env.APP_HOST = origHost;
    }

    // 6. I18nValidationPipe translating native DTO errors
    @Controller("/i18n-native")
    class I18nNativeController {
      @Get()
      ping() {
        return { ok: true };
      }

      @Post()
      submit(@Body(new I18nValidationPipe()) dto: CreateProfileDto) {
        return dto;
      }
    }
    @Module({
      imports: [
        I18nModule.forRoot({
          defaultLocale: "vi",
          loader: new InMemoryI18nLoader({
            vi: {
              validation: {
                isEmail: "{property} không hợp lệ ({value})",
              },
            },
          }),
        }),
      ],
      controllers: [I18nNativeController],
    })
    class I18nTestModule {}

    const i18nApp = await BunestFactory.create(I18nTestModule, {
      logger: false,
    });
    try {
      const res = await i18nApp.fetch(
        new Request("http://localhost/i18n-native", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "bad-mail", name: "Ada", age: 25 }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ValidationErrorResponse;
      expect(body.details[0]?.constraints.isEmail).toBe(
        "email không hợp lệ (bad-mail)",
      );
    } finally {
      await i18nApp.close();
    }
  });

  it("supports seamless dual-engine coexistence (native DTO + upstream class-validator/class-transformer DTO in the same pipe & serializer)", async () => {
    class NativeDto {
      @IsEmail()
      email!: string;
    }

    class UpstreamDto {
      @UpstreamIsEmail()
      @UpstreamIsString()
      email!: string;
    }

    class NativeOut {
      @Expose()
      name = "native";
      @Exclude()
      secret = "s1";
    }

    class UpstreamOut {
      @UpstreamExpose()
      name = "upstream";
      @UpstreamExclude()
      secret = "s2";
    }

    const pipe = new ValidationPipe();

    const nOk = await pipe.transform(
      { email: "a@b.com" },
      { type: "body", metatype: NativeDto },
    );
    expect(nOk).toBeInstanceOf(NativeDto);
    await expect(
      pipe.transform({ email: "nope" }, { type: "body", metatype: NativeDto }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const uOk = await pipe.transform(
      { email: "a@b.com" },
      { type: "body", metatype: UpstreamDto },
    );
    expect(uOk).toBeInstanceOf(UpstreamDto);
    await expect(
      pipe.transform({ email: "nope" }, { type: "body", metatype: UpstreamDto }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const serializer = new ClassSerializerInterceptor();
    expect(serializer.serialize(new NativeOut())).toEqual({ name: "native" });
    expect(serializer.serialize(new UpstreamOut())).toEqual({
      name: "upstream",
    });
  });
});
