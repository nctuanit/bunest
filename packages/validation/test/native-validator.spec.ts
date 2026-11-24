import "@bunest/core";
import { describe, expect, it } from "bun:test";
import * as upstreamCV from "class-validator";
import * as nativeCV from "../src/validator";
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatePromise,
  ValidationError,
  ValidatorConstraint,
  canValidateSynchronously,
  getMetadataStorage,
  registerPhoneNumberValidator,
  registerSchema,
  validate,
  validateMaybeSync,
  validateOrReject,
  validateSync,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from "../src/validator";
import { Type, plainToInstance } from "../src/transformer";

describe("@bunest/validation/validator (Zero-Dep Bun-Native Engine)", () => {
  it("exports 100% of upstream class-validator runtime API (336/336)", () => {
    const missing = Object.keys(upstreamCV).filter(
      (k) => k !== "default" && !(k in nativeCV),
    );
    expect(missing).toEqual([]);
    expect(
      (globalThis as Record<PropertyKey, unknown>)[
        Symbol.for("bunest:class-validator:storage")
      ],
    ).toBe(getMetadataStorage());
  });

  it("matches upstream class-validator across core, type, number, date, array, string, net, and finance predicates", () => {
    const cases: Array<[string, boolean, boolean]> = [
      // Common
      ["equals", nativeCV.equals(5, 5), upstreamCV.equals(5, 5)],
      ["notEquals", nativeCV.notEquals(5, 6), upstreamCV.notEquals(5, 6)],
      ["isEmpty", nativeCV.isEmpty(""), upstreamCV.isEmpty("")],
      ["isNotEmpty", nativeCV.isNotEmpty("a"), upstreamCV.isNotEmpty("a")],
      ["isIn", nativeCV.isIn("b", ["a", "b"]), upstreamCV.isIn("b", ["a", "b"])],
      ["isNotIn", nativeCV.isNotIn("c", ["a", "b"]), upstreamCV.isNotIn("c", ["a", "b"])],
      ["isLatLong ok", nativeCV.isLatLong("37.7749,-122.4194"), upstreamCV.isLatLong("37.7749,-122.4194")],
      ["isLatLong bad", nativeCV.isLatLong("95.0,0"), upstreamCV.isLatLong("95.0,0")],
      ["isLatitude", nativeCV.isLatitude("45.5"), upstreamCV.isLatitude("45.5")],
      ["isLongitude", nativeCV.isLongitude("-179.9"), upstreamCV.isLongitude("-179.9")],
      ["isLatitude num", nativeCV.isLatitude(45.5), true],
      ["isLongitude num", nativeCV.isLongitude(-179.9), true],
      // Types
      ["isBoolean", nativeCV.isBoolean(true), upstreamCV.isBoolean(true)],
      ["isDate ok", nativeCV.isDate(new Date()), upstreamCV.isDate(new Date())],
      ["isDate NaN", nativeCV.isDate(new Date("bad")), upstreamCV.isDate(new Date("bad"))],
      ["isString", nativeCV.isString("ok"), upstreamCV.isString("ok")],
      ["isNumber", nativeCV.isNumber(3.14, { maxDecimalPlaces: 2 }), upstreamCV.isNumber(3.14, { maxDecimalPlaces: 2 })],
      ["isNumber >maxDec", nativeCV.isNumber(3.141, { maxDecimalPlaces: 2 }), upstreamCV.isNumber(3.141, { maxDecimalPlaces: 2 })],
      ["isInt ok", nativeCV.isInt(42), upstreamCV.isInt(42)],
      ["isInt bad", nativeCV.isInt(42.5), upstreamCV.isInt(42.5)],
      ["isArray", nativeCV.isArray([1]), upstreamCV.isArray([1])],
      ["isObject", nativeCV.isObject({}), upstreamCV.isObject({})],
      ["isObject array", nativeCV.isObject([]), upstreamCV.isObject([])],
      ["isNotEmptyObject", nativeCV.isNotEmptyObject({ a: 1 }), upstreamCV.isNotEmptyObject({ a: 1 })],
      ["isNotEmptyObject empty", nativeCV.isNotEmptyObject({}), upstreamCV.isNotEmptyObject({})],
      // Numbers & arrays
      ["isDivisibleBy", nativeCV.isDivisibleBy(12, 4), upstreamCV.isDivisibleBy(12, 4)],
      ["isPositive", nativeCV.isPositive(1), upstreamCV.isPositive(1)],
      ["isNegative", nativeCV.isNegative(-1), upstreamCV.isNegative(-1)],
      ["min", nativeCV.min(10, 5), upstreamCV.min(10, 5)],
      ["max", nativeCV.max(10, 5), upstreamCV.max(10, 5)],
      ["arrayContains", nativeCV.arrayContains([1, 2, 3], [1, 3]), upstreamCV.arrayContains([1, 2, 3], [1, 3])],
      ["arrayNotContains", nativeCV.arrayNotContains([1, 2], [3]), upstreamCV.arrayNotContains([1, 2], [3])],
      ["arrayNotEmpty", nativeCV.arrayNotEmpty([1]), upstreamCV.arrayNotEmpty([1])],
      ["arrayMinSize", nativeCV.arrayMinSize([1, 2], 2), upstreamCV.arrayMinSize([1, 2], 2)],
      ["arrayMaxSize", nativeCV.arrayMaxSize([1, 2], 1), upstreamCV.arrayMaxSize([1, 2], 1)],
      ["arrayUnique", nativeCV.arrayUnique([1, 2, 1]), upstreamCV.arrayUnique([1, 2, 1])],
      // Strings basic
      ["contains", nativeCV.contains("bunest", "nest"), upstreamCV.contains("bunest", "nest")],
      ["notContains", nativeCV.notContains("bunest", "xyz"), upstreamCV.notContains("bunest", "xyz")],
      ["isAlpha", nativeCV.isAlpha("Bunest"), upstreamCV.isAlpha("Bunest")],
      ["isAlphanumeric", nativeCV.isAlphanumeric("Bun145"), upstreamCV.isAlphanumeric("Bun145")],
      ["isDecimal", nativeCV.isDecimal("12.34"), upstreamCV.isDecimal("12.34")],
      ["isAscii", nativeCV.isAscii("hello!"), upstreamCV.isAscii("hello!")],
      ["isBase32", nativeCV.isBase32("MZXW6YTBOI======"), upstreamCV.isBase32("MZXW6YTBOI======")],
      ["isBase58", nativeCV.isBase58("2NEpo7TZRRrLZSi2U"), upstreamCV.isBase58("2NEpo7TZRRrLZSi2U")],
      ["isBase64", nativeCV.isBase64("aGVsbG8="), upstreamCV.isBase64("aGVsbG8=")],
      ["isByteLength", nativeCV.isByteLength("é", 2, 2), upstreamCV.isByteLength("é", 2, 2)],
      ["isBooleanString", nativeCV.isBooleanString("true"), upstreamCV.isBooleanString("true")],
      ["isNumberString", nativeCV.isNumberString("12345"), upstreamCV.isNumberString("12345")],
      ["isLowercase", nativeCV.isLowercase("abc"), upstreamCV.isLowercase("abc")],
      ["isUppercase", nativeCV.isUppercase("ABC"), upstreamCV.isUppercase("ABC")],
      ["length", nativeCV.length("hello", 3, 5), upstreamCV.length("hello", 3, 5)],
      ["minLength", nativeCV.minLength("hi", 3), upstreamCV.minLength("hi", 3)],
      ["maxLength", nativeCV.maxLength("hi", 3), upstreamCV.maxLength("hi", 3)],
      ["matches", nativeCV.matches("abc123", /^[a-z]+\d+$/), upstreamCV.matches("abc123", /^[a-z]+\d+$/)],
      ["isHexadecimal", nativeCV.isHexadecimal("0xdeadbeef"), upstreamCV.isHexadecimal("0xdeadbeef")],
      ["isOctal", nativeCV.isOctal("0o755"), upstreamCV.isOctal("0o755")],
      ["isHexColor", nativeCV.isHexColor("#e0234e"), upstreamCV.isHexColor("#e0234e")],
      ["isHSL", nativeCV.isHSL("hsl(120, 100%, 50%)"), upstreamCV.isHSL("hsl(120, 100%, 50%)")],
      ["isRgbColor", nativeCV.isRgbColor("rgb(255,0,128)"), upstreamCV.isRgbColor("rgb(255,0,128)")],
      ["isMilitaryTime", nativeCV.isMilitaryTime("23:59"), upstreamCV.isMilitaryTime("23:59")],
      ["isJSON", nativeCV.isJSON('{"a":1}'), upstreamCV.isJSON('{"a":1}')],
      ["isJWT", nativeCV.isJWT("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), upstreamCV.isJWT("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")],
      ["isSemVer", nativeCV.isSemVer("1.4.5-alpha.1+build.42"), upstreamCV.isSemVer("1.4.5-alpha.1+build.42")],
      ["isHash sha256", nativeCV.isHash("a".repeat(64), "sha256"), upstreamCV.isHash("a".repeat(64), "sha256")],
      ["isMongoId", nativeCV.isMongoId("507f1f77bcf86cd799439011"), upstreamCV.isMongoId("507f1f77bcf86cd799439011")],
      ["isFirebasePushId", nativeCV.isFirebasePushId("-M1234567890abcdefgh"), upstreamCV.isFirebasePushId("-M1234567890abcdefgh")],
      // Net & IDs
      ["isEmail ok", nativeCV.isEmail("alice@bunest.dev"), upstreamCV.isEmail("alice@bunest.dev")],
      ["isEmail bad", nativeCV.isEmail("not-an-email"), upstreamCV.isEmail("not-an-email")],
      ["isURL ok", nativeCV.isURL("https://bunest.dev/docs?q=1"), upstreamCV.isURL("https://bunest.dev/docs?q=1")],
      ["isURL bad", nativeCV.isURL("javascript:alert(1)"), upstreamCV.isURL("javascript:alert(1)")],
      ["isFQDN", nativeCV.isFQDN("api.bunest.dev"), upstreamCV.isFQDN("api.bunest.dev")],
      ["isIP v4", nativeCV.isIP("192.168.1.1", 4), upstreamCV.isIP("192.168.1.1", 4)],
      ["isIP v6", nativeCV.isIP("2001:db8::1", 6), upstreamCV.isIP("2001:db8::1", 6)],
      ["isPort", nativeCV.isPort("8080"), upstreamCV.isPort("8080")],
      ["isMACAddress", nativeCV.isMACAddress("00:1A:2B:3C:4D:5E"), upstreamCV.isMACAddress("00:1A:2B:3C:4D:5E")],
      ["isDataURI", nativeCV.isDataURI("data:text/plain;base64,SGVsbG8="), upstreamCV.isDataURI("data:text/plain;base64,SGVsbG8=")],
      ["isMimeType", nativeCV.isMimeType("application/json"), upstreamCV.isMimeType("application/json")],
      ["isUUID v4", nativeCV.isUUID("550e8400-e29b-41d4-a716-446655440000", "4"), upstreamCV.isUUID("550e8400-e29b-41d4-a716-446655440000", "4")],
      ["isISO8601", nativeCV.isISO8601("2026-11-22T10:30:00Z"), upstreamCV.isISO8601("2026-11-22T10:30:00Z")],
      ["isRFC3339", nativeCV.isRFC3339("2026-11-22T10:30:00Z"), upstreamCV.isRFC3339("2026-11-22T10:30:00Z")],
      ["isTimeZone", nativeCV.isTimeZone("Asia/Ho_Chi_Minh"), upstreamCV.isTimeZone("Asia/Ho_Chi_Minh")],
      ["isISO31661Alpha2", nativeCV.isISO31661Alpha2("VN"), upstreamCV.isISO31661Alpha2("VN")],
      ["isISO31661Alpha3", nativeCV.isISO31661Alpha3("VNM"), upstreamCV.isISO31661Alpha3("VNM")],
      ["isISO4217CurrencyCode", nativeCV.isISO4217CurrencyCode("USD"), upstreamCV.isISO4217CurrencyCode("USD")],
      // Finance & docs
      ["isCreditCard ok", nativeCV.isCreditCard("4532015112830366"), upstreamCV.isCreditCard("4532015112830366")],
      ["isCreditCard bad", nativeCV.isCreditCard("4532015112830367"), upstreamCV.isCreditCard("4532015112830367")],
      ["isIBAN ok", nativeCV.isIBAN("DE89370400440532013000"), upstreamCV.isIBAN("DE89370400440532013000")],
      ["isIBAN bad", nativeCV.isIBAN("DE89370400440532013001"), upstreamCV.isIBAN("DE89370400440532013001")],
      ["isBIC", nativeCV.isBIC("DEUTDEFF500"), upstreamCV.isBIC("DEUTDEFF500")],
      ["isISIN", nativeCV.isISIN("US0378331005"), upstreamCV.isISIN("US0378331005")],
      ["isEAN", nativeCV.isEAN("4006381333931"), upstreamCV.isEAN("4006381333931")],
      ["isISBN 13", nativeCV.isISBN("978-0-306-40615-7", 13), upstreamCV.isISBN("978-0-306-40615-7", 13)],
      ["isISSN", nativeCV.isISSN("0378-5955"), upstreamCV.isISSN("0378-5955")],
      ["isEthereumAddress", nativeCV.isEthereumAddress("0x71C7656EC7ab88b098defB751B7401B5f6d8976F"), upstreamCV.isEthereumAddress("0x71C7656EC7ab88b098defB751B7401B5f6d8976F")],
      ["isStrongPassword", nativeCV.isStrongPassword("Str0ng!Pass"), upstreamCV.isStrongPassword("Str0ng!Pass")],
    ];

    for (const [label, nativeVal, upstreamVal] of cases) {
      expect({ label, value: nativeVal }).toEqual({ label, value: upstreamVal });
    }

    // Bun-native UUIDv7 support + pluggable phone validator hook
    expect(nativeCV.isUUID(Bun.randomUUIDv7(), "7")).toBe(true);
    expect(nativeCV.isPhoneNumber("+84901234567", "VN")).toBe(true);
    registerPhoneNumberValidator((v) => v === "CUSTOM-PHONE");
    expect(nativeCV.isPhoneNumber("CUSTOM-PHONE")).toBe(true);
    expect(nativeCV.isPhoneNumber("+84901234567")).toBe(false);
    registerPhoneNumberValidator(undefined);
  });

  it("supports sync fast-path, groups, whitelist/forbidNonWhitelisted, nested DTOs, async constraints, ValidatePromise, and registerSchema", async () => {
    enum Role {
      Admin = "admin",
      User = "user",
    }

    class TagDto {
      @IsString()
      @MinLength(2)
      label!: string;
    }

    @ValidatorConstraint({ name: "isUniqueHandle", async: true })
    class IsUniqueHandleConstraint implements ValidatorConstraintInterface {
      async validate(value: unknown): Promise<boolean> {
        await Bun.sleep(1);
        return value !== "taken";
      }
      defaultMessage(args?: ValidationArguments): string {
        return `${args?.property} "${args?.value}" is already taken`;
      }
    }

    class SyncUserDto {
      @IsEmail()
      email!: string;

      @IsInt()
      @Min(18)
      @Max(120)
      age!: number;

      @IsEnum(Role)
      role!: Role;

      @IsOptional()
      @Matches(/^[a-z]+$/g)
      nickname?: string;

      @Allow()
      note?: unknown;

      @IsDefined({ groups: ["strict"] })
      @IsUUID("7", { groups: ["strict"] })
      traceId?: string;
    }

    // Pure sync DTO uses zero-Promise compile-once fast path
    expect(canValidateSynchronously(SyncUserDto)).toBe(true);

    const good = plainToInstance(SyncUserDto, {
      email: "ada@bunest.dev",
      age: 30,
      role: Role.Admin,
      note: "kept-by-allow",
      extraProp: "strip-me",
    });

    // strictGroups: true skips group-scoped rules ("strict") when no groups are passed (exact upstream parity)
    const forbidErrors = validateSync(good, {
      whitelist: true,
      forbidNonWhitelisted: true,
      strictGroups: true,
    });
    expect(forbidErrors).toHaveLength(1);
    expect(forbidErrors[0]!.property).toBe("extraProp");
    expect(forbidErrors[0]!.constraints?.whitelistValidation).toContain(
      "should not exist",
    );

    // Whitelist without forbidNonWhitelisted strips unknown keys in place (exact upstream parity)
    const stripErrors = validateSync(good, {
      whitelist: true,
      forbidNonWhitelisted: false,
      strictGroups: true,
    });
    expect(stripErrors).toEqual([]);
    expect((good as any).extraProp).toBeUndefined();
    expect(good.note).toBe("kept-by-allow");

    // validateMaybeSync returns a synchronous array (NOT a Promise) on sync DTOs!
    const maybeSyncResult = validateMaybeSync(good, { strictGroups: true });
    expect(Array.isArray(maybeSyncResult)).toBe(true);
    expect(maybeSyncResult).toEqual([]);

    // Group validation with @IsDefined overriding skipMissingProperties
    const strictErrors = validateSync(good, {
      groups: ["strict"],
      skipMissingProperties: true,
    });
    expect(strictErrors).toHaveLength(1);
    expect(strictErrors[0]!.property).toBe("traceId");
    expect(strictErrors[0]!.constraints?.isDefined).toBeDefined();

    // Nested + Async + ValidatePromise + ValidateIf
    class ComplexDto {
      @Validate(IsUniqueHandleConstraint)
      handle!: string;

      @ValidateIf((o) => o.requireBio === true)
      @IsString()
      @MinLength(5)
      bio?: string;

      @Allow()
      requireBio?: boolean;

      @ValidateNested({ each: true })
      @ArrayNotEmpty()
      @ArrayMinSize(1)
      @ArrayMaxSize(3)
      @ArrayUnique((t: TagDto) => t.label)
      @Type(() => TagDto)
      tags!: TagDto[];

      @ValidatePromise()
      @IsString()
      @MinLength(3)
      asyncToken!: Promise<string>;
    }

    expect(canValidateSynchronously(ComplexDto)).toBe(false);

    const badComplex = plainToInstance(ComplexDto, {
      handle: "taken",
      requireBio: true,
      bio: "no",
      tags: [{ label: "a" }],
    });
    badComplex.asyncToken = Promise.resolve("ok");

    const complexErrors = await validate(badComplex);
    const props = complexErrors.map((e) => e.property).sort();
    expect(props).toEqual(["asyncToken", "bio", "handle", "tags"]);
    expect(complexErrors[0]!.toString(false, false, "", true)).toContain(
      "ComplexDto",
    );

    await expect(validateOrReject(badComplex)).rejects.toBeArray();

    // Named schema validation (registerSchema)
    registerSchema({
      name: "nativeUserSchema",
      properties: {
        email: [{ type: "isEmail" }],
        score: [{ type: "min", constraints: [10] }],
      },
    });
    const schemaErrs = await validate("nativeUserSchema", {
      email: "bad",
      score: 3,
    });
    expect(schemaErrs).toHaveLength(2);
  });
});
