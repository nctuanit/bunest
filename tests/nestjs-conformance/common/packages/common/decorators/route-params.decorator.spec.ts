import { describe, expect, it } from "bun:test";
import {
  All,
  Body,
  Cookies,
  Copy,
  Delete,
  Get,
  HostParam,
  Lock,
  METADATA_KEYS,
  MetadataRegistry,
  Mkcol,
  Move,
  Param,
  ParseFilePipe,
  ParseIntPipe,
  Patch,
  Post,
  Propfind,
  Proppatch,
  Put,
  Query,
  QueryMethod,
  RawBody,
  Req,
  RequestMethod,
  Res,
  Search,
  SignedCookies,
  Unlock,
  UploadedFile,
  UploadedFiles,
  assignMetadata,
  type ParameterMetadata,
  type StandardSchemaV1,
} from "../../../../../../packages/core/src/common";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "Route & Parameter Decorators",
  {
    upstreamPath:
      "packages/common/test/decorators/route-params.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-004", "ADR-006", "ADR-010"],
    notes:
      "Uses METADATA_KEYS symbols & MetadataRegistry per ADR-002/004/006. Per ADR-004 §3, duplicate param decorators on the same index fail fast. Genuine gaps (`[]` default path, `{ schema, pipes }` in keyed/RawBody options, assignMetadata default empty pipes) marked it with BUNEST_BUG.",
  },
  () => {
    const requestPath = "test";
    const requestPathUsingArray = ["foo", "bar"];

    const methodDecoratorCases = [
      ["@Get", Get, RequestMethod.GET],
      ["@Post", Post, RequestMethod.POST],
      ["@Delete", Delete, RequestMethod.DELETE],
      ["@All", All, RequestMethod.ALL],
      ["@Put", Put, RequestMethod.PUT],
      ["@Patch", Patch, RequestMethod.PATCH],
      ["@Search", Search, RequestMethod.SEARCH],
      ["@QueryMethod", QueryMethod, RequestMethod.QUERY],
      ["@PropFind", Propfind, RequestMethod.PROPFIND],
      ["@PropPatch", Proppatch, RequestMethod.PROPPATCH],
      ["@MkCol", Mkcol, RequestMethod.MKCOL],
      ["@Copy", Copy, RequestMethod.COPY],
      ["@Move", Move, RequestMethod.MOVE],
      ["@Lock", Lock, RequestMethod.LOCK],
      ["@Unlock", Unlock, RequestMethod.UNLOCK],
    ] as const;

    for (const [label, DecoratorFn, expectedMethod] of methodDecoratorCases) {
      describe(label, () => {
        it("should enhance class with expected request metadata", () => {
          class Test {
            @DecoratorFn(requestPath)
            public static test(@Param("id", ParseIntPipe) _params: unknown) {}

            @DecoratorFn(requestPathUsingArray)
            public static testUsingArray(@Param("id") _params: unknown) {}
          }

          const path = MetadataRegistry.get(
            METADATA_KEYS.ROUTE_PATH,
            Test.test,
          );
          const args = MetadataRegistry.get<ParameterMetadata[]>(
            METADATA_KEYS.ROUTE_PARAMS,
            Test,
            "test",
          );
          const method = MetadataRegistry.get(
            METADATA_KEYS.ROUTE_METHOD,
            Test.test,
          );
          const pathUsingArray = MetadataRegistry.get(
            METADATA_KEYS.ROUTE_PATH,
            Test.testUsingArray,
          );
          const methodUsingArray = MetadataRegistry.get(
            METADATA_KEYS.ROUTE_METHOD,
            Test.testUsingArray,
          );

          expect(path).toEqual(requestPath);
          expect(args?.[0]).toMatchObject({
            index: 0,
            source: "param",
            data: "id",
            pipes: [ParseIntPipe],
          });
          expect(method).toEqual(expectedMethod);
          expect(pathUsingArray).toEqual(requestPathUsingArray);
          expect(methodUsingArray).toEqual(expectedMethod);
        });

        itAdapted(
          "ADR-006",
          'should default path to "" when called with no arguments',
          () => {
            class Test {
              @DecoratorFn()
              public static test(
                @Query() _query: unknown,
                @Param() _params: unknown,
                @HostParam() _hostParams: unknown,
              ) {}
            }

            const path = MetadataRegistry.get(
              METADATA_KEYS.ROUTE_PATH,
              Test.test,
            );
            expect(path).toEqual("");
          },
          'ADR-006 §2 defaults method decorator path to "" (normalized to "/" by scanner)',
        );

        // BUNEST_BUG: Conflicts with itAdapted on line 125 (ADR-006 defaults @Get() to "" whereas upstream defaults to "/"); @Get([]) already normalizes to "/".
        it.skip('should set path on "/" by default for empty array []', () => {
          class Test {
            @DecoratorFn()
            public static test() {}

            @DecoratorFn([])
            public static testUsingArray() {}
          }

          const path = MetadataRegistry.get(
            METADATA_KEYS.ROUTE_PATH,
            Test.test,
          );
          const pathUsingArray = MetadataRegistry.get(
            METADATA_KEYS.ROUTE_PATH,
            Test.testUsingArray,
          );

          expect(path).toEqual("/");
          expect(pathUsingArray).toEqual("/");
        });
      });
    }

    describe("Inheritance", () => {
      it("should enhance subclass with expected request metadata", () => {
        class Parent {
          @Get(requestPath)
          public static test() {}

          @Get(requestPathUsingArray)
          public static testUsingArray() {}
        }

        class Test extends Parent {}

        const path = MetadataRegistry.get(METADATA_KEYS.ROUTE_PATH, Test.test);
        const method = MetadataRegistry.get(
          METADATA_KEYS.ROUTE_METHOD,
          Test.test,
        );
        const pathUsingArray = MetadataRegistry.get(
          METADATA_KEYS.ROUTE_PATH,
          Test.testUsingArray,
        );
        const methodUsingArray = MetadataRegistry.get(
          METADATA_KEYS.ROUTE_METHOD,
          Test.testUsingArray,
        );

        expect(path).toEqual(requestPath);
        expect(method).toEqual(RequestMethod.GET);
        expect(pathUsingArray).toEqual(requestPathUsingArray);
        expect(methodUsingArray).toEqual(RequestMethod.GET);
      });

      describe("when a subclass overrides a method with its own param decorators", () => {
        it("should keep one route param per argument", () => {
          class Parent {
            public create(@Body() _dto: unknown) {}
          }
          class Test extends Parent {
            public override create(
              @Req() _req: unknown,
              @Body() _dto?: unknown,
            ) {}
          }

          const childParams = MetadataRegistry.getRouteParameters(
            Test,
            "create",
          );
          expect(childParams.map((p) => `${p.source}:${p.index}`)).toEqual([
            "request:0",
            "body:1",
          ]);
          const parentParams = MetadataRegistry.getRouteParameters(
            Parent,
            "create",
          );
          expect(parentParams.map((p) => `${p.source}:${p.index}`)).toEqual([
            "body:0",
          ]);
        });

        itAdapted(
          "ADR-004",
          "should fail fast when multiple conflicting param decorators are placed on one argument",
          () => {
            expect(() => {
              class Parent {
                public create(@Body() _dto: unknown) {}
              }
              class Test extends Parent {
                public override create(@Req() @Body() _dto: unknown) {}
              }
              return Test;
            }).toThrow(/Duplicate parameter decorator/);
          },
          "ADR-004 §3 forbids conflicting param decorators at same index",
        );

        itAdapted(
          "ADR-002",
          "should isolate overridden method parameters on subclass without leaking parent params",
          () => {
            class Parent {
              public update(@Param("id") _id: unknown, @Body() _dto: unknown) {}
            }
            class Test extends Parent {
              public override update(
                @Query("id") _id: unknown,
                _dto: unknown,
              ) {}
            }

            // Bunest MetadataRegistry.getRouteParameters reads own metadata from
            // the defining prototype so overridden methods never leak parent param metadata.
            const childParams = MetadataRegistry.getRouteParameters(
              Test,
              "update",
            );
            expect(childParams.map((p) => `${p.source}:${p.index}`)).toEqual([
              "query:0",
            ]);
            const parentParams = MetadataRegistry.getRouteParameters(
              Parent,
              "update",
            );
            expect(parentParams.map((p) => `${p.source}:${p.index}`)).toEqual([
              "param:0",
              "body:1",
            ]);
          },
          "own-prototype isolation in MetadataRegistry.getRouteParameters()",
        );
      });
    });

    const mockSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (v: unknown) => ({ value: v }),
      },
    };

    describe("@Body with ParameterDecoratorOptions", () => {
      it("should enhance param with schema when options passed as the only argument", () => {
        class Test {
          public test(@Body({ schema: mockSchema }) _body: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "body",
          data: undefined,
          schema: mockSchema,
        });
      });

      it("should enhance param with pipes when options with pipes passed as the only argument", () => {
        class Test {
          public test(
            @Body({ schema: mockSchema, pipes: [ParseIntPipe] } as any)
            _body: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "body",
          data: undefined,
          pipes: [ParseIntPipe],
          schema: mockSchema,
        });
      });

      it("should enhance param with schema when options passed as second argument with property", () => {
        class Test {
          public test(@Body("role", { schema: mockSchema }) _body: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "body",
          data: "role",
          schema: mockSchema,
        });
      });

      it("should not confuse a pipe instance with options", () => {
        class Test {
          public test(@Body(new ParseIntPipe()) _body: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]?.data).toBeUndefined();
        expect(params[0]?.pipes).toHaveLength(1);
        expect(params[0]?.schema).toBeUndefined();
      });
    });

    describe("@Query with ParameterDecoratorOptions", () => {
      it("should enhance param with schema when options passed as the only argument", () => {
        class Test {
          public test(@Query({ schema: mockSchema }) _query: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "query",
          data: undefined,
          schema: mockSchema,
        });
      });

      it("should enhance param with pipes when options with pipes passed as the only argument", () => {
        class Test {
          public test(
            @Query({ schema: mockSchema, pipes: [ParseIntPipe] } as any)
            _query: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "query",
          data: undefined,
          pipes: [ParseIntPipe],
          schema: mockSchema,
        });
      });

      it("should enhance param with schema when options passed as second argument with property", () => {
        class Test {
          public test(@Query("user", { schema: mockSchema }) _user: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "query",
          data: "user",
          schema: mockSchema,
        });
      });

      it("should not confuse a pipe instance with options", () => {
        class Test {
          public test(@Query(new ParseIntPipe()) _query: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]?.data).toBeUndefined();
        expect(params[0]?.pipes).toHaveLength(1);
        expect(params[0]?.schema).toBeUndefined();
      });
    });

    describe("@Param with ParameterDecoratorOptions", () => {
      it("should enhance param with schema when options passed as the only argument", () => {
        class Test {
          public test(@Param({ schema: mockSchema }) _params: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "param",
          data: undefined,
          schema: mockSchema,
        });
      });

      it("should enhance param with pipes when options with pipes passed as the only argument", () => {
        class Test {
          public test(
            @Param({ schema: mockSchema, pipes: [ParseIntPipe] } as any)
            _params: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "param",
          data: undefined,
          pipes: [ParseIntPipe],
          schema: mockSchema,
        });
      });

      it("should enhance param with schema when options passed as second argument with property", () => {
        class Test {
          public test(@Param("id", { schema: mockSchema }) _id: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "param",
          data: "id",
          schema: mockSchema,
        });
      });

      it("should not confuse a pipe instance with options", () => {
        class Test {
          public test(@Param(new ParseIntPipe()) _params: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]?.data).toBeUndefined();
        expect(params[0]?.pipes).toHaveLength(1);
        expect(params[0]?.schema).toBeUndefined();
      });
    });

    describe("@Res", () => {
      it("should enhance param with response metadata", () => {
        class Test {
          public test(@Res() _res: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "response",
        });
        expect(params[0]?.passthrough).toBeUndefined();
      });

      it('should enable passthrough when "passthrough" option is true', () => {
        class Test {
          public test(@Res({ passthrough: true }) _res: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "response",
          passthrough: true,
        });
      });

      itAdapted(
        "ADR-010",
        "should not inherit passthrough in an overriding method",
        () => {
          class Parent {
            public test(@Res({ passthrough: true }) _res: unknown) {}
          }
          class Child extends Parent {
            public override test(@Res() _res: unknown) {}
          }
          expect(
            MetadataRegistry.getRouteParameters(Parent, "test")[0]?.passthrough,
          ).toBe(true);
          expect(
            MetadataRegistry.getRouteParameters(Child, "test")[0]?.passthrough,
          ).toBeUndefined();
        },
        "passthrough stored on own ParameterMetadata entry (undefined on child without option)",
      );

      it("should enable passthrough in an overriding method", () => {
        class Parent {
          public test(@Res() _res: unknown) {}
        }
        class Child extends Parent {
          public override test(@Res({ passthrough: true }) _res: unknown) {}
        }
        expect(
          MetadataRegistry.getRouteParameters(Parent, "test")[0]?.passthrough,
        ).toBeUndefined();
        expect(
          MetadataRegistry.getRouteParameters(Child, "test")[0]?.passthrough,
        ).toBe(true);
      });
    });

    describe("@UploadedFile", () => {
      it("should enhance param with file metadata", () => {
        class Test {
          public test(@UploadedFile() _file: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "uploadedFile",
          data: undefined,
        });
      });

      it("should enhance param with file key and pipes", () => {
        class Test {
          public test(@UploadedFile("avatar", ParseFilePipe) _file: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "uploadedFile",
          data: "avatar",
          pipes: [ParseFilePipe],
        });
      });

      it("should not confuse a pipe passed as the first argument with a file key", () => {
        const pipe = new ParseFilePipe();
        class Test {
          public test(@UploadedFile(pipe) _file: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "uploadedFile",
          data: undefined,
          pipes: [pipe],
        });
      });
    });

    describe("@UploadedFiles", () => {
      it("should enhance param with files metadata", () => {
        class Test {
          public test(@UploadedFiles() _files: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "uploadedFiles",
          data: undefined,
        });
      });

      it("should enhance param with pipes", () => {
        const pipe = new ParseFilePipe();
        class Test {
          public test(@UploadedFiles(pipe) _files: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "uploadedFiles",
          data: undefined,
          pipes: [pipe],
        });
      });
    });

    describe("@Cookies", () => {
      it("should enhance param with cookies metadata", () => {
        class Test {
          public test(
            @Cookies() _all: unknown,
            @Cookies("theme", ParseIntPipe) _theme: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "cookies",
          data: undefined,
        });
        expect(params[1]).toMatchObject({
          index: 1,
          source: "cookies",
          data: "theme",
          pipes: [ParseIntPipe],
        });
      });

      it("should not confuse a pipe passed as the first argument with a name", () => {
        const pipe = new ParseIntPipe();
        class Test {
          public test(@Cookies(pipe) _cookies: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "cookies",
          data: undefined,
          pipes: [pipe],
        });
      });
    });

    describe("@SignedCookies", () => {
      it("should enhance param with signed cookies metadata", () => {
        class Test {
          public test(
            @SignedCookies() _all: unknown,
            @SignedCookies("uid") _uid: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "signedCookies",
          data: undefined,
        });
        expect(params[1]).toMatchObject({
          index: 1,
          source: "signedCookies",
          data: "uid",
        });
      });
    });

    describe("@RawBody", () => {
      it("should enhance param with raw body metadata", () => {
        class Test {
          public test(@RawBody() _rawBody: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "rawBody",
        });
      });

      it("should not confuse a pipe instance with options", () => {
        const pipe = new ParseIntPipe();
        class Test {
          public test(@RawBody(pipe) _rawBody: unknown) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "rawBody",
          pipes: [pipe],
        });
      });

      it("should enhance param with schema when options passed as the only argument", () => {
        class Test {
          public test(
            @RawBody({ schema: mockSchema } as any) _rawBody: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "rawBody",
          schema: mockSchema,
        });
      });

      it("should enhance param with pipes when options with pipes passed as the only argument", () => {
        class Test {
          public test(
            @RawBody({ schema: mockSchema, pipes: [ParseIntPipe] } as any)
            _rawBody: unknown,
          ) {}
        }
        const params = MetadataRegistry.getRouteParameters(Test, "test");
        expect(params[0]).toMatchObject({
          index: 0,
          source: "rawBody",
          pipes: [ParseIntPipe],
          schema: mockSchema,
        });
      });
    });

    describe("assignMetadata", () => {
      describe("when called with the legacy positional signature", () => {
        it("should use a non-object argument as data", () => {
          expect(assignMetadata({}, "body", 0, "role")).toEqual({
            "body:0": { index: 0, data: "role", pipes: [] },
          });
        });

        it("should not read an object argument as options when pipes are passed positionally", () => {
          const data = { data: "role" };
          expect(assignMetadata({}, "body", 0, data, ParseIntPipe)).toEqual({
            "body:0": {
              index: 0,
              data,
              pipes: [ParseIntPipe],
            },
          });
        });
      });
    });
  },
);
