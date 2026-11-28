import { describe, expect, it } from "bun:test";
import { Project } from "../src/ast";
import { runDecoratorDiagnostics } from "../src/analyzer/diagnostics";

function analyzeSource(code: string) {
  const project = new Project();
  const sf = project.createSourceFile("dto.ts", code);
  return runDecoratorDiagnostics([sf]);
}

describe("DTO static diagnostics (BUNEST_DEC006–BUNEST_DEC008)", () => {
  it("emits BUNEST_DEC006 when optional DTO property has validator without @IsOptional() or @Prop({ optional: true })", () => {
    const diags = analyzeSource(`
      class UserDto {
        @IsString()
        nickname?: string;

        @Prop({ int: true })
        age?: number;

        @IsOptional()
        @IsString()
        okWithOptional?: string;

        @ValidateIf((o) => o.nickname !== undefined)
        @IsString()
        okWithValidateIf?: string;

        @Prop({
          string: true,
          optional: true,
        })
        okWithMultilinePropOptional?: string;
      }
    `);

    const dec006 = diags.filter((d) => d.code === "BUNEST_DEC006");
    expect(dec006).toHaveLength(2);
    expect(dec006[0]!.message).toContain("UserDto.nickname?");
    expect(dec006[1]!.message).toContain("UserDto.age?");
  });

  it("avoids BUNEST_DEC006 false positives on @Schema/@Entity/@BaseEntity/@Embeddable, default initializers, and composed optional wrappers", () => {
    const diags = analyzeSource(`
      const OptionalProp = () => applyDecorators(Prop({ string: true, optional: true }));
      const RequiredProp = () => applyDecorators(Prop({ string: true }));

      @Schema()
      class MongooseCat {
        @Prop()
        nickname?: string;
      }

      @BaseEntity()
      class BaseUser {
        @IsString()
        bio?: string;
      }

      @Embeddable()
      class AddressEmbed {
        @IsString()
        line2?: string;
      }

      class ProfileDto {
        @Prop({ int: true })
        defaultedAge?: number = 10;

        @Prop({ int: true })
        nonOptionalDefault = 10;

        @Prop({ int: true })
        undefinedDefault?: number = undefined;

        @Prop({ int: true, default: 10 })
        docOnlyDefault?: number;

        @OptionalProp()
        composedOptional?: string;

        @RequiredProp()
        composedRequired?: string;

        @Prop({ string: true, description: "optional: true" })
        trickyDescription?: string;

        @IsMongoId()
        externalId?: string;
      }
    `);

    const dec006 = diags.filter((d) => d.code === "BUNEST_DEC006");
    expect(dec006.map((d) => d.message)).toEqual([
      expect.stringContaining("ProfileDto.undefinedDefault?"),
      expect.stringContaining("ProfileDto.docOnlyDefault?"),
      expect.stringContaining("ProfileDto.composedRequired?"),
      expect.stringContaining("ProfileDto.trickyDescription?"),
      expect.stringContaining("ProfileDto.externalId?"),
    ]);
  });

  it("emits BUNEST_DEC007 when validator decorator or @Prop() conflicts with static TypeScript type", () => {
    const diags = analyzeSource(`
      type BrandedEmail = string & { readonly __brand: "Email" };

      @Schema()
      class MongooseDoc {
        @Prop({ string: true })
        ignoredOnMongooseSchema!: number;
      }

      class BadTypesDto {
        @IsEmail()
        emailCount!: number;

        @IsInt()
        name!: string;

        @IsBoolean()
        flag!: number;

        @IsDate()
        createdAt!: string;

        @IsBoolean()
        bigFlag!: bigint;

        @Prop({ int: true })
        propIntOnString!: string;

        @Prop({ email: true })
        propEmailOnNumber!: number;

        @Prop({ boolean: true })
        propBoolOnDate!: Date;

        @Prop({ date: true })
        propDateOnString!: string;

        @Prop({ coerce: true, int: true })
        okPropCoerced!: string;

        @Type(() => Number)
        @IsInt()
        okCoercedFromString!: string;

        @Transform(({ value }) => String(value))
        @IsString()
        okTransformedToString!: number;

        @IsString({ each: true })
        okStringArray!: string[];

        @IsString({ each: true })
        badNumberArray!: number[];

        @IsInt({ each: true })
        badReadonlyStringArray!: readonly string[];

        @IsString()
        missingEachOnArray!: string[];

        @IsString()
        badUnion!: number | boolean;

        @IsString()
        okPartialUnion!: string | number;

        @IsEmail()
        okBranded!: BrandedEmail;
      }
    `);

    const dec007 = diags.filter((d) => d.code === "BUNEST_DEC007");
    expect(dec007).toHaveLength(13);
    expect(dec007.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BadTypesDto.emailCount"),
        expect.stringContaining("BadTypesDto.name"),
        expect.stringContaining("BadTypesDto.flag"),
        expect.stringContaining("BadTypesDto.createdAt"),
        expect.stringContaining("BadTypesDto.bigFlag"),
        expect.stringContaining("BadTypesDto.propIntOnString"),
        expect.stringContaining("BadTypesDto.propEmailOnNumber"),
        expect.stringContaining("BadTypesDto.propBoolOnDate"),
        expect.stringContaining("BadTypesDto.propDateOnString"),
        expect.stringContaining("BadTypesDto.badNumberArray"),
        expect.stringContaining("BadTypesDto.badReadonlyStringArray"),
        expect.stringContaining("BadTypesDto.missingEachOnArray"),
        expect.stringContaining("BadTypesDto.badUnion"),
      ]),
    );
  });

  it("emits BUNEST_DEC008 for @ValidateNested / @Prop({ nested: true }) array properties missing element type resolver", () => {
    const diags = analyzeSource(`
      class ItemDto {}
      const type = () => ItemDto;
      const ComposedBadNested = () => applyDecorators(ValidateNested({ each: true }));
      const ComposedGoodNested = () => applyDecorators(ValidateNested({ each: true, type: () => ItemDto }));

      class OrderDto {
        @ValidateNested({ each: true })
        missingType!: ItemDto[];

        @ValidateNested({ each: true, message: "type: must be ItemDto" })
        trickyMessage!: ItemDto[];

        @ValidateNested()
        missingEachAndType!: ItemDto[];

        @Prop({ nested: true, each: true })
        propNestedEachMissingType!: ItemDto[];

        @Prop({ nested: true })
        propNestedArrayMissingType!: ItemDto[];

        @ComposedBadNested()
        composedMissingType!: ItemDto[];

        @ValidateNested({ each: true, type: () => ItemDto })
        okInlineType!: ItemDto[];

        @ValidateNested({ each: true, type })
        okShorthandType!: ItemDto[];

        @ValidateNested({ each: true })
        @Type(() => ItemDto)
        okSeparateType!: ItemDto[];

        @ValidateNested()
        okSingleNested!: ItemDto;

        @Prop({ nested: () => ItemDto, each: true })
        okPropNestedFn!: ItemDto[];

        @Prop({ nested: true, each: true, type: () => ItemDto })
        okPropNestedWithType!: ItemDto[];

        @Prop({ nested: true })
        okPropSingleNested!: ItemDto;

        @ComposedGoodNested()
        okComposedNested!: ItemDto[];
      }
    `);

    const dec008 = diags.filter((d) => d.code === "BUNEST_DEC008");
    expect(dec008).toHaveLength(6);
    expect(dec008.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("OrderDto.missingType"),
        expect.stringContaining("OrderDto.trickyMessage"),
        expect.stringContaining("OrderDto.missingEachAndType"),
        expect.stringContaining("OrderDto.propNestedEachMissingType"),
        expect.stringContaining("OrderDto.propNestedArrayMissingType"),
        expect.stringContaining("OrderDto.composedMissingType"),
      ]),
    );
  });
});

describe("Auth static diagnostics (BUNEST_DEC009)", () => {
  it("emits BUNEST_DEC009 for non-nullable @CurrentUser() on @Public() or unguarded routes", () => {
    const diags = analyzeSource(`
      @Controller("profile")
      class ProfileController {
        @Get("public-bad")
        @Public()
        getPublic(@CurrentUser() user: User) {
          return user;
        }

        @Get("public-nullable-ok")
        @Public()
        getPublicNullable(@CurrentUser() user: User | null) {
          return user;
        }

        @Get("public-optional-ok")
        @Public()
        getPublicOptional(@CurrentUser() user?: User) {
          return user;
        }

        @Get("unguarded-bad")
        getUnguarded(@CurrentUser() user: User) {
          return user;
        }

        @Get("guarded-ok")
        @UseGuards(JwtAuthGuard)
        getGuarded(@CurrentUser() user: User) {
          return user;
        }
      }
    `);

    const dec009 = diags.filter((d) => d.code === "BUNEST_DEC009");
    expect(dec009).toHaveLength(2);
    expect(dec009[0]!.message).toContain("ProfileController.getPublic()");
    expect(dec009[1]!.message).toContain("ProfileController.getUnguarded()");
  });

  it("suppresses unguarded BUNEST_DEC009 when project registers APP_GUARD, but still warns on @Public()", () => {
    const project = new Project();
    const appSf = project.createSourceFile(
      "app.module.ts",
      `
        @Module({
          providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
        })
        export class AppModule {}
      `,
    );
    const ctrlSf = project.createSourceFile(
      "users.controller.ts",
      `
        @Controller("users")
        export class UsersController {
          @Get("me")
          me(@CurrentUser() user: User) {
            return user;
          }

          @Get("open")
          @Public()
          open(@CurrentUser() user: User) {
            return user;
          }
        }
      `,
    );

    const dec009 = runDecoratorDiagnostics([appSf, ctrlSf]).filter(
      (d) => d.code === "BUNEST_DEC009",
    );
    expect(dec009).toHaveLength(1);
    expect(dec009[0]!.message).toContain("UsersController.open()");
  });

  it("warns on @Authenticate({ optional: true }), ignores APP_GUARD in comments/imports, and accepts parenthesized nullable or defaulted params", () => {
    const diags = analyzeSource(`
      import { APP_GUARD } from "@bunest/core";
      // TODO: register APP_GUARD globally later

      @Controller("feed")
      class FeedController {
        @Get("optional-bad")
        @Authenticate({ optional: true })
        optionalBad(@CurrentUser() user: User) {
          return user;
        }

        @Get("optional-paren-ok")
        @Authenticate({ optional: true })
        optionalParenOk(@CurrentUser() user: (User | null)) {
          return user;
        }

        @Get("optional-default-ok")
        @Authenticate({ optional: true })
        optionalDefaultOk(@CurrentUser() user: User = guestUser) {
          return user;
        }

        @Get("unguarded-bad")
        unguardedBad(@CurrentUser() user: User) {
          return user;
        }
      }
    `);

    const dec009 = diags.filter((d) => d.code === "BUNEST_DEC009");
    expect(dec009).toHaveLength(2);
    expect(dec009[0]!.message).toContain("FeedController.optionalBad()");
    expect(dec009[0]!.message).toContain("@Authenticate({ optional: true })");
    expect(dec009[1]!.message).toContain("FeedController.unguardedBad()");
  });
});
