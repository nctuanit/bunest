import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  HttpStatus,
  MetadataRegistry,
  Module,
  Param,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiDefaultResponse,
  ApiForbiddenResponse,
  ApiFoundResponse,
  ApiGatewayTimeoutResponse,
  ApiGoneResponse,
  ApiInternalServerErrorResponse,
  ApiMethodNotAllowedResponse,
  ApiMovedPermanentlyResponse,
  ApiNoContentResponse,
  ApiNotAcceptableResponse,
  ApiNotFoundResponse,
  ApiNotImplementedResponse,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiPaymentRequiredResponse,
  ApiPreconditionFailedResponse,
  ApiRequestTimeoutResponse,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
  DocumentBuilder,
  SWAGGER_METADATA_KEYS,
  SwaggerModule,
  type ApiResponseOptions,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ApiResponse",
  {
    upstreamPath: "test/decorators/api-response.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores @ApiResponse entries via MetadataRegistry (SWAGGER_METADATA_KEYS.API_RESPONSES) per ADR-002 and builds OpenAPI responses in SwaggerModule.createDocument().",
  },
  () => {
    describe("when applied on the method level", () => {
      @Controller("tests/:testId")
      class TestAppController {
        @Get()
        @ApiResponse({ status: 204 })
        public get(@Param("testId") testId: string): string {
          return testId;
        }
      }

      it("should attach metadata to a given method", async () => {
        const controller = new TestAppController();
        expect(
          MetadataRegistry.has(
            SWAGGER_METADATA_KEYS.API_RESPONSES,
            controller.get,
          ),
        ).toBe(true);
        const raw = MetadataRegistry.get<readonly ApiResponseOptions[]>(
          SWAGGER_METADATA_KEYS.API_RESPONSES,
          controller.get,
        );
        expect(raw).toEqual([{ status: 204 }]);

        @Module({ controllers: [TestAppController] })
        class TestModule {}
        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
          );
          expect(doc.paths["/tests/{testId}"]?.get?.responses).toEqual({
            "204": { description: "" },
          });
        } finally {
          await app.close();
        }
      });

      it("should attach summary metadata to a given method (OpenAPI 3.2)", async () => {
        @Controller("tests/:testId")
        class SummaryController {
          @Get()
          @ApiOkResponse({ summary: "List of cats", description: "All cats" })
          public get(@Param("testId") testId: string): string {
            return testId;
          }
        }

        const controller = new SummaryController();
        const raw = MetadataRegistry.get<readonly ApiResponseOptions[]>(
          SWAGGER_METADATA_KEYS.API_RESPONSES,
          controller.get,
        );
        expect(raw).toEqual([
          {
            status: HttpStatus.OK,
            summary: "List of cats",
            description: "All cats",
          },
        ]);
      });

      it.each([
        { decorator: ApiOkResponse, status: HttpStatus.OK },
        { decorator: ApiCreatedResponse, status: HttpStatus.CREATED },
        { decorator: ApiAcceptedResponse, status: HttpStatus.ACCEPTED },
        { decorator: ApiNoContentResponse, status: HttpStatus.NO_CONTENT },
        {
          decorator: ApiMovedPermanentlyResponse,
          status: HttpStatus.MOVED_PERMANENTLY,
        },
        { decorator: ApiFoundResponse, status: HttpStatus.FOUND },
        { decorator: ApiBadRequestResponse, status: HttpStatus.BAD_REQUEST },
        { decorator: ApiUnauthorizedResponse, status: HttpStatus.UNAUTHORIZED },
        {
          decorator: ApiTooManyRequestsResponse,
          status: HttpStatus.TOO_MANY_REQUESTS,
        },
        { decorator: ApiNotFoundResponse, status: HttpStatus.NOT_FOUND },
        {
          decorator: ApiInternalServerErrorResponse,
          status: HttpStatus.INTERNAL_SERVER_ERROR,
        },
        { decorator: ApiBadGatewayResponse, status: HttpStatus.BAD_GATEWAY },
        { decorator: ApiConflictResponse, status: HttpStatus.CONFLICT },
        { decorator: ApiForbiddenResponse, status: HttpStatus.FORBIDDEN },
        {
          decorator: ApiGatewayTimeoutResponse,
          status: HttpStatus.GATEWAY_TIMEOUT,
        },
        { decorator: ApiGoneResponse, status: HttpStatus.GONE },
        {
          decorator: ApiMethodNotAllowedResponse,
          status: HttpStatus.METHOD_NOT_ALLOWED,
        },
        {
          decorator: ApiNotAcceptableResponse,
          status: HttpStatus.NOT_ACCEPTABLE,
        },
        {
          decorator: ApiNotImplementedResponse,
          status: HttpStatus.NOT_IMPLEMENTED,
        },
        {
          decorator: ApiPreconditionFailedResponse,
          status: HttpStatus.PRECONDITION_FAILED,
        },
        {
          decorator: ApiPayloadTooLargeResponse,
          status: HttpStatus.PAYLOAD_TOO_LARGE,
        },
        {
          decorator: ApiPaymentRequiredResponse,
          status: HttpStatus.PAYMENT_REQUIRED,
        },
        {
          decorator: ApiRequestTimeoutResponse,
          status: HttpStatus.REQUEST_TIMEOUT,
        },
        {
          decorator: ApiServiceUnavailableResponse,
          status: HttpStatus.SERVICE_UNAVAILABLE,
        },
        {
          decorator: ApiUnprocessableEntityResponse,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
        },
        {
          decorator: ApiUnsupportedMediaTypeResponse,
          status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        },
        { decorator: ApiDefaultResponse, status: "default" },
      ] as const)(
        "should not allow to override status of $decorator.name[$status]",
        ({ decorator, status }) => {
          @Controller("tests/:testId")
          class TestAppController {
            @Get()
            @decorator({
              // @ts-expect-error -- Should error if user tries to override status
              status: 2010,
            })
            public get(@Param("testId") testId: string): string {
              return testId;
            }
          }

          const controller = new TestAppController();
          expect(
            MetadataRegistry.has(
              SWAGGER_METADATA_KEYS.API_RESPONSES,
              controller.get,
            ),
          ).toBe(true);
          const raw = MetadataRegistry.get<readonly ApiResponseOptions[]>(
            SWAGGER_METADATA_KEYS.API_RESPONSES,
            controller.get,
          );
          expect(raw).toHaveLength(1);
          expect(raw?.[0]?.status).toBe(status);
        },
      );
    });

    describe("when the same status code is used multiple times", () => {
      @Controller("tests")
      class TestController {
        @Get()
        @ApiBadRequestResponse({ description: "email is invalid" })
        @ApiBadRequestResponse({ description: "password is too short" })
        @ApiBadRequestResponse({ description: "dto is invalid" })
        public post(): string {
          return "test";
        }
      }

      it("should merge descriptions with newline separator", async () => {
        @Module({ controllers: [TestController] })
        class TestModule {}
        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
          );
          expect(doc.paths["/tests"]?.get?.responses["400"]?.description).toBe(
            "dto is invalid\n\npassword is too short\n\nemail is invalid",
          );
        } finally {
          await app.close();
        }
      });

      it("should merge examples from multiple decorators", async () => {
        @Controller("tests")
        class ExamplesController {
          @Get()
          @ApiBadRequestResponse({
            description: "error A",
            examples: { case1: { summary: "Case 1", value: { msg: "a" } } },
          })
          @ApiBadRequestResponse({
            description: "error B",
            examples: { case2: { summary: "Case 2", value: { msg: "b" } } },
          })
          public get(): string {
            return "test";
          }
        }

        @Module({ controllers: [ExamplesController] })
        class TestModule {}
        const app = await BunestFactory.create(TestModule, { logger: false });
        try {
          const doc = SwaggerModule.createDocument(
            app,
            new DocumentBuilder().build(),
          );
          expect(
            doc.paths["/tests"]?.get?.responses["400"]?.content?.[
              "application/json"
            ]?.examples,
          ).toEqual({
            case1: { summary: "Case 1", value: { msg: "a" } },
            case2: { summary: "Case 2", value: { msg: "b" } },
          });
        } finally {
          await app.close();
        }
      });
    });
  },
);
