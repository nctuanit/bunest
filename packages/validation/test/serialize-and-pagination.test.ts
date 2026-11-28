import { describe, expect, it } from "bun:test";
import { BunestFactory, Controller, Get, Module, Query, UsePipes } from "@bunest/core";
import {
  CursorPaginationQueryDto,
  OffsetPaginationQueryDto,
  Prop,
  Serialize,
  ValidationPipe,
  createPaginatedResponse,
} from "../src/index";

describe("@Serialize(Dto) & Built-in Pagination DTOs", () => {
  class UserResponseDto {
    @Prop({ string: true })
    id!: string;

    @Prop({ email: true })
    email!: string;

    @Prop({ expose: "display_name", optional: true })
    displayName?: string;

    @Prop({ exclude: true, optional: true })
    internalNote?: string;
  }

  @Controller("users")
  @UsePipes(new ValidationPipe())
  class UsersController {
    @Get("one")
    @Serialize(UserResponseDto)
    getOne() {
      // Plain DB object with sensitive passwordHash & internalNote
      return {
        id: "u1",
        email: "dev@bunest.dev",
        displayName: "Bunest Dev",
        passwordHash: "$2b$12$secret",
        internalNote: "internal-only",
      };
    }

    @Get("list")
    @Serialize(UserResponseDto, { wrapperKey: "data" })
    getList(@Query() query: OffsetPaginationQueryDto) {
      const all = [
        { id: "u1", email: "a@b.com", passwordHash: "secret1" },
        { id: "u2", email: "c@d.com", passwordHash: "secret2" },
      ];
      return createPaginatedResponse(all, {
        total: 45,
        page: query.page,
        limit: query.limit,
      });
    }

    @Get("cursor")
    getCursor(@Query() query: CursorPaginationQueryDto) {
      return {
        cursor: query.cursor ?? null,
        limit: query.limit,
        sortBy: query.sortBy ?? null,
        sortOrder: query.sortOrder ?? null,
      };
    }

    @Get("raw")
    @Serialize(UserResponseDto)
    getRawResponse() {
      return new Response("plain-text", { status: 200 });
    }
  }

  @Module({ controllers: [UsersController] })
  class AppModule {}

  it("strips undeclared/sensitive fields (passwordHash, @Exclude) on single objects and paginated wrappers", async () => {
    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const resOne = await app.fetch(new Request("http://localhost/users/one"));
      expect(resOne.status).toBe(200);
      expect(await resOne.json()).toEqual({
        id: "u1",
        email: "dev@bunest.dev",
        display_name: "Bunest Dev",
      });

      const resList = await app.fetch(
        new Request("http://localhost/users/list?page=2&limit=10&sortOrder=asc"),
      );
      expect(resList.status).toBe(200);
      expect(await resList.json()).toEqual({
        data: [
          { id: "u1", email: "a@b.com" },
          { id: "u2", email: "c@d.com" },
        ],
        meta: {
          total: 45,
          page: 2,
          limit: 10,
          totalPages: 5,
          hasNextPage: true,
          hasPrevPage: true,
        },
      });

      // Native Response passes through untouched
      const resRaw = await app.fetch(new Request("http://localhost/users/raw"));
      expect(resRaw.status).toBe(200);
      expect(await resRaw.text()).toBe("plain-text");
    } finally {
      await app.close();
    }
  });

  it("validates and coerces OffsetPaginationQueryDto & CursorPaginationQueryDto", async () => {
    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const resBadLimit = await app.fetch(
        new Request("http://localhost/users/list?limit=500"),
      );
      expect(resBadLimit.status).toBe(400);

      const resBadSort = await app.fetch(
        new Request("http://localhost/users/cursor?sortOrder=invalid"),
      );
      expect(resBadSort.status).toBe(400);

      const resCursor = await app.fetch(
        new Request("http://localhost/users/cursor?cursor=abc&limit=15&sortBy=id&sortOrder=asc"),
      );
      expect(resCursor.status).toBe(200);
      expect(await resCursor.json()).toEqual({
        cursor: "abc",
        limit: 15,
        sortBy: "id",
        sortOrder: "asc",
      });

      const dto = new OffsetPaginationQueryDto();
      dto.page = 3;
      dto.limit = 25;
      expect(dto.offset).toBe(50);
    } finally {
      await app.close();
    }
  });
});
