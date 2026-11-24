import { describe, expect, it } from "bun:test";
import {
  Body,
  MetadataRegistry,
  ParseIntPipe,
  createParamDecorator,
  type StandardSchemaV1,
} from "../../../../../../packages/core/src/common";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "createParamDecorator",
  {
    upstreamPath:
      "packages/common/test/decorators/create-param-decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-004"],
    notes:
      "Bunest stores custom param metadata as ParameterMetadata[] via MetadataRegistry.getRouteParameters() with pipes: undefined when 0 pipes are passed. Missing options-object ({ schema, pipes }) parsing and 2nd enhancers parameter in createParamDecorator are faithfully skipped with BUNEST_BUG.",
  },
  () => {
    let result: ReturnType<typeof createParamDecorator>;

    const baseFn = (_data: unknown, _req: unknown) => true;
    result = createParamDecorator(baseFn);

    it("should return a function as a first element", () => {
      expect(typeof result).toBe("function");
    });

    describe("returned decorator", () => {
      const factoryFn = (_data: unknown, _ctx: unknown) => true;
      const Decorator = createParamDecorator(factoryFn);

      describe("when 0 pipes have been passed", () => {
        const data = { data: "test" };
        class Test {
          public test(@Decorator(data) _param: unknown) {}
        }

        itAdapted(
          ["ADR-002", "ADR-004"],
          'should enhance param with "data"',
          () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params).toHaveLength(1);
            expect(params[0]).toMatchObject({
              data,
              factory: factoryFn,
              index: 0,
              source: "custom",
            });
            expect(params[0]?.pipes).toBeUndefined();
          },
          "ParameterMetadata[] with pipes: undefined when empty",
        );
      });

      describe("when custom data contains schema or pipes properties", () => {
        const schema: StandardSchemaV1 = {
          "~standard": {
            version: 1 as const,
            vendor: "test",
            validate: (value: unknown) => ({ value }),
          },
        };

        it.each([
          [
            "a schema string and another key",
            { schema: "public", region: "eu" },
          ],
          ["a pipes string and another key", { pipes: "water", region: "eu" }],
          [
            "an array of non-pipes and another key",
            { pipes: ["stage1", "stage2"], region: "eu" },
          ],
          [
            "an array of real pipes and another key",
            { pipes: [new ParseIntPipe()], region: "eu" },
          ],
          ["an empty pipes array and another key", { pipes: [], region: "eu" }],
          [
            "an undefined schema and another key",
            { schema: undefined, region: "eu" },
          ],
          ["a valid schema and another key", { schema, region: "eu" }],
          ["only a schema string", { schema: "public" }],
          ["only a schema object", { schema: { name: "public" } }],
          ["only a null schema", { schema: null }],
          [
            "only a schema with a non-callable validator",
            { schema: { "~standard": { validate: true } } },
          ],
          ["only a pipes string", { pipes: "water" }],
          ["only a pipes number", { pipes: 42 }],
          ["only an array of non-pipes", { pipes: ["stage1", "stage2"] }],
          [
            "only an array mixing pipes and non-pipes",
            { pipes: [new ParseIntPipe(), "stage2"] },
          ],
          [
            "only a schema string and a pipes array",
            { schema: "public", pipes: [] },
          ],
          [
            "only a valid schema and a pipes string",
            { schema, pipes: "water" },
          ],
        ])("should preserve data containing %s", (_, data) => {
          class Test {
            public test(@Decorator(data) _param: unknown) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]?.data).toBe(data);
          expect(params[0]?.pipes).toBeUndefined();
          expect(params[0]?.schema).toBeUndefined();
        });

        it.each([
          ["instance", new ParseIntPipe()],
          ["class", ParseIntPipe],
        ])(
          "should preserve custom data with a positional pipe %s",
          (_, pipe) => {
            const data = { schema: "public", region: "eu" };
            class Test {
              public test(@Decorator(data, pipe) _param: unknown) {}
            }

            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]?.data).toBe(data);
            expect(params[0]?.pipes).toEqual([pipe]);
            expect(params[0]?.schema).toBeUndefined();
          },
        );

        // BUNEST_BUG: createParamDecorator() in packages/core/src/common/decorators/params.decorators.ts:260-295 does not parse trailing `{ schema, pipes }` options objects (treats options object as a pipe entry in `restPipes`).
        it.skip("should preserve custom data with trailing schema and pipe options", () => {
          const data = { schema: "public", region: "eu" };
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator(data, { schema, pipes: [pipe] } as any)
              _param: unknown,
            ) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]?.data).toBe(data);
          expect(params[0]?.schema).toBe(schema);
          expect(params[0]?.pipes).toEqual([pipe]);
        });
      });

      describe("when > 0 pipes have been passed", () => {
        const data = "test";
        const pipe = new ParseIntPipe();
        class Test {
          public test(@Decorator(data, pipe) _param: unknown) {}

          public testNoData(@Decorator(pipe) _param: unknown) {}

          public testNoDataClass(@Decorator(ParseIntPipe) _param: unknown) {}
        }

        it('should enhance param with "data" and ParseIntPipe', () => {
          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]).toMatchObject({
            data: "test",
            factory: factoryFn,
            index: 0,
            pipes: [pipe],
            source: "custom",
          });
        });

        it("should enhance param with ParseIntPipe", () => {
          const params = MetadataRegistry.getRouteParameters(
            Test,
            "testNoData",
          );
          expect(params[0]).toMatchObject({
            data: undefined,
            factory: factoryFn,
            index: 0,
            pipes: [pipe],
            source: "custom",
          });
        });

        it("should enhance param with ParseIntPipe metatype", () => {
          const params = MetadataRegistry.getRouteParameters(
            Test,
            "testNoDataClass",
          );
          expect(params[0]).toMatchObject({
            data: undefined,
            factory: factoryFn,
            index: 0,
            pipes: [ParseIntPipe],
            source: "custom",
          });
        });
      });

      describe("when class type passed as data", () => {
        class Data {}
        class Test {
          public test(@Decorator(Data) _prop: unknown) {}
        }

        it("should return class type as data parameter", () => {
          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]?.data).toBe(Data);
        });
      });

      describe("when an overriding method uses it in place of an inherited decorator", () => {
        class Parent {
          public test(@Body() _body: unknown) {}
        }
        class Test extends Parent {
          public override test(
            @Decorator() _param: unknown,
            @Body() _body?: unknown,
          ) {}
        }

        it("should replace the inherited route param of that argument", () => {
          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params).toHaveLength(2);
          expect(params.find((arg) => arg.index === 0)?.factory).toBe(
            factoryFn,
          );
        });
      });

      describe("when options object with schema is passed", () => {
        const mockSchema: StandardSchemaV1 = {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (v: unknown) => ({ value: v }),
          },
        };

        // BUNEST_BUG: createParamDecorator() in packages/core/src/common/decorators/params.decorators.ts:260-295 does not parse NestJS v12 `{ schema, pipes }` options objects (treats them as `data`).
        it.skip("should accept options with a schema and pipe classes and instances", () => {
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator({
                schema: mockSchema,
                pipes: [ParseIntPipe, pipe],
              } as any)
              _param: unknown,
            ) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]).toMatchObject({
            data: undefined,
            factory: factoryFn,
            index: 0,
            pipes: [ParseIntPipe, pipe],
            schema: mockSchema,
          });
        });

        // BUNEST_BUG: createParamDecorator() in packages/core/src/common/decorators/params.decorators.ts:260-295 does not parse `{ pipes }` options objects.
        it.skip("should accept pipes-only options before positional pipes", () => {
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator({ pipes: [pipe] } as any, ParseIntPipe)
              _param: unknown,
            ) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]).toMatchObject({
            data: undefined,
            factory: factoryFn,
            index: 0,
            pipes: [pipe, ParseIntPipe],
          });
        });

        // BUNEST_BUG: createParamDecorator() in packages/core/src/common/decorators/params.decorators.ts:260-295 does not parse `{ pipes: [] }` options objects.
        it.skip("should accept an empty pipes array as options", () => {
          class Test {
            public test(@Decorator({ pipes: [] } as any) _param: unknown) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]?.data).toBeUndefined();
          expect(params[0]?.pipes ?? []).toEqual([]);
        });

        // BUNEST_BUG: createParamDecorator() in packages/core/src/common/decorators/params.decorators.ts:260-295 does not parse `{ schema }` options objects with callable Standard Schema.
        it.skip("should accept a callable Standard Schema in options", () => {
          const schema = Object.assign((value: unknown) => value, {
            "~standard": mockSchema["~standard"],
          });
          class Test {
            public test(@Decorator({ schema } as any) _param: unknown) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]?.data).toBeUndefined();
          expect(params[0]?.schema).toBe(schema);
        });

        // BUNEST_BUG: createParamDecorator() in packages/core/src/common/decorators/params.decorators.ts:260-295 does not recognize options objects with undefined schema/pipes fields.
        it.skip.each([
          ["schema", { schema: undefined }],
          ["pipes", { pipes: undefined }],
          ["both", { schema: undefined, pipes: undefined }],
        ])("should retain options with undefined %s fields", (_, options) => {
          class Test {
            public test(@Decorator(options as any) _param: unknown) {}
          }

          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]?.data).toBeUndefined();
        });

        describe("with data and schema option", () => {
          const data = "testData";
          class Test {
            public test(
              @Decorator(data, { schema: mockSchema } as any) _param: unknown,
            ) {}
          }

          // BUNEST_BUG: createParamDecorator() does not parse trailing `{ schema }` options.
          it.skip('should enhance param with "data" and "schema"', () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: "testData",
              factory: factoryFn,
              index: 0,
              schema: mockSchema,
            });
          });
        });

        describe("with schema option only (no data)", () => {
          class Test {
            public test(
              @Decorator({ schema: mockSchema } as any) _param: unknown,
            ) {}
          }

          // BUNEST_BUG: createParamDecorator() does not parse `{ schema }` options.
          it.skip("should enhance param with schema and no data", () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: undefined,
              factory: factoryFn,
              index: 0,
              schema: mockSchema,
            });
          });
        });

        describe("with options whose pipes contain an undefined entry (no data)", () => {
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator({
                schema: mockSchema,
                pipes: [pipe, undefined],
              } as any)
              _param: unknown,
            ) {}
          }

          // BUNEST_BUG: createParamDecorator() does not parse `{ schema, pipes }` options.
          it.skip("should still treat the object as options", () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]?.data).toBeUndefined();
            expect(params[0]?.schema).toBe(mockSchema);
            expect(params[0]?.pipes).toContain(pipe);
          });
        });

        describe("with data, pipes, and schema option", () => {
          const data = "testData";
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator(data, pipe, { schema: mockSchema } as any)
              _param: unknown,
            ) {}
          }

          // BUNEST_BUG: createParamDecorator() does not parse trailing `{ schema }` after positional pipes.
          it.skip('should enhance param with "data", pipes, and schema', () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: "testData",
              factory: factoryFn,
              index: 0,
              pipes: [pipe],
              schema: mockSchema,
            });
          });
        });

        describe("with pipes in options object", () => {
          const data = "testData";
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator(data, { schema: mockSchema, pipes: [pipe] } as any)
              _param: unknown,
            ) {}
          }

          // BUNEST_BUG: createParamDecorator() does not extract pipes/schema from options object.
          it.skip('should enhance param with "data", pipes from options, and schema', () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: "testData",
              factory: factoryFn,
              index: 0,
              pipes: [pipe],
              schema: mockSchema,
            });
          });
        });

        describe("with options containing only pipes (no schema)", () => {
          const data = "testData";
          const pipe = new ParseIntPipe();
          class Test {
            public test(
              @Decorator(data, { pipes: [pipe] } as any) _param: unknown,
            ) {}
          }

          // BUNEST_BUG: createParamDecorator() does not extract `{ pipes }` options object.
          it.skip('should enhance param with "data" and pipes from options', () => {
            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: "testData",
              factory: factoryFn,
              index: 0,
              pipes: [pipe],
            });
          });
        });

        describe("with options followed by a positional pipe", () => {
          const pipe = new ParseIntPipe();

          // BUNEST_BUG: createParamDecorator() does not merge options placed between data and positional pipes.
          it.skip("should merge options placed between data and the pipe", () => {
            class Test {
              public test(
                @Decorator(
                  "x",
                  { schema: mockSchema, pipes: [ParseIntPipe] } as any,
                  pipe,
                )
                _param: unknown,
              ) {}
            }

            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: "x",
              factory: factoryFn,
              index: 0,
              pipes: [ParseIntPipe, pipe],
              schema: mockSchema,
            });
          });

          // BUNEST_BUG: createParamDecorator() does not merge options placed after undefined data.
          it.skip("should merge options placed after undefined data", () => {
            class Test {
              public test(
                @Decorator(undefined, { schema: mockSchema } as any, pipe)
                _param: unknown,
              ) {}
            }

            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: undefined,
              factory: factoryFn,
              index: 0,
              pipes: [pipe],
              schema: mockSchema,
            });
          });

          // BUNEST_BUG: createParamDecorator() does not merge options placed between two pipes.
          it.skip("should merge options placed between two pipes", () => {
            class Test {
              public test(
                @Decorator(ParseIntPipe, { schema: mockSchema } as any, pipe)
                _param: unknown,
              ) {}
            }

            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: undefined,
              factory: factoryFn,
              index: 0,
              pipes: [ParseIntPipe, pipe],
              schema: mockSchema,
            });
          });

          // BUNEST_BUG: createParamDecorator() does not merge consecutive options objects.
          it.skip("should merge consecutive options objects", () => {
            class Test {
              public test(
                @Decorator(
                  "x",
                  { schema: mockSchema } as any,
                  { pipes: [ParseIntPipe] } as any,
                )
                _param: unknown,
              ) {}
            }

            const params = MetadataRegistry.getRouteParameters(Test, "test");
            expect(params[0]).toMatchObject({
              data: "x",
              factory: factoryFn,
              index: 0,
              pipes: [ParseIntPipe],
              schema: mockSchema,
            });
          });
        });
      });
    });

    describe("returned generic typed decorator", () => {
      const factoryFn = (_data: unknown, _req: unknown) => true;
      interface User {
        name: string;
      }

      const stringOnlyDecorator = createParamDecorator<string>(factoryFn);
      const stringOrNumberDecorator = createParamDecorator<string | number>(
        factoryFn,
      );
      const customTypeDecorator = createParamDecorator<User>(factoryFn);

      describe("when string is passed to stringOnlyDecorator", () => {
        const data = "test";
        class Test {
          public test(@stringOnlyDecorator(data) _param: unknown) {}
        }
        it('should enhance param with "data" as string', () => {
          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]).toMatchObject({
            data: "test",
            factory: factoryFn,
            index: 0,
            source: "custom",
          });
        });
      });

      describe("when number is passed to stringOrNumberDecorator", () => {
        const data = 10;
        class Test {
          public test(@stringOrNumberDecorator(data) _param: unknown) {}
        }
        it('should enhance param with "data" as number', () => {
          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]).toMatchObject({
            data: 10,
            factory: factoryFn,
            index: 0,
            source: "custom",
          });
        });
      });

      describe("when a custom Type is passed to customTypeDecorator", () => {
        const data = { name: "john" };
        class Test {
          public test(@customTypeDecorator(data) _param: unknown) {}
        }
        it('should enhance param with "data" as custom Type', () => {
          const params = MetadataRegistry.getRouteParameters(Test, "test");
          expect(params[0]).toMatchObject({
            data: { name: "john" },
            factory: factoryFn,
            index: 0,
            source: "custom",
          });
        });
      });
    });

    describe("when enhancers are passed", () => {
      // BUNEST_BUG: createParamDecorator(factory, enhancers?) in packages/core/src/common/decorators/params.decorators.ts:260 does not accept or invoke the 2nd `enhancers?: ParamDecoratorEnhancer[]` parameter.
      it.skip("should apply each enhancer to the decorated parameter", () => {
        const factoryFn = (_data: unknown, _req: unknown) => true;
        const enhancer = createSpy();
        const anotherEnhancer = createSpy();
        const Decorator = (createParamDecorator as any)(factoryFn, [
          enhancer,
          anotherEnhancer,
        ]);

        class Test {
          public test(@Decorator() _param: unknown) {}
        }

        expect(enhancer.calledOnceWithExactly(Test.prototype, "test", 0)).toBe(
          true,
        );
        expect(
          anotherEnhancer.calledOnceWithExactly(Test.prototype, "test", 0),
        ).toBe(true);
      });
    });
  },
);
