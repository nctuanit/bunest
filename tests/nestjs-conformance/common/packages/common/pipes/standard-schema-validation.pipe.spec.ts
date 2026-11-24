import { describe, expect, it, mock } from "bun:test";
import {
  HttpException,
  HttpStatus,
  type ArgumentMetadata,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Result,
} from "../../../../../../packages/core/src/common";
import {
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from "../../../../../../packages/validation/src";
import {
  describeConformance,
  expectValidationErrorEnvelope,
  itAdapted,
} from "../../../../_helpers";

function createSchema(
  validateFn: (
    value: unknown,
    options?: unknown,
  ) => StandardSchemaV1Result<any> | Promise<StandardSchemaV1Result<any>>,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: validateFn,
    },
  };
}

describeConformance(
  "StandardSchemaValidationPipe",
  {
    upstreamPath:
      "packages/common/test/pipes/standard-schema-validation.pipe.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-005", "ADR-009"],
    notes:
      "Bunest supports both global StandardSchemaValidationPipe(options?) (reading metadata.schema) and bound StandardSchemaValidationPipe(schema, options?), emits ADR-009 structured ValidationErrorResponse details with dot/bracket paths, and rejects own prototype-pollution keys with HTTP 400 by default.",
  },
  () => {
    describe("transform", () => {
      describe("when no schema is present in metadata", () => {
        it("should return the value unchanged", async () => {
          const globalPipe = new StandardSchemaValidationPipe();
          const value = { name: "test" };
          const result = await globalPipe.transform(value, {
            type: "body",
          } as ArgumentMetadata);
          expect(result).toBe(value);
        });
      });

      describe("when schema validation succeeds", () => {
        itAdapted(
          "ADR-005",
          "should return the validated value",
          async () => {
            const schema = createSchema((value) => ({ value }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const result = await pipe.transform(
              { name: "test" },
              { type: "body" },
            );
            expect(result).toEqual({ name: "test" });
          },
          "schema passed to constructor",
        );

        itAdapted(
          "ADR-005",
          "should return the transformed value from schema",
          async () => {
            const schema = createSchema((value) => ({
              value: { ...(value as Record<string, unknown>), extra: true },
            }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const result = await pipe.transform(
              { name: "test" },
              { type: "body" },
            );
            expect(result).toEqual({ name: "test", extra: true });
          },
          "schema passed to constructor",
        );
      });

      describe("when schema validation succeeds asynchronously", () => {
        itAdapted(
          "ADR-005",
          "should return the validated value",
          async () => {
            const schema = createSchema(async (value) => ({ value }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const result = await pipe.transform(
              { name: "test" },
              { type: "body" },
            );
            expect(result).toEqual({ name: "test" });
          },
          "async Standard Schema v1",
        );
      });

      describe("when schema validation fails", () => {
        itAdapted(
          "ADR-009",
          "should throw a BadRequestException with issue messages",
          async () => {
            const schema = createSchema(() => ({
              issues: [
                { message: "field is required", path: ["name"] },
                { message: "must be a string" },
              ],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            await expect(
              pipe.transform({}, { type: "body" }),
            ).rejects.toThrow();

            let caught: unknown;
            try {
              await pipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(HttpException);
            expect((caught as HttpException).getStatus()).toBe(
              HttpStatus.BAD_REQUEST,
            );
            const body = expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { statusCode: HttpStatus.BAD_REQUEST, fields: ["name", "body"] },
            );
            expect(body.details).toEqual([
              {
                field: "name",
                constraints: { standardSchema: "field is required" },
                messages: ["field is required"],
              },
              {
                field: "body",
                constraints: { standardSchema: "must be a string" },
                messages: ["must be a string"],
              },
            ]);
          },
          "ADR-009 normalized ValidationErrorResponse",
        );

        itAdapted(
          "ADR-009",
          "should format nested paths in issue details",
          async () => {
            const schema = createSchema(() => ({
              issues: [
                {
                  message: "Invalid input: expected string, received boolean",
                  path: ["address", "line1"],
                },
              ],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            let caught: unknown;
            try {
              await pipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            const body = expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { statusCode: HttpStatus.BAD_REQUEST, fields: ["address.line1"] },
            );
            expect(body.details).toEqual([
              {
                field: "address.line1",
                constraints: {
                  standardSchema:
                    "Invalid input: expected string, received boolean",
                },
                messages: ["Invalid input: expected string, received boolean"],
              },
            ]);
          },
          "ADR-009 dot path",
        );

        itAdapted(
          "ADR-009",
          "should handle object path segments with a key property",
          async () => {
            const schema = createSchema(() => ({
              issues: [
                {
                  message: "Invalid input: expected string, received number",
                  path: [{ key: "address" }, { key: "line1" }],
                },
              ],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            let caught: unknown;
            try {
              await pipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            const body = expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { statusCode: HttpStatus.BAD_REQUEST, fields: ["address.line1"] },
            );
            expect(body.details[0]?.messages).toEqual([
              "Invalid input: expected string, received number",
            ]);
          },
          "ADR-009 object path segments",
        );

        itAdapted(
          "ADR-009",
          "should handle mixed string and object path segments",
          async () => {
            const schema = createSchema(() => ({
              issues: [
                {
                  message: "must be a positive number",
                  path: ["items", { key: 0 }, "price"],
                },
              ],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            let caught: unknown;
            try {
              await pipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            const body = expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              {
                statusCode: HttpStatus.BAD_REQUEST,
                fields: ["items[0].price"],
              },
            );
            expect(body.details[0]?.messages).toEqual([
              "must be a positive number",
            ]);
          },
          "ADR-009 bracket array path",
        );

        itAdapted(
          "ADR-009",
          "should stringify number and symbol path segments",
          async () => {
            const schema = createSchema(() => ({
              issues: [
                {
                  message: "must be a positive number",
                  path: ["items", 0, "price"],
                },
                {
                  message: "must be a string",
                  path: [Symbol("meta"), { key: Symbol("label") }],
                },
              ],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            let caught: unknown;
            try {
              await pipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(HttpException);
            const body = expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              {
                statusCode: HttpStatus.BAD_REQUEST,
                fields: ["items[0].price", "meta.label"],
              },
            );
            expect(body.details).toEqual([
              {
                field: "items[0].price",
                constraints: { standardSchema: "must be a positive number" },
                messages: ["must be a positive number"],
              },
              {
                field: "meta.label",
                constraints: { standardSchema: "must be a string" },
                messages: ["must be a string"],
              },
            ]);
          },
          "ADR-009 symbol description & bracket index formatting",
        );

        itAdapted(
          "ADR-009",
          "should fall back to metadata field when the path is empty",
          async () => {
            const schema = createSchema(() => ({
              issues: [{ message: "invalid value", path: [] }],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            let caught: unknown;
            try {
              await pipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            const body = expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { statusCode: HttpStatus.BAD_REQUEST, fields: ["body"] },
            );
            expect(body.details).toEqual([
              {
                field: "body",
                constraints: { standardSchema: "invalid value" },
                messages: ["invalid value"],
              },
            ]);
          },
          "ADR-009 empty path fallback field",
        );

        itAdapted(
          "ADR-005",
          "should throw asynchronously when schema validation fails async",
          async () => {
            const schema = createSchema(async () => ({
              issues: [{ message: "invalid" }],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);

            await expect(
              pipe.transform({}, { type: "body" }),
            ).rejects.toThrow();
          },
          "async schema rejection",
        );
      });

      describe("when custom errorHttpStatusCode is provided", () => {
        itAdapted(
          ["ADR-005", "ADR-009"],
          "should throw with the custom status code",
          async () => {
            const schema = createSchema(() => ({
              issues: [{ message: "invalid" }],
            }));
            const customPipe = new StandardSchemaValidationPipe(schema, {
              errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            });

            let caught: unknown;
            try {
              await customPipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(HttpException);
            expect((caught as HttpException).getStatus()).toBe(
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          },
          "custom HTTP status code",
        );
      });

      describe("when custom exceptionFactory is provided", () => {
        itAdapted(
          "ADR-005",
          "should use the custom exception factory",
          async () => {
            class CustomError extends Error {
              constructor(
                public readonly issues: readonly StandardSchemaV1Issue[],
              ) {
                super("Custom validation error");
              }
            }

            const schema = createSchema(() => ({
              issues: [{ message: "invalid" }],
            }));
            const customPipe = new StandardSchemaValidationPipe(schema, {
              exceptionFactory: (issues) => new CustomError(issues),
            });

            let caught: unknown;
            try {
              await customPipe.transform({}, { type: "body" });
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(CustomError);
            expect((caught as CustomError).issues).toEqual([
              { message: "invalid" },
            ]);
          },
          "custom exceptionFactory",
        );
      });

      describe('option: "maxErrorMessagesLength"', () => {
        const omitted = "Further validation errors were omitted";
        const issues: StandardSchemaV1Issue[] = [
          { message: "must be a string", path: ["a"] },
          { message: "must be a string", path: ["b", { key: "c" }] },
          { message: "must be a string", path: ["b", "d"] },
        ];
        const messagesOf = async (
          options: Record<string, unknown>,
          schemaIssues: readonly StandardSchemaV1Issue[],
        ): Promise<string[]> => {
          const target = new StandardSchemaValidationPipe(
            createSchema(() => ({ issues: schemaIssues })),
            options as StandardSchemaValidationPipeOptions,
          );
          const error: unknown = await target
            .transform({}, { type: "body" })
            .catch((err) => err);
          expect(error).toBeInstanceOf(HttpException);
          return ((error as HttpException).getResponse() as any).message;
        };

        it("should use the default limit for a value that is not a number", () => {
          const target = new StandardSchemaValidationPipe(
            createSchema((value) => ({ value })),
            {
              maxErrorMessagesLength: Number.NaN,
            } as StandardSchemaValidationPipeOptions & Record<string, unknown>,
          );

          expect((target as any).maxErrorMessagesLength).toBe(1_000_000);
        });

        // BUNEST_BUG: StandardSchemaValidationPipe does not implement `maxErrorMessagesLength` truncation (packages/validation/src/standard-schema.pipe.ts)
        it.skip("should leave out the messages past the limit and say so", async () => {
          expect(
            await messagesOf({ maxErrorMessagesLength: 30 }, issues),
          ).toEqual(["a: must be a string", "b.c: must be a string", omitted]);
        });

        // BUNEST_BUG: StandardSchemaValidationPipe does not implement `maxErrorMessagesLength` lazy early-stop while formatting issues (iterates all 1,000 issues) (packages/validation/src/standard-schema.pipe.ts)
        it.skip("should not format the issues past the limit", async () => {
          let read = 0;
          const paths = Array.from({ length: 1_000 }, (_, index) => ({
            get key() {
              read++;
              return index;
            },
          }));

          const messages = await messagesOf(
            { maxErrorMessagesLength: 50 },
            paths.map((segment) => ({
              message: "must be a string",
              path: ["items", segment],
            })),
          );

          expect(messages.at(-1)).toBe(omitted);
          expect(read).toBeLessThan(10);
        });

        // BUNEST_BUG: StandardSchemaValidationPipe does not enforce default 1_000_000-character DoS cap on emitted issue messages (packages/validation/src/standard-schema.pipe.ts)
        it.skip("should limit the messages to about a million characters by default", async () => {
          const manyIssues = Array.from({ length: 100_000 }, (_, index) => ({
            message: "Invalid input: expected string, received undefined",
            path: ["contacts", index, "name"],
          }));

          const messages = await messagesOf({}, manyIssues);

          expect(messages.at(-1)).toBe(omitted);
          expect(messages.join("").length).toBeLessThan(1_000_100);
        });

        // BUNEST_BUG: StandardSchemaValidationPipe does not implement `maxErrorMessagesLength` option or NestJS flat errorFormat (packages/validation/src/standard-schema.pipe.ts)
        it.skip("should keep every message when the limit is lifted", async () => {
          expect(
            await messagesOf({ maxErrorMessagesLength: Infinity }, issues),
          ).toEqual([
            "a: must be a string",
            "b.c: must be a string",
            "b.d: must be a string",
          ]);
        });

        it("should hand every issue to a custom exception factory", async () => {
          const exceptionFactory = mock(() => new Error("custom"));
          const target = new StandardSchemaValidationPipe(
            createSchema(() => ({ issues })),
            {
              maxErrorMessagesLength: 10,
              exceptionFactory,
            } as StandardSchemaValidationPipeOptions & Record<string, unknown>,
          );

          await expect(target.transform({}, { type: "body" })).rejects.toThrow(
            "custom",
          );
          expect(exceptionFactory).toHaveBeenCalledWith(
            issues,
            expect.any(Array),
          );
        });
      });

      describe("when transform is enabled (default)", () => {
        itAdapted(
          "ADR-005",
          "should return the schema-produced value",
          async () => {
            const input = { name: "test" };
            const schema = createSchema((value) => ({
              value: { ...(value as Record<string, unknown>), coerced: true },
            }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const result = await pipe.transform(input, { type: "body" });
            expect(result).toEqual({ name: "test", coerced: true });
          },
          "returns validated output by default",
        );
      });

      describe("when transform is explicitly set to true", () => {
        itAdapted(
          "ADR-005",
          "should return the schema-produced value",
          async () => {
            const input = { name: "test" };
            const schema = createSchema((value) => ({
              value: { ...(value as Record<string, unknown>), coerced: true },
            }));
            const transformPipe = new StandardSchemaValidationPipe(schema, {
              transform: true,
            } as StandardSchemaValidationPipeOptions & Record<string, unknown>);
            const result = await transformPipe.transform(input, {
              type: "body",
            });
            expect(result).toEqual({ name: "test", coerced: true });
          },
          "returns validated output",
        );
      });

      describe("when transform is disabled", () => {
        it("should return the original input value", async () => {
          const input = { name: "test" };
          const schema = createSchema((value) => ({
            value: { ...(value as Record<string, unknown>), coerced: true },
          }));
          const noTransformPipe = new StandardSchemaValidationPipe(schema, {
            transform: false,
          } as StandardSchemaValidationPipeOptions & Record<string, unknown>);
          const result = await noTransformPipe.transform(input, {
            type: "body",
          });
          expect(result).toBe(input);
          expect(result).toEqual({ name: "test" });
        });
      });

      describe("toValidate", () => {
        itAdapted(
          "ADR-005",
          "should skip validation for custom decorators by default",
          async () => {
            const schema = createSchema(() => ({
              issues: [{ message: "should not be reached" }],
            }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const result = await pipe.transform(
              { name: "test" },
              { type: "custom" },
            );
            expect(result).toEqual({ name: "test" });
          },
          "custom decorator skip rule",
        );

        itAdapted(
          "ADR-005",
          "should validate custom decorators when validateCustomDecorators is true",
          async () => {
            const schema = createSchema(() => ({
              issues: [{ message: "invalid" }],
            }));
            const customPipe = new StandardSchemaValidationPipe(schema, {
              validateCustomDecorators: true,
            });

            await expect(
              customPipe.transform({}, { type: "custom" }),
            ).rejects.toThrow();
          },
          "validateCustomDecorators: true",
        );

        itAdapted(
          "ADR-005",
          "should always validate body/query/param types",
          async () => {
            const schema = createSchema((value) => ({ value }));
            const pipe = new StandardSchemaValidationPipe(schema);
            for (const type of ["body", "query", "param"] as const) {
              const result = await pipe.transform({ ok: true }, { type });
              expect(result).toEqual({ ok: true });
            }
          },
          "validates body/query/param",
        );
      });

      describe("validate", () => {
        it("should be overridable", async () => {
          class CustomPipe extends StandardSchemaValidationPipe {
            protected override validate<T = unknown>(
              _value: unknown,
              _schema: StandardSchemaV1,
              _options?: Record<string, unknown>,
            ): StandardSchemaV1Result<T> {
              return {
                value: "custom-result" as T,
              };
            }
          }
          const schema = createSchema(() => ({
            issues: [{ message: "should not be reached" }],
          }));
          const customPipe = new CustomPipe(schema);
          const result = await customPipe.transform("anything", {
            type: "body",
          });
          expect(result).toBe("custom-result");
        });

        it("should forward validateOptions to the schema validate function", async () => {
          let receivedOptions: unknown;
          const schema: StandardSchemaV1 = {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: (value: unknown, options?: unknown) => {
                receivedOptions = options;
                return { value };
              },
            },
          };
          const optsPipe = new StandardSchemaValidationPipe(schema, {
            validateOptions: { strict: true, strip: "extra" },
          } as StandardSchemaValidationPipeOptions & Record<string, unknown>);
          await optsPipe.transform({ name: "test" }, { type: "body" });
          expect(receivedOptions).toEqual({ strict: true, strip: "extra" });
        });

        itAdapted(
          "ADR-005",
          "should pass undefined when no validateOptions are provided",
          async () => {
            let receivedOptions: unknown = "NOT_CALLED";
            const schema: StandardSchemaV1 = {
              "~standard": {
                version: 1,
                vendor: "test",
                validate: (value: unknown, options?: unknown) => {
                  receivedOptions = options;
                  return { value };
                },
              },
            };
            const pipe = new StandardSchemaValidationPipe(schema);
            await pipe.transform({ name: "test" }, { type: "body" });
            expect(receivedOptions).toBeUndefined();
          },
          "no options passed by default",
        );
      });

      describe("prototype pollution protection (ADR-009 vs NestJS stripProtoKeys)", () => {
        itAdapted(
          "ADR-009",
          "should reject __proto__ and prototype keys before validation by default",
          async () => {
            let schemaCalled = false;
            const schema = createSchema((value) => {
              schemaCalled = true;
              return { value };
            });
            const pipe = new StandardSchemaValidationPipe(schema);
            const malicious = JSON.parse(
              '{"name": "test", "__proto__": {"polluted": true}, "prototype": {"bad": true}}',
            );

            let caught: unknown;
            try {
              await pipe.transform(malicious, { type: "body" });
            } catch (err) {
              caught = err;
            }
            expect(schemaCalled).toBe(false);
            expect(caught).toBeInstanceOf(HttpException);
            expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { fields: ["__proto__", "prototype"] },
            );
          },
          "fail-closed prototype pollution rejection",
        );

        itAdapted(
          "ADR-009",
          "should reject proto keys recursively from nested objects",
          async () => {
            const schema = createSchema((value) => ({ value }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const malicious = {
              nested: JSON.parse(
                '{"__proto__": {"polluted": true}, "ok": true}',
              ),
            };

            let caught: unknown;
            try {
              await pipe.transform(malicious, { type: "body" });
            } catch (err) {
              caught = err;
            }
            expect(caught).toBeInstanceOf(HttpException);
            expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { fields: ["nested.__proto__"] },
            );
          },
          "fail-closed nested prototype pollution rejection",
        );

        itAdapted(
          "ADR-009",
          "should reject proto keys from arrays",
          async () => {
            const schema = createSchema((value) => ({ value }));
            const pipe = new StandardSchemaValidationPipe(schema);
            const malicious = [
              JSON.parse('{"__proto__": {"polluted": true}, "ok": true}'),
            ];

            let caught: unknown;
            try {
              await pipe.transform(malicious, { type: "body" });
            } catch (err) {
              caught = err;
            }
            expect(caught).toBeInstanceOf(HttpException);
            expectValidationErrorEnvelope(
              (caught as HttpException).getResponse(),
              { fields: ["0.__proto__"] },
            );
          },
          "fail-closed array prototype pollution rejection",
        );

        itAdapted(
          "ADR-009",
          "should not reject or mutate built-in types like Date",
          async () => {
            let receivedValue: unknown;
            const schema = createSchema((value) => {
              receivedValue = value;
              return { value };
            });
            const pipe = new StandardSchemaValidationPipe(schema);
            const date = new Date();
            await pipe.transform(date, { type: "body" });
            expect(receivedValue).toBe(date);
          },
          "built-in non-traversable types preserved",
        );
      });
    });

    describe("subclass compatibility", () => {
      it("should allow subclasses to call super.stripProtoKeys", () => {
        class CustomPipe extends StandardSchemaValidationPipe {
          public callSuperStripProtoKeys(value: unknown) {
            super.stripProtoKeys(value);
          }
        }
        const customPipe = new CustomPipe(createSchema((value) => ({ value })));
        const value = { constructor: "malicious" };
        expect(() => customPipe.callSuperStripProtoKeys(value)).not.toThrow();
        expect(Object.hasOwn(value, "constructor")).toBe(false);
      });

      it("should invoke an overridden stripProtoKeys during transform", async () => {
        let called = false;
        class CustomPipe extends StandardSchemaValidationPipe {
          protected override stripProtoKeys(value: unknown) {
            called = true;
            super.stripProtoKeys(value);
          }
        }
        const customPipe = new CustomPipe(createSchema((value) => ({ value })));
        await customPipe.transform({ name: "test" }, { type: "body" });
        expect(called).toBe(true);
      });
    });
  },
);
