import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as classTransformer from "../../../../../../packages/validation/src/transformer";
import {
  Exclude,
  Expose,
  Transform,
  Type,
  instanceToPlain,
} from "../../../../../../packages/validation/src/transformer";
import * as classValidator from "../../../../../../packages/validation/src/validator";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsInstance,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationError,
} from "../../../../../../packages/validation/src/validator";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
  type ArgumentMetadata,
} from "../../../../../../packages/core/src/common";
import {
  ValidationPipe,
  type TransformerPackageLike,
  type ValidationPipeOptions,
  type ValidatorPackageLike,
} from "../../../../../../packages/validation/src";
import {
  bunestStrictValidationPipe,
  describeConformance,
  expectValidationErrorEnvelope,
  itAdapted,
  nestCompatibleValidationPipe,
} from "../../../../_helpers";

@Exclude()
class TestModelInternal {
  constructor() {}
  @Expose()
  @IsString()
  public prop1!: string;

  @Expose()
  @IsString()
  public prop2!: string;

  @Expose({ groups: ["internal"] })
  @IsString()
  @IsOptional()
  public propInternal!: string;
}

class TestModel {
  @IsString()
  public prop1!: string;

  @IsString()
  public prop2!: string;

  @IsOptional()
  @IsString()
  public optionalProp!: string;
}

class TestModelNoValidation {
  constructor() {}

  public prop1!: string;
  public prop2!: string;
  public optionalProp!: string;
}

describeConformance(
  "ValidationPipe",
  {
    upstreamPath: "packages/common/test/pipes/validation.pipe.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-004", "ADR-005", "ADR-009"],
    notes:
      "Upstream NestJS default tests use nestCompatibleValidationPipe() alongside explicit ADR-009 bunestStrictValidationPipe() & expectValidationErrorEnvelope() tests and ADR-004 explicit-coercion assertions.",
  },
  () => {
    it("should retain array constraints alongside nested property errors", async () => {
      class Child {
        @IsString()
        name!: string;
      }
      class Parent {
        @ArrayMinSize(2, { message: "at least two children" })
        @ValidateNested({ each: true })
        @Type(() => Child)
        children!: Child[];
      }
      const pipe = nestCompatibleValidationPipe();
      await expect(
        pipe.transform(
          { children: [{ name: 42 }] },
          {
            type: "body",
            metatype: Parent,
          },
        ),
      ).rejects.toMatchObject({
        response: {
          message: [
            "at least two children",
            "children.0.name must be a string",
          ],
        },
      });
    });

    it("should include intermediate constraints only once with their parent path", () => {
      const pipe = nestCompatibleValidationPipe() as any;
      const exception = pipe.createExceptionFactory()([
        {
          property: "parent",
          constraints: { invalid: "parent is invalid" },
          children: [
            {
              property: "child",
              constraints: { invalid: "child is invalid" },
              children: [
                {
                  property: "name",
                  constraints: { isString: "name must be a string" },
                },
              ],
            },
          ],
        },
      ]);
      expect(exception.getResponse().message).toEqual([
        "parent is invalid",
        "parent.child is invalid",
        "parent.child.name must be a string",
      ]);
    });

    describe("when errors are nested", () => {
      const nestedErrors = [
        {
          property: "parent",
          constraints: { invalid: "parent is invalid" },
          children: [
            {
              property: "child",
              children: [
                {
                  property: "name",
                  constraints: { isString: "name must be a string" },
                },
                {
                  property: "age",
                  constraints: { isInt: "age must be an integer" },
                },
              ],
            },
          ],
        },
      ];
      const list = [
        "parent is invalid",
        "parent.child.name must be a string",
        "parent.child.age must be an integer",
      ];
      const grouped = {
        parent: ["parent is invalid"],
        "parent.child.name": ["name must be a string"],
        "parent.child.age": ["age must be an integer"],
      };

      it("should add them to a single list rather than copy them for each level", () => {
        const pipe = nestCompatibleValidationPipe() as any;
        const map = spyOn(pipe, "mapChildrenToValidationErrors");

        const exception = pipe.createExceptionFactory()(nestedErrors);
        expect(exception.getResponse().message).toEqual(list);
        expect(map).toHaveBeenCalledTimes(4);
        expect(new Set(map.mock.results.map(({ value }) => value)).size).toBe(
          1,
        );
      });

      it("should add them to a single result rather than copy them for each level", () => {
        const pipe = nestCompatibleValidationPipe({
          errorFormat: "grouped",
        }) as any;
        const group = spyOn(pipe, "groupValidationErrors");

        const exception = pipe.createExceptionFactory()(nestedErrors);
        expect(exception.getResponse().message).toEqual(grouped);
        expect(group).toHaveBeenCalledTimes(3);
        expect(new Set(group.mock.results.map(({ value }) => value)).size).toBe(
          1,
        );
      });

      it("should keep the errors that an override returns", () => {
        class CustomPipe extends ValidationPipe {
          protected override mapChildrenToValidationErrors(
            error: ValidationError,
            parentPath?: string,
          ) {
            return [...super.mapChildrenToValidationErrors(error, parentPath)];
          }
          protected override groupValidationErrors(
            validationErrors: ValidationError[],
            parentPath?: string,
          ) {
            return {
              ...super.groupValidationErrors(validationErrors, parentPath),
            };
          }
        }

        expect(
          (new CustomPipe({ errorFormat: "list" }) as any)
            .createExceptionFactory()(nestedErrors)
            .getResponse().message,
        ).toEqual(list);
        expect(
          (new CustomPipe({ errorFormat: "grouped" }) as any)
            .createExceptionFactory()(nestedErrors)
            .getResponse().message,
        ).toEqual(grouped);
      });
    });

    describe('option: "maxErrorMessagesLength"', () => {
      const omitted = "Further validation errors were omitted";
      const errors = [
        { property: "a", constraints: { isString: "a must be a string" } },
        {
          property: "b",
          children: [
            { property: "c", constraints: { isString: "c must be a string" } },
            { property: "d", constraints: { isString: "d must be a string" } },
          ],
        },
      ];

      it("should use the default limit for a value that is not a number", () => {
        const pipe = nestCompatibleValidationPipe({
          maxErrorMessagesLength: Number.NaN,
        }) as any;
        expect(pipe.maxErrorMessagesLength).toBe(1_000_000);
      });

      it("should leave out the messages past the limit and say so", () => {
        const pipe = nestCompatibleValidationPipe({
          maxErrorMessagesLength: 30,
        }) as any;
        expect(
          pipe.createExceptionFactory()(errors).getResponse().message,
        ).toEqual(["a must be a string", "b.c must be a string", omitted]);
      });

      it('should leave out the messages past the limit in "grouped" format', () => {
        const pipe = nestCompatibleValidationPipe({
          errorFormat: "grouped",
          maxErrorMessagesLength: 30,
        }) as any;
        expect(
          pipe.createExceptionFactory()(errors).getResponse().message,
        ).toEqual({
          a: ["a must be a string"],
          "b.c": ["c must be a string"],
          "...": [omitted],
        });
      });

      it("should not read the errors past the limit", () => {
        const reads: string[] = [];
        const children = new Proxy(
          Array.from({ length: 1000 }, (_, i) => ({
            property: `${i}`,
            constraints: { isString: "must be a string" },
          })),
          {
            get(targetObj, key, receiver) {
              if (typeof key === "string" && /^\d+$/.test(key)) {
                reads.push(key);
              }
              return Reflect.get(targetObj, key, receiver);
            },
          },
        );
        const pipe = nestCompatibleValidationPipe({
          maxErrorMessagesLength: 50,
        }) as any;

        const exception = pipe.createExceptionFactory()([
          { property: "items", children },
        ]);
        expect(exception.getResponse().message.at(-1)).toBe(omitted);
        expect(reads.length).toBeLessThan(10);
      });

      it("should keep every message when the limit is lifted", () => {
        const pipe = nestCompatibleValidationPipe({
          maxErrorMessagesLength: Infinity,
        }) as any;
        expect(
          pipe.createExceptionFactory()(errors).getResponse().message,
        ).toEqual([
          "a must be a string",
          "b.c must be a string",
          "b.d must be a string",
        ]);
      });

      it("should limit the messages to about a million characters by default", () => {
        let error: any = {
          property: "x",
          children: Array.from({ length: 1200 }, () => ({
            property: "y",
            constraints: { isString: "y must be a string" },
          })),
        };
        for (let depth = 0; depth < 500; depth++) {
          error = { property: "x", children: [error] };
        }

        const message: string[] = (nestCompatibleValidationPipe() as any)
          .createExceptionFactory()([error])
          .getResponse().message;
        const length = message.reduce((total, item) => total + item.length, 0);
        expect(message.at(-1)).toBe(omitted);
        expect(length).toBeGreaterThan(990_000);
        expect(length).toBeLessThan(1_010_000);
      });

      it("should add the omission to a copy of the errors", () => {
        class CustomPipe extends ValidationPipe {
          protected override flattenValidationErrors(
            validationErrors: ValidationError[],
          ): string[] {
            return Object.freeze(
              super.flattenValidationErrors(validationErrors),
            ) as unknown as string[];
          }
          protected override groupValidationErrors(
            validationErrors: ValidationError[],
            parentPath?: string,
          ): Record<string, string[]> {
            return Object.freeze(
              super.groupValidationErrors(validationErrors, parentPath),
            ) as Record<string, string[]>;
          }
        }

        expect(
          (
            new CustomPipe({
              errorFormat: "list",
              maxErrorMessagesLength: 30,
            }) as any
          )
            .createExceptionFactory()(errors)
            .getResponse().message,
        ).toEqual(["a must be a string", "b.c must be a string", omitted]);
        expect(
          (
            new CustomPipe({
              errorFormat: "grouped",
              maxErrorMessagesLength: 30,
            }) as any
          )
            .createExceptionFactory()(errors)
            .getResponse().message,
        ).toEqual({
          a: ["a must be a string"],
          "b.c": ["c must be a string"],
          "...": [omitted],
        });
      });
    });

    let target: ValidationPipe;
    const metadata: ArgumentMetadata = {
      type: "body",
      metatype: TestModel,
      data: "",
    };
    const transformMetadata: ArgumentMetadata = {
      type: "body",
      metatype: TestModelInternal,
      data: "",
    };

    describe("transform", () => {
      describe("when validation passes", () => {
        beforeEach(() => {
          target = nestCompatibleValidationPipe();
        });

        it("should return the value unchanged if optional value is not defined", async () => {
          const testObj = { prop1: "value1", prop2: "value2" };
          expect(await target.transform(testObj, {} as any)).toBe(testObj);
          expect(await target.transform(testObj, metadata)).not.toBeInstanceOf(
            TestModel,
          );
        });

        it("should return the value unchanged if optional value is set undefined", async () => {
          const testObj = {
            prop1: "value1",
            prop2: "value2",
            optionalProp: undefined,
          };
          expect(await target.transform(testObj, {} as any)).toBe(testObj);
          expect(await target.transform(testObj, metadata)).not.toBeInstanceOf(
            TestModel,
          );
        });

        it("should return the value unchanged if optional value is null", async () => {
          const testObj = {
            prop1: "value1",
            prop2: "value2",
            optionalProp: null,
          };
          expect(await target.transform(testObj, {} as any)).toBe(testObj);
          expect(await target.transform(testObj, metadata)).not.toBeInstanceOf(
            TestModel,
          );
        });

        it("should return the value unchanged if optional value is set", async () => {
          const testObj = {
            prop1: "value1",
            prop2: "value2",
            optionalProp: "optional value",
          };
          expect(await target.transform(testObj, {} as any)).toBe(testObj);
          expect(await target.transform(testObj, metadata)).not.toBeInstanceOf(
            TestModel,
          );
        });
      });

      describe("when validation fails", () => {
        beforeEach(() => {
          target = nestCompatibleValidationPipe();
        });

        it("should throw an error", async () => {
          const testObj = { prop1: "value1" };
          return expect(
            target.transform(testObj, metadata),
          ).rejects.toBeDefined();
        });

        class TestModel2 {
          @IsString()
          public prop1!: string;

          @IsBoolean()
          public prop2!: string;

          @IsOptional()
          @IsString()
          public optionalProp!: string;
        }
        class TestModelWithNested {
          @IsString()
          prop!: string;

          @IsDefined()
          @Type(() => TestModel2)
          @ValidateNested()
          test!: TestModel2;
        }

        it("should flatten nested errors", async () => {
          let threw = false;
          try {
            const model = new TestModelWithNested();
            model.test = new TestModel2();
            await target.transform(model, {
              type: "body",
              metatype: TestModelWithNested,
            });
          } catch (err: any) {
            threw = true;
            expect(err.getResponse().message).toEqual([
              "prop must be a string",
              "test.prop1 must be a string",
              "test.prop2 must be a boolean value",
            ]);
          }
          expect(threw).toBe(true);
        });

        class TestModelForNestedArrayValidation {
          @IsString()
          public prop!: string;

          @IsArray()
          @ValidateNested()
          @Type(() => TestModel2)
          public test!: TestModel2[];
        }

        it("should provide complete path for nested errors", async () => {
          let threw = false;
          try {
            const model = new TestModelForNestedArrayValidation();
            model.test = [new TestModel2()];
            await target.transform(model, {
              type: "body",
              metatype: TestModelForNestedArrayValidation,
            });
          } catch (err: any) {
            threw = true;
            expect(err.getResponse().message).toEqual([
              "prop must be a string",
              "test.0.prop1 must be a string",
              "test.0.prop2 must be a boolean value",
            ]);
          }
          expect(threw).toBe(true);
        });

        describe('when errorFormat is "grouped"', () => {
          beforeEach(() => {
            target = nestCompatibleValidationPipe({ errorFormat: "grouped" });
          });

          it("should return grouped errors with property paths as keys", async () => {
            let threw = false;
            try {
              const model = new TestModelWithNested();
              model.test = new TestModel2();
              await target.transform(model, {
                type: "body",
                metatype: TestModelWithNested,
              });
            } catch (err: any) {
              threw = true;
              expect(err.getResponse().message).toEqual({
                prop: ["prop must be a string"],
                "test.prop1": ["prop1 must be a string"],
                "test.prop2": ["prop2 must be a boolean value"],
              });
            }
            expect(threw).toBe(true);
          });

          it("should return grouped errors for nested arrays", async () => {
            let threw = false;
            try {
              const model = new TestModelForNestedArrayValidation();
              model.test = [new TestModel2()];
              await target.transform(model, {
                type: "body",
                metatype: TestModelForNestedArrayValidation,
              });
            } catch (err: any) {
              threw = true;
              expect(err.getResponse().message).toEqual({
                prop: ["prop must be a string"],
                "test.0.prop1": ["prop1 must be a string"],
                "test.0.prop2": ["prop2 must be a boolean value"],
              });
            }
            expect(threw).toBe(true);
          });

          class NestedChildWithCustomMessage {
            @IsNotEmpty({ message: "Name is required" })
            @IsString({ message: "Name must be a string" })
            name!: string;
          }

          class ParentWithCustomMessage {
            @IsString()
            title!: string;

            @IsDefined()
            @Type(() => NestedChildWithCustomMessage)
            @ValidateNested()
            child!: NestedChildWithCustomMessage;
          }

          it("should preserve custom validation messages without prepending parent path", async () => {
            let threw = false;
            try {
              const model = new ParentWithCustomMessage();
              model.child = new NestedChildWithCustomMessage();
              await target.transform(model, {
                type: "body",
                metatype: ParentWithCustomMessage,
              });
            } catch (err: any) {
              threw = true;
              const message = err.getResponse().message;
              expect(message.title).toEqual(["title must be a string"]);
              expect(message["child.name"]).toEqual(
                expect.arrayContaining([
                  "Name is required",
                  "Name must be a string",
                ]),
              );
              expect(message["child.name"]).not.toEqual(
                expect.arrayContaining([
                  "child.Name is required",
                  "child.Name must be a string",
                ]),
              );
            }
            expect(threw).toBe(true);
          });
        });
      });

      describe("when validation transforms", () => {
        it("should return a TestModel instance", async () => {
          target = nestCompatibleValidationPipe({ transform: true });
          const testObj = {
            prop1: "value1",
            prop2: "value2",
            prop3: "value3",
          };
          expect(await target.transform(testObj, metadata)).toBeInstanceOf(
            TestModel,
          );
        });

        describe("when input is a query parameter (number)", () => {
          itAdapted(
            ["ADR-004", "ADR-005", "ADR-009"],
            "does not implicitly coerce query string to number (explicit ParseFloatPipe / @Type required)",
            async () => {
              target = nestCompatibleValidationPipe({ transform: true });
              const value = "3.14";

              expect(
                await target.transform(value, {
                  metatype: Number,
                  data: "test",
                  type: "query",
                }),
              ).toBe(value);
            },
            "no implicit primitive coercion",
          );

          it("should parse undefined to undefined", async () => {
            target = nestCompatibleValidationPipe({ transform: true });
            const value = undefined;

            expect(
              await target.transform(value, {
                metatype: Number,
                data: "test",
                type: "query",
              }),
            ).toBeUndefined();
          });
        });

        describe("when input is a path parameter (number)", () => {
          itAdapted(
            ["ADR-004", "ADR-005", "ADR-009"],
            "does not implicitly coerce path param string to number",
            async () => {
              target = nestCompatibleValidationPipe({ transform: true });
              const value = "3.14";

              expect(
                await target.transform(value, {
                  metatype: Number,
                  data: "test",
                  type: "param",
                }),
              ).toBe(value);
            },
            "no implicit primitive coercion",
          );

          it("should parse undefined to undefined", async () => {
            target = nestCompatibleValidationPipe({ transform: true });
            const value = undefined;

            expect(
              await target.transform(value, {
                metatype: Number,
                data: "test",
                type: "param",
              }),
            ).toBeUndefined();
          });
        });

        describe("when input is a query parameter (boolean)", () => {
          itAdapted(
            ["ADR-004", "ADR-005", "ADR-009"],
            'does not implicitly coerce query string "true", "false", or "" to boolean',
            async () => {
              target = nestCompatibleValidationPipe({ transform: true });

              expect(
                await target.transform("true", {
                  metatype: Boolean,
                  data: "test",
                  type: "query",
                }),
              ).toBe("true");
              expect(
                await target.transform("false", {
                  metatype: Boolean,
                  data: "test",
                  type: "query",
                }),
              ).toBe("false");
              expect(
                await target.transform("", {
                  metatype: Boolean,
                  data: "test",
                  type: "query",
                }),
              ).toBe("");
            },
            "no implicit primitive coercion",
          );

          it("should parse undefined to undefined", async () => {
            target = nestCompatibleValidationPipe({ transform: true });
            const value = undefined;

            expect(
              await target.transform(value, {
                metatype: Boolean,
                data: "test",
                type: "query",
              }),
            ).toBeUndefined();
          });
        });

        describe("when input is a path parameter (boolean)", () => {
          itAdapted(
            ["ADR-004", "ADR-005", "ADR-009"],
            'does not implicitly coerce path param string "true", "false", or "" to boolean',
            async () => {
              target = nestCompatibleValidationPipe({ transform: true });

              expect(
                await target.transform("true", {
                  metatype: Boolean,
                  data: "test",
                  type: "param",
                }),
              ).toBe("true");
              expect(
                await target.transform("false", {
                  metatype: Boolean,
                  data: "test",
                  type: "param",
                }),
              ).toBe("false");
              expect(
                await target.transform("", {
                  metatype: Boolean,
                  data: "test",
                  type: "param",
                }),
              ).toBe("");
            },
            "no implicit primitive coercion",
          );

          it("should parse undefined to undefined", async () => {
            target = nestCompatibleValidationPipe({ transform: true });
            const value = undefined;

            expect(
              await target.transform(value, {
                metatype: Boolean,
                data: "test",
                type: "param",
              }),
            ).toBeUndefined();
          });
        });

        describe("when validation strips", () => {
          it("should return a TestModel without extra properties", async () => {
            target = nestCompatibleValidationPipe({ whitelist: true });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
            };
            expect(
              await target.transform(testObj, metadata),
            ).not.toBeInstanceOf(TestModel);
            expect(
              await target.transform(testObj, metadata),
            ).not.toHaveProperty("prop3");
          });
        });

        describe("when validation rejects", () => {
          it("should throw an error", async () => {
            target = nestCompatibleValidationPipe({
              forbidNonWhitelisted: true,
              whitelist: true,
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
            };
            await expect(
              target.transform(testObj, metadata),
            ).rejects.toBeDefined();
          });
        });

        describe("when transformation is internal", () => {
          it("should return a TestModel with internal property", async () => {
            target = nestCompatibleValidationPipe({
              transform: true,
              transformOptions: { groups: ["internal"] },
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              propInternal: "value3",
            };
            expect(
              await target.transform(testObj, transformMetadata),
            ).toHaveProperty("propInternal");
          });
        });

        describe("when transformation is external", () => {
          it("should return a TestModel without internal property", async () => {
            target = nestCompatibleValidationPipe({
              transform: true,
              transformOptions: { groups: ["external"] },
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              propInternal: "value3",
            };
            expect(
              await target.transform(testObj, transformMetadata),
            ).not.toHaveProperty("propInternal");
          });
        });
      });

      describe("when validation does not transform", () => {
        describe("when validation strips", () => {
          it("should return a plain object without extra properties", async () => {
            target = nestCompatibleValidationPipe({
              transform: false,
              whitelist: true,
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
            };
            const result = await target.transform(testObj, metadata);

            expect(result).not.toBeInstanceOf(TestModel);
            expect(result).not.toHaveProperty("prop3");
            expect(result).not.toHaveProperty("optionalProp");
          });

          it("should return a plain object without extra properties if optional prop is defined", async () => {
            target = nestCompatibleValidationPipe({
              transform: false,
              whitelist: true,
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
              optionalProp: "optional value",
            };
            const result = await target.transform(testObj, metadata);
            expect(result).not.toBeInstanceOf(TestModel);
            expect(result).not.toHaveProperty("prop3");
            expect(result).toHaveProperty("optionalProp");
          });

          it("should return a plain object without extra properties if optional prop is undefined", async () => {
            target = nestCompatibleValidationPipe({
              transform: false,
              whitelist: true,
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
              optionalProp: undefined,
            };
            const result = await target.transform(testObj, metadata);
            expect(result).not.toBeInstanceOf(TestModel);
            expect(result).not.toHaveProperty("prop3");
            expect(result).toHaveProperty("optionalProp");
          });

          it("should return a plain object without extra properties if optional prop is null", async () => {
            target = nestCompatibleValidationPipe({
              transform: false,
              whitelist: true,
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
              optionalProp: null,
            };

            const result = await target.transform(testObj, metadata);
            expect(result).not.toBeInstanceOf(TestModel);
            expect(result).not.toHaveProperty("prop3");
            expect(result).toHaveProperty("optionalProp");
          });
        });

        describe("when validation rejects", () => {
          it("should throw an error", async () => {
            target = nestCompatibleValidationPipe({
              transform: false,
              forbidNonWhitelisted: true,
              whitelist: true,
            });
            const testObj = {
              prop1: "value1",
              prop2: "value2",
              prop3: "value3",
            };
            await expect(
              target.transform(testObj, metadata),
            ).rejects.toBeDefined();
          });
        });
      });

      describe("when the value holds a sparse array", () => {
        class TagsDto {
          @IsArray()
          @IsString({ each: true })
          tags!: string[];
        }
        const tagsMetadata: ArgumentMetadata = {
          type: "body",
          metatype: TagsDto,
          data: "",
        };
        const sparse = () => {
          const tags: string[] = [];
          tags[1000] = "a";
          return tags;
        };

        it("should return the array that was validated, without its gaps", async () => {
          for (const options of [
            {},
            { transform: true },
            { whitelist: true },
          ] as ValidationPipeOptions[]) {
            target = nestCompatibleValidationPipe(options);
            const value = { tags: sparse() };
            const result = (await target.transform(
              value,
              tagsMetadata,
            )) as TagsDto;
            expect(result.tags).toEqual(["a"]);
            expect(result.tags).toHaveLength(1);
          }
        });

        it("should close the gaps in place, as it strips prototype keys", async () => {
          target = nestCompatibleValidationPipe({ transform: true });
          const value = { tags: sparse() };
          const { tags } = value;
          await target.transform(value, tagsMetadata);
          expect(tags).toEqual(["a"]);
          expect(value.tags).toBe(tags);
        });

        it("should validate the items that are present", async () => {
          target = nestCompatibleValidationPipe();
          const tags: unknown[] = [];
          tags[3] = 1;
          await expect(
            target.transform({ tags }, tagsMetadata),
          ).rejects.toBeDefined();
        });

        it("should let a subclass override closeArrayGaps", async () => {
          class KeepGapsPipe extends ValidationPipe {
            protected override closeArrayGaps() {}
          }
          target = new KeepGapsPipe({
            transform: false,
            whitelist: false,
            forbidNonWhitelisted: false,
            errorFormat: "list",
          });
          const result = (await target.transform(
            { tags: sparse() },
            tagsMetadata,
          )) as TagsDto;
          expect(result.tags).toHaveLength(1001);
        });
      });

      describe("when type doesn't match", () => {
        describe("when validation rules are applied", () => {
          it("should throw an error", async () => {
            target = nestCompatibleValidationPipe();
            const testObj = [
              { prop1: "value1", prop2: "value2", prop3: "value3" },
            ];

            await expect(
              target.transform(testObj, metadata),
            ).rejects.toBeDefined();
            await expect(
              target.transform("string", metadata),
            ).rejects.toBeDefined();
            await expect(
              target.transform(true, metadata),
            ).rejects.toBeDefined();
            await expect(target.transform(3, metadata)).rejects.toBeDefined();
          });
        });

        describe("when no validation rule is required", () => {
          class TestModelAllOptional {
            @IsOptional()
            @IsString()
            public prop1!: string;
          }
          const optionalMetadata: ArgumentMetadata = {
            type: "body",
            metatype: TestModelAllOptional,
            data: "",
          };
          const rejection = {
            response: { message: ["Validation failed (object is expected)"] },
          };

          it("should throw an error for an array or a primitive", async () => {
            for (const options of [
              {},
              { transform: true },
              { whitelist: true },
              { forbidUnknownValues: true },
            ] as ValidationPipeOptions[]) {
              target = nestCompatibleValidationPipe(options);
              for (const value of [[], [{ prop1: 1 }], "string", 3, true]) {
                await expect(
                  target.transform(value, optionalMetadata),
                ).rejects.toMatchObject(rejection);
              }
            }
          });

          it("should throw an error for a binary value", async () => {
            for (const options of [
              {},
              { transform: true },
              { forbidUnknownValues: true },
              { whitelist: true },
              { whitelist: true, transform: true },
              { whitelist: true, forbidNonWhitelisted: true },
            ] as ValidationPipeOptions[]) {
              target = nestCompatibleValidationPipe(options);
              for (const binary of [Buffer.alloc(0), Buffer.from("{}")]) {
                await expect(
                  target.transform(binary, optionalMetadata),
                ).rejects.toMatchObject(rejection);
              }
            }
          });

          it("should validate the rules of the class for a binary value", async () => {
            target = nestCompatibleValidationPipe({
              whitelist: true,
              forbidNonWhitelisted: true,
            });
            await expect(
              target.transform(Buffer.from("abc"), metadata),
            ).rejects.toMatchObject({
              response: {
                message: ["prop1 must be a string", "prop2 must be a string"],
              },
            });
          });

          it("should return a binary value as it is for a class without rules", async () => {
            const binary = Buffer.from("abc");
            for (const options of [
              { whitelist: true },
              { transform: true },
            ] as ValidationPipeOptions[]) {
              target = nestCompatibleValidationPipe(options);
              expect(
                await target.transform(binary, {
                  ...optionalMetadata,
                  metatype: TestModelNoValidation,
                }),
              ).toEqual(binary);
            }
            expect(binary.toString()).toBe("abc");
          });

          it("should throw an error for an empty array when non-whitelisted properties are forbidden", async () => {
            target = nestCompatibleValidationPipe({
              whitelist: true,
              forbidNonWhitelisted: true,
            });
            await expect(
              target.transform([], optionalMetadata),
            ).rejects.toMatchObject(rejection);
          });

          it("should pass the error to the exception factory", async () => {
            target = nestCompatibleValidationPipe({
              exceptionFactory: (errors) => errors,
            });
            await expect(
              target.transform([], { ...optionalMetadata, data: "items" }),
            ).rejects.toEqual([
              {
                property: "items",
                constraints: {
                  isObject: "Validation failed (object is expected)",
                },
                children: [],
              },
            ]);
          });

          itAdapted(
            "ADR-009",
            "should accept plain object and reject undefined when DTO metatype is expected",
            async () => {
              target = nestCompatibleValidationPipe({ transform: true });
              expect(
                await target.transform({ prop1: "value1" }, optionalMetadata),
              ).toBeInstanceOf(TestModelAllOptional);
              await expect(
                target.transform(undefined, optionalMetadata),
              ).rejects.toBeInstanceOf(HttpException);
            },
            "ADR-009 Guard 1 rejects undefined for DTO metatypes",
          );
        });

        describe("when missing properties are skipped", () => {
          it("should throw an error for an array or a primitive", async () => {
            target = nestCompatibleValidationPipe({
              skipMissingProperties: true,
            });
            for (const value of [
              [],
              [{ prop1: "value1", prop2: "value2" }],
              "string",
            ]) {
              await expect(
                target.transform(value, metadata),
              ).rejects.toMatchObject({
                response: {
                  message: ["Validation failed (object is expected)"],
                },
              });
            }
          });
        });

        describe("when the transformer returns plain objects", () => {
          it("should not throw an error for an object", async () => {
            target = nestCompatibleValidationPipe({
              forbidUnknownValues: false,
              transformerPackage: {
                plainToInstance: ((_metatype: unknown, plain: unknown) => ({
                  ...(plain as object),
                })) as TransformerPackageLike["plainToInstance"],
              },
            });
            const testObj = { prop1: "value1", prop2: "value2" };
            expect(await target.transform(testObj, metadata)).toBe(testObj);
          });
        });

        describe("when the metatype is not a class", () => {
          it("should not throw an error", async () => {
            const Role = { Admin: "admin" };
            target = nestCompatibleValidationPipe();
            const enumMetadata = {
              type: "query",
              metatype: Role as unknown as Function,
              data: "role",
            } as ArgumentMetadata;

            expect(await target.transform("admin", enumMetadata)).toBe("admin");
            expect(
              await target.transform(undefined, enumMetadata),
            ).toBeUndefined();
          });
        });

        describe("otherwise", () => {
          it("should not reject", async () => {
            target = nestCompatibleValidationPipe({
              forbidUnknownValues: false,
            });
            const testObj = [
              { prop1: "value1", prop2: "value2", prop3: "value3" },
            ];

            const objMetadata = {
              ...metadata,
              metatype: TestModelNoValidation,
            };
            const result = await target.transform(testObj, objMetadata);

            expect(result).not.toBeInstanceOf(TestModel);
            expect(result).toEqual(testObj);

            expect(await target.transform("string", objMetadata)).toEqual(
              "string",
            );
            expect(await target.transform(3, objMetadata)).toEqual(3);
            expect(await target.transform(true, objMetadata)).toEqual(true);
          });

          it('should not leave a "constructor" key on the value', async () => {
            target = nestCompatibleValidationPipe({
              transform: true,
              forbidUnknownValues: false,
            });
            const objMetadata = {
              ...metadata,
              metatype: TestModelNoValidation,
            };

            for (const value of [[], [{ prop1: "value1" }], Buffer.alloc(0)]) {
              const result = (await target.transform(
                value,
                objMetadata,
              )) as object;
              expect(Object.hasOwn(result, "constructor")).toBe(false);
            }
          });

          it("should not make a copy of the value look like an instance of the class", async () => {
            class UserEntity {
              name!: string;

              @Exclude()
              passwordHash!: string;
            }
            target = nestCompatibleValidationPipe({
              transform: true,
              forbidUnknownValues: false,
            });
            const dto = (await target.transform([], {
              ...metadata,
              metatype: TestModelNoValidation,
            })) as Record<string, unknown>;

            const user = Object.assign(new UserEntity(), {
              ...dto,
              name: "name",
              passwordHash: "hash",
            });
            expect(instanceToPlain(user)).toEqual({ name: "name" });
          });
        });
      });
    });

    describe("when a nested value is binary", () => {
      class Nested {
        @IsString()
        public prop!: string;
      }
      class WithNested {
        @IsOptional()
        @IsObject()
        @ValidateNested()
        @Type(() => Nested)
        public nested!: Nested;

        @IsOptional()
        @IsArray()
        @ValidateNested({ each: true })
        @Type(() => Nested)
        public items!: Nested[];

        @ValidateIf((object) => object.kind === "nested")
        @ValidateNested()
        @Type(() => Nested)
        public conditional!: Nested;

        @IsOptional()
        @IsString()
        public kind!: string;

        @IsOptional()
        @IsInstance(Buffer)
        public file!: Buffer;
      }
      class WithDeepNested {
        @ValidateNested()
        @Type(() => WithNested)
        public parent!: WithNested;
      }
      const nestedMetadata: ArgumentMetadata = {
        type: "body",
        metatype: WithNested,
        data: "",
      };
      const nestedMessage =
        "nested property nested must be either object or array";
      const itemsMessage =
        "each value in nested property items must be either object or array";

      it("should throw an error instead of skipping the rules of the nested class", async () => {
        for (const options of [
          {},
          { transform: true },
          { whitelist: true },
          { whitelist: true, forbidNonWhitelisted: true, transform: true },
          { forbidUnknownValues: true },
        ] as ValidationPipeOptions[]) {
          target = nestCompatibleValidationPipe(options);
          for (const binary of [Buffer.alloc(0), Buffer.from("abc")]) {
            await expect(
              target.transform({ nested: binary }, nestedMetadata),
            ).rejects.toMatchObject({ response: { message: [nestedMessage] } });
            await expect(
              target.transform(
                { items: [{ prop: "value" }, binary] },
                nestedMetadata,
              ),
            ).rejects.toMatchObject({
              response: { message: [`items.${itemsMessage}`] },
            });
          }
        }
      });

      it("should throw an error for a binary value in place of the items or in a nested array", async () => {
        target = nestCompatibleValidationPipe();
        await expect(
          target.transform({ items: Buffer.alloc(0) }, nestedMetadata),
        ).rejects.toMatchObject({ response: { message: [itemsMessage] } });
        await expect(
          target.transform({ items: [[Buffer.alloc(0)]] }, nestedMetadata),
        ).rejects.toMatchObject({
          response: { message: [`items.0.${itemsMessage}`] },
        });
      });

      it("should pass the path of the value to the exception factory", async () => {
        target = nestCompatibleValidationPipe({
          exceptionFactory: (errors) => errors,
        });
        await expect(
          target.transform(
            { parent: { nested: Buffer.alloc(0), items: [Buffer.alloc(0)] } },
            { ...nestedMetadata, metatype: WithDeepNested },
          ),
        ).rejects.toEqual([
          {
            property: "parent",
            children: [
              {
                property: "nested",
                constraints: { nestedValidation: nestedMessage },
                children: [],
              },
              {
                property: "items",
                children: [
                  {
                    property: "0",
                    constraints: { nestedValidation: itemsMessage },
                    children: [],
                  },
                ],
              },
            ],
          },
        ]);
      });

      it("should keep a custom message of the nested validation", async () => {
        class WithMessage {
          @ValidateNested({ message: "$property must be an address" })
          @Type(() => Nested)
          public address!: Nested;
        }
        target = nestCompatibleValidationPipe();
        await expect(
          target.transform(
            { address: Buffer.alloc(0) },
            { ...nestedMetadata, metatype: WithMessage },
          ),
        ).rejects.toMatchObject({
          response: { message: ["address must be an address"] },
        });
      });

      it("should not throw an error for a binary value that is not validated as a nested one", async () => {
        const file = Buffer.from("abc");
        target = nestCompatibleValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        });
        const result = (await target.transform(
          {
            file,
            conditional: file,
            nested: { prop: "value" },
            items: [{ prop: "value" }],
          },
          nestedMetadata,
        )) as WithNested;
        expect(result).toBeInstanceOf(WithNested);
        expect(result.file).toEqual(file);
        expect(result.conditional).toEqual(file as unknown as Nested);
        expect(result.nested).toBeInstanceOf(Nested);

        await expect(
          target.transform(
            { kind: "nested", conditional: file },
            nestedMetadata,
          ),
        ).rejects.toBeDefined();
      });

      it("should not throw an error when the validator has no metadata storage", async () => {
        target = nestCompatibleValidationPipe({
          validatorPackage: {
            validate: (() => []) as unknown as ValidatorPackageLike["validate"],
          },
        });
        const value = { nested: Buffer.alloc(0) };
        expect(await target.transform(value, nestedMetadata)).toBe(value);
      });

      it("should report a binary sibling inside a self-circular plain object without leaking constructor", async () => {
        target = nestCompatibleValidationPipe({
          errorFormat: "grouped",
          transformerPackage: {
            plainToInstance: ((_metatype: unknown, val: unknown) =>
              val) as TransformerPackageLike["plainToInstance"],
          },
        });
        const value: Record<string, unknown> = {
          items: [Buffer.alloc(0)],
        };
        value.nested = value;

        await expect(
          target.transform(value, nestedMetadata),
        ).rejects.toHaveProperty("response.message", {
          "items.0": [itemsMessage],
        });
        expect(Object.hasOwn(value, "constructor")).toBe(false);
      });

      it("should report a binary sibling inside mutually circular objects produced by @Transform", async () => {
        const inner = new WithNested();
        const outer = new WithNested();
        outer.nested = inner as unknown as Nested;
        inner.nested = outer as unknown as Nested;
        inner.items = [Buffer.alloc(0) as unknown as Nested];

        class WithTransformedNested {
          @Transform(() => outer)
          @ValidateNested()
          public nested!: WithNested;
        }

        target = nestCompatibleValidationPipe({ errorFormat: "grouped" });
        await expect(
          target.transform(
            { nested: {} },
            { ...nestedMetadata, metatype: WithTransformedNested },
          ),
        ).rejects.toHaveProperty("response.message", {
          "nested.nested.items.0": [itemsMessage],
        });
      });

      it.each([
        [
          "array",
          () => {
            const array: unknown[] = [];
            array.push(array, Buffer.alloc(0));
            return array;
          },
        ],
        [
          "set",
          () => {
            const set = new Set<unknown>();
            set.add(set).add(Buffer.alloc(0));
            return set;
          },
        ],
        [
          "map",
          () => {
            const map = new Map<number, unknown>();
            map.set(0, map).set(1, Buffer.alloc(0));
            return map;
          },
        ],
      ])(
        "should report binary values after a circular reference in a shared %s",
        async (_, createCollection) => {
          class WithSharedCircularCollections {
            @ValidateNested()
            public first!: unknown;

            @ValidateNested()
            public second!: unknown;
          }

          target = nestCompatibleValidationPipe({
            errorFormat: "grouped",
            transformerPackage: {
              plainToInstance: ((_metatype: unknown, val: unknown) =>
                val) as TransformerPackageLike["plainToInstance"],
            },
          });
          const collection = createCollection();
          const value = { first: collection, second: collection };

          await expect(
            target.transform(value, {
              ...nestedMetadata,
              metatype: WithSharedCircularCollections,
            }),
          ).rejects.toHaveProperty("response.message", {
            "first.1": ["nested property first must be either object or array"],
            "second.1": [
              "nested property second must be either object or array",
            ],
          });
          expect(Object.hasOwn(value, "constructor")).toBe(false);
        },
      );

      it("should still reject a binary value in a shared object when an earlier property is excluded by @ValidateIf", async () => {
        const shared = new WithNested();
        shared.nested = Buffer.alloc(0) as unknown as Nested;

        class WithSharedNested {
          @Transform(() => shared)
          @ValidateIf(() => false)
          @ValidateNested()
          public skipped!: WithNested;

          @Transform(() => shared)
          @ValidateNested()
          public active!: WithNested;
        }

        target = nestCompatibleValidationPipe({ errorFormat: "grouped" });
        await expect(
          target.transform(
            { skipped: {}, active: {} },
            { ...nestedMetadata, metatype: WithSharedNested },
          ),
        ).rejects.toHaveProperty("response.message", {
          "active.nested": [nestedMessage],
        });
      });

      it("should not follow a cycle under a property that a condition rules out", async () => {
        const cyclic = new WithNested();
        cyclic.nested = cyclic as unknown as Nested;

        class WithSkippedCycle {
          @Transform(() => cyclic)
          @ValidateIf(() => false)
          @ValidateNested()
          public skipped!: WithNested;
        }

        target = nestCompatibleValidationPipe();
        const value = { skipped: {} };
        expect(
          await target.transform(value, {
            ...nestedMetadata,
            metatype: WithSkippedCycle,
          }),
        ).toBe(value);
      });

      it('should not follow a cycle that "stopAtFirstError" keeps class-validator from', async () => {
        const cyclic = new WithNested();
        cyclic.nested = cyclic as unknown as Nested;

        class WithStoppedCycle {
          @Transform(() => cyclic)
          @IsString()
          @ValidateNested()
          public stopped!: WithNested;
        }

        target = nestCompatibleValidationPipe({ stopAtFirstError: true });
        await expect(
          target.transform(
            { stopped: {} },
            { ...nestedMetadata, metatype: WithStoppedCycle },
          ),
        ).rejects.toHaveProperty("response.message", [
          "stopped must be a string",
        ]);
      });

      it("should preserve single getter evaluation on a non-circular DTO without own object properties", async () => {
        let reads = 0;
        class WithNestedGetter {
          @IsString()
          public label!: string;

          @ValidateNested()
          public get computed(): Nested | undefined {
            reads++;
            return reads === 1 ? undefined : ("invalid" as unknown as Nested);
          }
        }

        target = nestCompatibleValidationPipe();
        const result = await target.transform(
          { label: "ok" },
          { ...nestedMetadata, metatype: WithNestedGetter },
        );
        expect(result).toEqual({ label: "ok" });
        expect(reads).toBe(1);
      });

      it("should remove temporary constructor when validate throws an unexpected error", async () => {
        const validationFailure = new Error("validator failed");
        target = nestCompatibleValidationPipe({
          transformerPackage: {
            plainToInstance: ((_metatype: unknown, val: unknown) =>
              val) as TransformerPackageLike["plainToInstance"],
          },
          validatorPackage: {
            validate: (() =>
              Promise.reject(
                validationFailure,
              )) as unknown as ValidatorPackageLike["validate"],
          },
        });
        const value = { nested: {} };

        await expect(target.transform(value, nestedMetadata)).rejects.toBe(
          validationFailure,
        );
        expect(Object.hasOwn(value, "constructor")).toBe(false);
      });
    });

    describe('option: "validateCustomDecorators" when metadata.type is not `body`', () => {
      describe("when is set to `true`", () => {
        it("should transform and validate", async () => {
          const pipe = nestCompatibleValidationPipe({
            validateCustomDecorators: true,
          });

          const customMeta: ArgumentMetadata = {
            type: "custom",
            metatype: TestModel,
            data: "",
          };

          const testObj = { prop1: "value1", prop2: "value2" };
          expect(await pipe.transform(testObj, customMeta)).not.toBeUndefined();
        });
      });

      describe("when is set to `false`", () => {
        it("should skip validation and return raw object", async () => {
          const pipe = nestCompatibleValidationPipe({
            validateCustomDecorators: false,
          });

          const customMeta: ArgumentMetadata = {
            type: "custom",
            metatype: TestModel,
            data: "",
          };

          const objNotFollowingTestModel = {
            prop1: undefined,
            prop2: "value2",
          };
          expect(
            await pipe.transform(objNotFollowingTestModel, customMeta),
          ).not.toBeUndefined();
        });
      });

      describe("when is not supplied", () => {
        it("should skip custom decorator validation by default", async () => {
          const pipe = nestCompatibleValidationPipe({});

          const customMeta: ArgumentMetadata = {
            type: "custom",
            metatype: TestModel,
            data: "",
          };

          const testObj = { prop1: "value1", prop2: "value2" };
          expect(await pipe.transform(testObj, customMeta)).not.toBeUndefined();
        });
      });
    });

    describe('option: "errorHttpStatusCode"', () => {
      describe("when validation fails", () => {
        it("should throw UnprocessableEntityException in list errorFormat", async () => {
          target = nestCompatibleValidationPipe({
            errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          });
          const testObj = { prop1: "value1" };
          let threw = false;
          try {
            await target.transform(testObj, metadata);
          } catch (err) {
            threw = true;
            expect(err).toBeInstanceOf(UnprocessableEntityException);
          }
          expect(threw).toBe(true);
        });

        itAdapted(
          "ADR-009",
          "should throw UnprocessableEntityException with normalized envelope in default bunest errorFormat",
          async () => {
            const strictPipe = bunestStrictValidationPipe({
              errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            });
            const testObj = { prop1: "value1" };
            let caught: unknown;
            try {
              await strictPipe.transform(testObj, metadata);
            } catch (err) {
              caught = err;
            }
            expect(caught).toBeInstanceOf(UnprocessableEntityException);
            expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              {
                statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                fields: ["prop2"],
              },
            );
          },
          "ADR-009 custom errorHttpStatusCode",
        );
      });
    });

    describe('option: "validationError"', () => {
      class Item {
        @IsString()
        name!: string;
      }
      class Order {
        @ValidateNested({ each: true })
        @Type(() => Item)
        items!: Item[];
      }
      const orderMetadata: ArgumentMetadata = {
        type: "body",
        metatype: Order,
      };
      const orderOf = (length: number) => ({
        items: Array.from({ length }, () => ({ name: 1 })),
      });
      const exceptionFactory = (errors: ValidationError[]) => errors;

      itAdapted(
        "ADR-009",
        "should omit both target and value from ValidationError by default",
        async () => {
          target = nestCompatibleValidationPipe({ exceptionFactory });

          await expect(
            target.transform(orderOf(1), orderMetadata),
          ).rejects.toEqual([
            {
              property: "items",
              children: [
                {
                  property: "0",
                  children: [
                    {
                      property: "name",
                      children: [],
                      constraints: { isString: "name must be a string" },
                    },
                  ],
                },
              ],
            },
          ]);
        },
        "ADR-009 validationError defaults to { target: false, value: false }",
      );

      it("should not expose the target of non-whitelisted properties by default", async () => {
        target = nestCompatibleValidationPipe({
          exceptionFactory,
          whitelist: true,
          forbidNonWhitelisted: true,
        });

        const errors = (await target
          .transform({ items: [], a: 1, b: 2 }, orderMetadata)
          .catch((err) => err)) as ValidationError[];
        expect(errors.map((error) => error.property)).toEqual(["a", "b"]);
        errors.forEach((error) => expect(error).not.toHaveProperty("target"));
      });

      it("should not repeat the validated array in each of its errors", async () => {
        target = nestCompatibleValidationPipe({ exceptionFactory });
        const sizeOfErrors = async (length: number) =>
          JSON.stringify(
            await target
              .transform(orderOf(length), orderMetadata)
              .catch((err) => err),
          ).length;

        expect(await sizeOfErrors(200)).toBeLessThan(
          3 * (await sizeOfErrors(100)),
        );
      });

      itAdapted(
        "ADR-009",
        "should not repeat a nested value in any error above or at the leaf by default",
        async () => {
          class NestedOrder {
            @ValidateNested({ each: true })
            @Type(() => Item)
            items!: unknown[];
          }
          target = nestCompatibleValidationPipe({ exceptionFactory });
          const item = "a".repeat(1_000);
          const depth = 100;
          let items: unknown = [item];
          for (let i = 0; i < depth; i++) {
            items = [items];
          }

          const errors = (await target
            .transform({ items }, { type: "body", metatype: NestedOrder })
            .catch((err) => err)) as ValidationError[];

          let error: ValidationError = errors[0]!;
          for (let i = 0; i <= depth; i++) {
            expect(error).not.toHaveProperty("value");
            error = error.children![0]!;
          }
          expect(error).not.toHaveProperty("value");
          expect(error.children).toEqual([]);
          expect(JSON.stringify(errors)).not.toContain(item);
        },
        "ADR-009 omits value on all nodes by default",
      );

      it("should keep the value of an error without children when validationError.value is enabled", async () => {
        class LimitedOrder {
          @ArrayMinSize(2)
          @ValidateNested({ each: true })
          @Type(() => Item)
          items!: Item[];
        }
        target = nestCompatibleValidationPipe({
          exceptionFactory,
          validationError: { value: true },
        });

        const [error] = (await target
          .transform(
            { items: [{ name: "a" }] },
            { type: "body", metatype: LimitedOrder },
          )
          .catch((err) => err)) as ValidationError[];
        expect(error!.constraints).toHaveProperty("arrayMinSize");
        expect(error!.value).toEqual([{ name: "a" }]);
      });

      it("should expose the value of every error when asked to", async () => {
        target = nestCompatibleValidationPipe({
          exceptionFactory,
          validationError: { value: true },
        });

        const [error] = (await target
          .transform(orderOf(1), orderMetadata)
          .catch((err) => err)) as ValidationError[];
        expect(error!.value).toEqual(orderOf(1).items);
        expect(error!.children![0]!.value).toEqual(orderOf(1).items[0]);
        expect(error).not.toHaveProperty("target");
      });

      it("should expose the target when asked to", async () => {
        target = nestCompatibleValidationPipe({
          exceptionFactory,
          validationError: { target: true },
        });

        const [error] = (await target
          .transform(orderOf(1), orderMetadata)
          .catch((err) => err)) as ValidationError[];
        expect(error!.target).toEqual(orderOf(1));
        expect(error!.children![0]!.target).toEqual(orderOf(1).items);
      });

      it('should keep the other "validationError" options', async () => {
        target = nestCompatibleValidationPipe({
          exceptionFactory,
          validationError: { value: false },
        });

        const [error] = (await target
          .transform(orderOf(1), orderMetadata)
          .catch((err) => err)) as ValidationError[];
        expect(error).not.toHaveProperty("value");
        expect(error).not.toHaveProperty("target");
      });
    });

    describe('option: "expectedType"', () => {
      class TestModel2 {
        @IsString()
        public prop1!: string;

        @IsBoolean()
        public prop2!: boolean;

        @IsOptional()
        @IsString()
        public optionalProp!: string;
      }

      it("should validate against the expected type if presented", async () => {
        const m: ArgumentMetadata = {
          type: "body",
          metatype: TestModel2,
          data: "",
        };

        target = nestCompatibleValidationPipe({ expectedType: TestModel });
        const testObj = { prop1: "value1", prop2: "value2" };

        expect(await target.transform(testObj, m)).toEqual(testObj);
      });

      it("should validate against the expected type if presented and metatype is primitive type", async () => {
        const m: ArgumentMetadata = {
          type: "body",
          metatype: String,
          data: "",
        };

        target = nestCompatibleValidationPipe({ expectedType: TestModel });
        const testObj = { prop1: "value1", prop2: "value2" };

        expect(await target.transform(testObj, m)).toEqual(testObj);
      });
    });

    describe("Issue #17398: when only ValidationPipe-specific options are provided", () => {
      it("should return the original value when exceptionFactory is provided", async () => {
        target = nestCompatibleValidationPipe({
          exceptionFactory: () => new Error("custom"),
        });
        const testObj = { prop1: "value1", prop2: "value2" };
        const result = await target.transform(testObj, metadata);
        expect(result).toBe(testObj);
      });

      it("should return the original value when validatorPackage is provided", async () => {
        target = nestCompatibleValidationPipe({
          validatorPackage: classValidator,
        });
        const testObj = { prop1: "value1", prop2: "value2" };
        const result = await target.transform(testObj, metadata);
        expect(result).toBe(testObj);
      });

      it("should return the original value when transformerPackage is provided", async () => {
        target = nestCompatibleValidationPipe({
          transformerPackage:
            classTransformer as unknown as TransformerPackageLike,
        });
        const testObj = { prop1: "value1", prop2: "value2" };
        const result = await target.transform(testObj, metadata);
        expect(result).toBe(testObj);
      });

      it("should return the original value when maxErrorMessagesLength is provided", async () => {
        target = nestCompatibleValidationPipe({ maxErrorMessagesLength: 1000 });
        const testObj = { prop1: "value1", prop2: "value2" };
        const result = await target.transform(testObj, metadata);
        expect(result).toBe(testObj);
      });
    });

    describe("when another pipe is created during the validation", () => {
      it("should return the value", async () => {
        @ValidatorConstraint({ async: true })
        class CreatesPipe {
          async validate() {
            new ValidationPipe();
            return true;
          }
        }
        class TestDto {
          @IsString()
          @Validate(CreatesPipe)
          prop!: string;
        }
        target = nestCompatibleValidationPipe({ whitelist: true });

        const result = await target.transform(
          { prop: "value" },
          { type: "body", metatype: TestDto },
        );
        expect(result).toEqual({ prop: "value" });
      });
    });

    describe("subclass compatibility", () => {
      // BUNEST_BUG: bun:test expect(value).not.toHaveProperty("constructor") checks the prototype chain rather than own properties (unlike Chai's own.property) (packages/core/src/common/pipes/validation.pipe.ts)
      it.skip("should allow subclasses to call super.stripProtoKeys", () => {
        class CustomPipe extends ValidationPipe {
          public callSuperStripProtoKeys(value: unknown) {
            (
              ValidationPipe.prototype as unknown as {
                stripProtoKeys: (v: unknown) => void;
              }
            ).stripProtoKeys.call(this, value);
          }
        }
        const pipe = new CustomPipe();
        const value = { constructor: "malicious" };
        expect(() => pipe.callSuperStripProtoKeys(value)).not.toThrow();
        expect(value).not.toHaveProperty("constructor");
      });

      it("should invoke an overridden stripProtoKeys during transform", async () => {
        let called = false;
        class CustomPipe extends ValidationPipe {
          protected override stripProtoKeys(value: unknown) {
            called = true;
            super.stripProtoKeys(value);
          }
        }
        const pipe = new CustomPipe();
        const testObj = { prop1: "value1", prop2: "value2" };
        await pipe.transform(testObj, metadata);
        expect(called).toBe(true);
      });
    });

    describe("Bunest strict defaults (ADR-009)", () => {
      itAdapted(
        "ADR-009",
        "transforms to DTO instance, forbids non-whitelisted properties, and emits normalized error envelope by default",
        async () => {
          const strictPipe = bunestStrictValidationPipe();

          const ok = await strictPipe.transform(
            { prop1: "a", prop2: "b" },
            metadata,
          );
          expect(ok).toBeInstanceOf(TestModel);

          let caughtExtra: unknown;
          try {
            await strictPipe.transform(
              { prop1: "a", prop2: "b", extra: "forbidden" },
              metadata,
            );
          } catch (err) {
            caughtExtra = err;
          }
          expect(caughtExtra).toBeInstanceOf(BadRequestException);
          expectValidationErrorEnvelope(
            (caughtExtra as HttpException).getResponse(),
            { statusCode: 400, fields: ["extra"] },
          );

          // Prototype pollution is rejected with HTTP 400 forbiddenKey error
          const polluted = JSON.parse(
            '{"prop1":"a","prop2":"b","__proto__":{"isAdmin":true}}',
          );
          let caughtProto: unknown;
          try {
            await strictPipe.transform(polluted, metadata);
          } catch (err) {
            caughtProto = err;
          }
          expect(caughtProto).toBeInstanceOf(BadRequestException);
          expectValidationErrorEnvelope(
            (caughtProto as HttpException).getResponse(),
            { statusCode: 400, fields: ["__proto__"] },
          );
        },
        "strict ValidationPipe defaults",
      );
    });
  },
);
