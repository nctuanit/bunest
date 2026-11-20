import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Param,
} from "../../../../../packages/common/src";
import { BunestFactory } from "../../../../../packages/core/src";
import {
  ApiExcludeController,
  ApiLink,
  ApiOkResponse,
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
} from "../../../../../packages/swagger/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "SwaggerModule response links",
  {
    upstreamPath: "e2e/swagger-module-links.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestFactory.create to BunestFactory.create (ADR-001). Bunest stores @ApiLink metadata on handler methods under SWAGGER_METADATA_KEYS.API_LINKS (ADR-002) and resolves links per exact model constructor.",
  },
  () => {
    class UserDto {
      @ApiProperty()
      id!: string;
    }

    class AdminUserDto extends UserDto {}

    @Controller("users")
    class UsersController {
      @Get(":id")
      @ApiOkResponse({ type: UserDto })
      findOne() {}

      @Get(":userId/posts")
      @ApiLink({ from: UserDto, routeParam: "userId" })
      listPosts(@Param("userId") _userId: string) {}
    }

    @ApiExcludeController()
    @Controller("admin")
    class AdminController {
      @Get("billing/:userId")
      @ApiLink({ from: UserDto, routeParam: "userId" })
      getBillingAccount(@Param("userId") _userId: string) {}

      @Get("audit/:userId")
      @ApiLink({ from: AdminUserDto, routeParam: "userId" })
      getAuditLog(@Param("userId") _userId: string) {}
    }

    @Module({ controllers: [UsersController, AdminController] })
    class AppModule {}

    it("only links to operations that are in the document", async () => {
      const app = await BunestFactory.create(AppModule, { logger: false });
      try {
        await app.init();
        const document = SwaggerModule.createDocument(
          app,
          new DocumentBuilder().build(),
        );

        const response = document.paths["/users/{id}"]?.get?.responses["200"];
        expect(
          Object.values((response as any)?.links ?? {}).map(
            (link: any) => link.operationId,
          ),
        ).toEqual(["UsersController_listPosts"]);
      } finally {
        await app.close();
      }
    });

    it("does not add the links of a subclass to its parent class", async () => {
      @Controller("active-admin")
      class ActiveAdminController {
        @Get("audit/:userId")
        @ApiLink({ from: AdminUserDto, routeParam: "userId" })
        getAuditLog(@Param("userId") _userId: string) {}
      }

      @Module({ controllers: [UsersController, ActiveAdminController] })
      class SubclassLinksModule {}

      const app = await BunestFactory.create(SubclassLinksModule, {
        logger: false,
      });
      try {
        await app.init();
        const document = SwaggerModule.createDocument(
          app,
          new DocumentBuilder().build(),
        );

        const response = document.paths["/users/{id}"]?.get?.responses["200"];
        const linkedOps = Object.values((response as any)?.links ?? {}).map(
          (link: any) => link.operationId,
        );
        expect(linkedOps).toEqual(["UsersController_listPosts"]);
        expect(linkedOps).not.toContain("ActiveAdminController_getAuditLog");
      } finally {
        await app.close();
      }
    });
  },
);
