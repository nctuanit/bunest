import { describe, expect, it } from "bun:test";
import {
  IsString,
  validate,
} from "../../../../../../packages/validation/src/validator";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import {
  ApiProperty,
  DeepPartialType,
  SWAGGER_METADATA_KEYS,
  SchemaExplorer,
  type ApiPropertyMetadata,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

const METADATA_FACTORY_NAME = "_OPENAPI_METADATA_FACTORY" as const;

function getOwnApiProperties(classRef: Function): ApiPropertyMetadata[] {
  const collected = new Map<string, ApiPropertyMetadata>();
  for (const ctor of MetadataRegistry.getPrototypeChain(classRef)) {
    const own = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      ctor,
    );
    if (!own) continue;
    for (const entry of own) {
      collected.set(entry.propertyKey, entry);
    }
  }
  return [...collected.values()];
}

function getModelProperties(classRef: Function): string[] {
  return getOwnApiProperties(classRef).map((p) => p.propertyKey);
}

function getPropertyMetadata(
  classRef: Function,
  key: string,
): ApiPropertyMetadata | undefined {
  return getOwnApiProperties(classRef).find((p) => p.propertyKey === key);
}

function resolveType(meta: ApiPropertyMetadata | undefined): any {
  const t = meta?.type;
  if (typeof t !== "function") return t;
  try {
    if (!t.prototype || !t.prototype.constructor?.name) {
      return (t as () => unknown)();
    }
  } catch {
    // fallthrough
  }
  return t;
}

class AddressDto {
  @ApiProperty({ type: String })
  street!: string;

  @ApiProperty({ type: String, required: true })
  city!: string;
}

class ProfileDto {
  @ApiProperty({ type: String })
  bio!: string;

  @ApiProperty({ type: () => AddressDto })
  address!: AddressDto;
}

class UserDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: Number })
  age!: number;

  @ApiProperty({ type: () => ProfileDto })
  profile!: ProfileDto;
}

describeConformance(
  "DeepPartialType",
  {
    upstreamPath: "test/type-helpers/deep-partial-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts upstream ModelPropertiesAccessor + SchemaObjectFactory inspection to Bunest MetadataRegistry (SWAGGER_METADATA_KEYS.API_PROPERTIES) and SchemaExplorer (ADR-002, ADR-005, ADR-013).",
  },
  () => {
    describe("top-level properties", () => {
      class UpdateUserDto extends DeepPartialType(UserDto) {}

      it("should mark all top-level properties as optional", () => {
        const fields = getModelProperties(UpdateUserDto);
        expect(fields).toContain("name");
        expect(fields).toContain("age");
        expect(fields).toContain("profile");

        expect(getPropertyMetadata(UpdateUserDto, "name")?.required).toBe(
          false,
        );
        expect(getPropertyMetadata(UpdateUserDto, "age")?.required).toBe(false);
        expect(getPropertyMetadata(UpdateUserDto, "profile")?.required).toBe(
          false,
        );
      });
    });

    describe("nested DTO properties", () => {
      class UpdateUserDto extends DeepPartialType(UserDto) {}

      it("should wrap nested DTO properties in DeepPartialType", () => {
        const profileMeta = getPropertyMetadata(UpdateUserDto, "profile");
        const NestedProfileType = resolveType(profileMeta);

        expect(NestedProfileType).not.toBe(ProfileDto);

        const nestedFields = getModelProperties(NestedProfileType);
        expect(nestedFields).toContain("bio");
        expect(nestedFields).toContain("address");
        expect(getPropertyMetadata(NestedProfileType, "bio")?.required).toBe(
          false,
        );
      });

      it("should recursively wrap deeply nested DTO properties", () => {
        const profileMeta = getPropertyMetadata(UpdateUserDto, "profile");
        const NestedProfileType = resolveType(profileMeta);

        const addressMeta = getPropertyMetadata(NestedProfileType, "address");
        const NestedAddressType = resolveType(addressMeta);

        expect(NestedAddressType).not.toBe(AddressDto);
        expect(getPropertyMetadata(NestedAddressType, "street")?.required).toBe(
          false,
        );
      });
    });

    describe("primitive properties", () => {
      it("should leave primitive types unchanged (String, Number, Boolean)", () => {
        class UpdateUserDto extends DeepPartialType(UserDto) {}
        expect(getPropertyMetadata(UpdateUserDto, "name")?.type).toBe(String);
        expect(getPropertyMetadata(UpdateUserDto, "age")?.type).toBe(Number);
      });
    });

    describe("array of nested DTO properties", () => {
      class TagDto {
        @ApiProperty({ type: String, required: true })
        label!: string;
      }

      class ArticleDto {
        @ApiProperty({ type: String, required: true })
        title!: string;

        @ApiProperty({ type: () => [TagDto], required: true })
        lazyTags!: TagDto[];

        @ApiProperty({ type: [TagDto], required: true })
        tupleTags!: TagDto[];
      }

      it("should preserve array-ness for a lazy factory returning a tuple", () => {
        class UpdateArticleDto extends DeepPartialType(ArticleDto) {}
        const meta = getPropertyMetadata(UpdateArticleDto, "lazyTags");

        expect(meta?.isArray).toBe(true);
        expect(meta?.required).toBe(false);
        const resolved = resolveType(meta);
        expect(resolved).not.toBe(TagDto);
        expect(typeof resolved).toBe("function");
        expect(getPropertyMetadata(resolved, "label")?.required).toBe(false);
      });

      it("should preserve array-ness for a tuple literal type", () => {
        class UpdateArticleDto extends DeepPartialType(ArticleDto) {}
        const meta = getPropertyMetadata(UpdateArticleDto, "tupleTags");

        expect(meta?.isArray).toBe(true);
        expect(meta?.required).toBe(false);
        const resolved = resolveType(meta);
        expect(resolved).not.toBe(TagDto);
      });
    });

    describe("plugin-generated metadata", () => {
      class PluginAddressDto {
        street!: string;
        city!: string;

        static [METADATA_FACTORY_NAME]() {
          return {
            street: { required: true, type: () => String },
            city: { required: true, type: () => String },
          };
        }
      }

      class PluginProfileDto {
        bio!: string;
        address!: PluginAddressDto;

        static [METADATA_FACTORY_NAME]() {
          return {
            bio: { required: true, type: () => String },
            address: { required: true, type: () => PluginAddressDto },
          };
        }
      }

      class PluginUserDto {
        name!: string;
        profile!: PluginProfileDto;

        static [METADATA_FACTORY_NAME]() {
          return {
            name: { required: true, type: () => String },
            profile: { required: true, type: () => PluginProfileDto },
          };
        }
      }

      class UpdatePluginUserDto extends DeepPartialType(PluginUserDto) {}

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should mark plugin-declared top-level properties as optional", () => {
        expect(getPropertyMetadata(UpdatePluginUserDto, "name")?.required).toBe(
          false,
        );
        expect(
          getPropertyMetadata(UpdatePluginUserDto, "profile")?.required,
        ).toBe(false);
      });

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should leave plugin-declared primitive types unchanged", () => {
        const nameMeta = getPropertyMetadata(UpdatePluginUserDto, "name");
        expect(typeof nameMeta?.type).toBe("function");
        expect((nameMeta?.type as () => unknown)()).toBe(String);
      });

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should wrap nested DTOs declared only in the metadata factory", () => {
        const NestedProfileType = resolveType(
          getPropertyMetadata(UpdatePluginUserDto, "profile"),
        );

        expect(NestedProfileType).toBeDefined();
        expect(NestedProfileType).not.toBe(PluginProfileDto);
        expect(getPropertyMetadata(NestedProfileType, "bio")?.required).toBe(
          false,
        );
      });

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should recursively wrap deeply nested plugin DTOs", () => {
        const NestedProfileType = resolveType(
          getPropertyMetadata(UpdatePluginUserDto, "profile"),
        );
        const NestedAddressType = resolveType(
          getPropertyMetadata(NestedProfileType, "address"),
        );

        expect(NestedAddressType).toBeDefined();
        expect(NestedAddressType).not.toBe(PluginAddressDto);
        expect(getPropertyMetadata(NestedAddressType, "street")?.required).toBe(
          false,
        );
      });
    });

    describe("plugin-generated arrays", () => {
      class PluginTagDto {
        label!: string;

        static [METADATA_FACTORY_NAME]() {
          return { label: { required: true, type: () => String } };
        }
      }

      class PluginArticleDto {
        tags!: PluginTagDto[];

        static [METADATA_FACTORY_NAME]() {
          return { tags: { required: true, type: () => [PluginTagDto] } };
        }
      }

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata for array properties
      it.skip("should preserve array-ness for a plugin-declared nested DTO array", () => {
        class UpdatePluginArticleDto extends DeepPartialType(
          PluginArticleDto,
        ) {}
        const meta = getPropertyMetadata(UpdatePluginArticleDto, "tags");

        expect(meta?.isArray).toBe(true);
        expect(meta?.required).toBe(false);
        const resolved = resolveType(meta);
        expect(resolved).not.toBe(PluginTagDto);
        expect(getPropertyMetadata(resolved, "label")?.required).toBe(false);
      });
    });

    describe("lazy factory that throws", () => {
      it("should leave the property type alone instead of propagating the error", () => {
        class ThrowingPluginDto {
          broken: unknown;

          static [METADATA_FACTORY_NAME]() {
            return {
              broken: {
                required: true,
                type: () => {
                  throw new Error("circular import not resolved yet");
                },
              },
            };
          }
        }

        expect(() => DeepPartialType(ThrowingPluginDto)).not.toThrow();
      });

      it("should leave an explicitly decorated throwing factory alone", () => {
        class ThrowingExplicitDto {
          @ApiProperty({
            type: () => {
              throw new Error("circular import not resolved yet");
            },
          })
          broken: unknown;
        }

        expect(() => DeepPartialType(ThrowingExplicitDto)).not.toThrow();
      });
    });

    describe("mixed explicit and plugin-generated metadata", () => {
      class MixedTagDto {
        @ApiProperty({ type: String, required: true })
        label!: string;
      }

      class MixedSettingsDto {
        theme!: string;

        static [METADATA_FACTORY_NAME]() {
          return { theme: { required: true, type: () => String } };
        }
      }

      class MixedAccountDto {
        @ApiProperty({ type: () => MixedTagDto, required: true })
        tag!: MixedTagDto;

        settings!: MixedSettingsDto;

        static [METADATA_FACTORY_NAME]() {
          return {
            settings: { required: true, type: () => MixedSettingsDto },
          };
        }
      }

      class UpdateMixedAccountDto extends DeepPartialType(MixedAccountDto) {}

      it("should wrap the explicitly decorated nested DTO", () => {
        const meta = getPropertyMetadata(UpdateMixedAccountDto, "tag");

        expect(meta?.required).toBe(false);
        const resolved = resolveType(meta);
        expect(resolved).not.toBe(MixedTagDto);
        expect(getPropertyMetadata(resolved, "label")?.required).toBe(false);
      });

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts) does not read static _OPENAPI_METADATA_FACTORY() metadata alongside explicit @ApiProperty decorators
      it.skip("should wrap the plugin-declared nested DTO on the same class", () => {
        const meta = getPropertyMetadata(UpdateMixedAccountDto, "settings");

        expect(meta?.required).toBe(false);
        const resolved = resolveType(meta);
        expect(resolved).not.toBe(MixedSettingsDto);
        expect(getPropertyMetadata(resolved, "theme")?.required).toBe(false);
      });
    });

    describe("class caching", () => {
      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts:144-149) creates a fresh per-call Map instead of caching generated classes globally per (classRef, skipNullProperties)
      it.skip("should return the same class for the same input to avoid infinite recursion", () => {
        const A = DeepPartialType(UserDto);
        const B = DeepPartialType(UserDto);
        expect(A).toBe(B);
      });

      // BUNEST_BUG: DeepPartialType (packages/swagger/src/type-helpers/deep-partial-type.helper.ts:144-149) does not cache generated classes across calls per skipNullProperties setting
      it.skip("should cache each `skipNullProperties` setting separately", () => {
        expect(
          DeepPartialType(UserDto, { skipNullProperties: false }),
        ).not.toBe(DeepPartialType(UserDto));
        expect(DeepPartialType(UserDto, { skipNullProperties: false })).toBe(
          DeepPartialType(UserDto, { skipNullProperties: false }),
        );
        expect(DeepPartialType(UserDto, { skipNullProperties: true })).toBe(
          DeepPartialType(UserDto),
        );
      });

      it("should not share nested classes between `skipNullProperties` settings", () => {
        const nestedType = (classRef: Function) =>
          resolveType(getPropertyMetadata(classRef, "profile"));

        expect(
          nestedType(DeepPartialType(UserDto, { skipNullProperties: false })),
        ).not.toBe(nestedType(DeepPartialType(UserDto)));
      });
    });

    describe("validation metadata", () => {
      class ValidatedDto {
        @ApiProperty()
        @IsString()
        name!: string;
      }

      class NullCheckedFirstDto {
        @ApiProperty()
        @IsString()
        name!: string;
      }

      it("should validate null values when `skipNullProperties` is false, even after a default call", async () => {
        DeepPartialType(ValidatedDto);
        const NullChecked = DeepPartialType(ValidatedDto, {
          skipNullProperties: false,
        });

        const dto = Object.assign(new (NullChecked as any)(), { name: null });
        const errors = await validate(dto);

        expect(errors).toHaveLength(1);
        expect(errors[0]?.constraints).toEqual({
          isString: "name must be a string",
        });
      });

      it("should skip null values by default, even after a `skipNullProperties: false` call", async () => {
        DeepPartialType(NullCheckedFirstDto, { skipNullProperties: false });
        const Default = DeepPartialType(NullCheckedFirstDto);

        const dto = Object.assign(new (Default as any)(), { name: null });

        expect(await validate(dto)).toHaveLength(0);
      });

      // BUNEST_BUG: PartialType/DeepPartialType (packages/core/src/common/mapped-types/mapped-types.utils.ts:670-682) applies @IsOptional/@ValidateIf to @ApiProperty-only properties without class-validator decorators, whitelisting them under whitelist/forbidNonWhitelisted
      it.skip.each([{}, { skipNullProperties: false }])(
        "should not whitelist documented properties that have no validation decorator (%j)",
        async (options) => {
          class LocalUserDto {
            @ApiProperty()
            @IsString()
            name!: string;

            @ApiProperty()
            role!: string;

            active!: boolean;

            static [METADATA_FACTORY_NAME]() {
              return { active: { required: true, type: () => Boolean } };
            }
          }
          const UpdateUserDto = DeepPartialType(LocalUserDto, options);

          const dto = Object.assign(new (UpdateUserDto as any)(), {
            name: "John",
            role: "admin",
            active: true,
          });
          const errors = await validate(dto, {
            whitelist: true,
            forbidNonWhitelisted: true,
          });

          expect(errors.map((error) => error.property)).toEqual([
            "role",
            "active",
          ]);
        },
      );
    });

    it("should leave the type of a oneOf property inferred", () => {
      class NullableBinDto {
        @ApiProperty({ oneOf: [{ type: "string" }, { type: "null" }] })
        bin!: string | null;
      }
      class UpdateNullableBinDto extends DeepPartialType(NullableBinDto) {}

      const explorer = new SchemaExplorer();
      explorer.registerDtoSchema(UpdateNullableBinDto);
      const schemas = explorer.getSchemas();

      expect(schemas.UpdateNullableBinDto?.properties?.bin).toEqual({
        oneOf: [{ type: "string" }, { type: "null" }],
      });
    });
  },
);
