import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Cookies,
  Delete,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  type ResponseContext,
  type UploadedFileInfo,
  type ValidationErrorResponse,
} from "@bunest/common";
import { ClassSerializerInterceptor, ValidationPipe } from "@bunest/core";
import { Exclude, Expose } from "class-transformer";
import { IsEmail, IsString, MinLength } from "class-validator";
import { Test, TestClient } from "../src";

class CreateAccountDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @MinLength(2)
  name!: string;
}

class AccountEntity {
  id!: string;
  email!: string;
  name!: string;

  @Exclude()
  password!: string;

  @Expose()
  get label(): string {
    return `${this.name} <${this.email}>`;
  }

  constructor(partial: Partial<AccountEntity> = {}) {
    Object.assign(this, partial);
  }
}

@Injectable()
class AccountsStore {
  public handlerCalls = 0;
  private readonly items = new Map<string, AccountEntity>();
  private seq = 0;

  create(dto: CreateAccountDto): AccountEntity {
    const id = `acc_${++this.seq}`;
    const entity = new AccountEntity({
      id,
      email: dto.email,
      name: dto.name,
      password: dto.password,
    });
    this.items.set(id, entity);
    return entity;
  }

  find(id: string): AccountEntity | undefined {
    return this.items.get(id);
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }
}

@Controller("/accounts")
@UseInterceptors(ClassSerializerInterceptor)
class AccountsController {
  constructor(private readonly store: AccountsStore) {}

  @Post()
  create(@Body() dto: CreateAccountDto): AccountEntity {
    this.store.handlerCalls += 1;
    return this.store.create(dto);
  }

  @Get("search")
  search(
    @Query("tag") tag: string | string[],
    @Query("page") page: string,
    @Headers("authorization") auth?: string,
    @Cookies("session") session?: string,
  ) {
    return { tag, page, auth, session };
  }

  @Get("set-cookies")
  setCookies(@Res() res: ResponseContext) {
    res.cookie("a", "1", { httpOnly: true, path: "/" });
    res.cookie("b", "hello world", { path: "/" });
    res.header("X-Custom", "bunest-ok");
    return { ok: true };
  }

  @Put(":id")
  replace(@Param("id") id: string, @Body() body: { name: string }) {
    return { id, replaced: body.name };
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: { name: string }) {
    return { id, patched: body.name };
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    this.store.delete(id);
  }

  @Post("upload")
  upload(@UploadedFile("avatar") file: UploadedFileInfo) {
    return {
      fieldname: file.fieldname,
      originalname: file.originalname,
      size: file.size,
      content: new TextDecoder().decode(file.buffer),
    };
  }
}

describe("TestClient & TestResponse (in-memory & live HTTP)", () => {
  it("runs full in-memory POST DTO ValidationPipe + ClassSerializerInterceptor + CRUD + cookies + uploads", async () => {
    const mod = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [AccountsStore],
    }).compile();

    const app = mod.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());

    const store = mod.get(AccountsStore);
    const client = mod.createTestClient(app);

    // 1. Valid POST -> 201 Created, password stripped by ClassSerializerInterceptor
    const createdRes = await client.post("/accounts", {
      json: {
        email: "alice@example.com",
        password: "super-secret-password",
        name: "Alice",
      },
    });
    createdRes
      .expectStatus(201)
      .expectHeader("content-type", /application\/json/);

    // TestResponse caches body cleanly across repeated json()/text()/bytes() reads
    const created = await createdRes.json<Record<string, unknown>>();
    const rawText = await createdRes.text();
    const rawBytes = await createdRes.bytes();
    expect(JSON.parse(rawText)).toEqual(created);
    expect(rawBytes.byteLength).toBeGreaterThan(0);

    expect(created).toEqual({
      id: "acc_1",
      email: "alice@example.com",
      name: "Alice",
      label: "Alice <alice@example.com>",
    });
    expect("password" in created).toBe(false);
    expect(store.handlerCalls).toBe(1);

    // 2. Invalid POST -> 400 Bad Request, handler is NOT called
    const badRes = await client.post("/accounts", {
      json: {
        email: "invalid-email",
        password: "123",
        name: "A",
        extraField: true,
      },
    });
    badRes.expectStatus(400);
    const errBody = await badRes.json<ValidationErrorResponse>();
    expect(errBody.statusCode).toBe(400);
    expect(errBody.message).toBe("Validation failed");
    expect(errBody.details.map((d) => d.field).sort()).toEqual([
      "email",
      "extraField",
      "name",
      "password",
    ]);
    expect(store.handlerCalls).toBe(1);

    // 3. Query params, inline query preservation, cookies, withBearerToken/withHeaders
    const authedClient = client
      .withBearerToken("jwt-abc")
      .withHeaders({ "X-Trace": "trace-1" });
    const searchRes = await authedClient.get("/accounts/search?page=2", {
      query: { tag: ["bun", "ts"], omitted: undefined },
      cookies: { session: "sess_42" },
    });
    searchRes.expectStatus(200);
    expect(await searchRes.json()).toEqual({
      tag: ["bun", "ts"],
      page: "2",
      auth: "Bearer jwt-abc",
      session: "sess_42",
    });

    // 4. Multi Set-Cookie + custom header assertions
    const cookieRes = await client.get("/accounts/set-cookies");
    cookieRes.expectStatus(200).expectHeader("x-custom", "bunest-ok");
    expect(cookieRes.setCookies()).toHaveLength(2);
    expect(cookieRes.cookies()).toEqual({ a: "1", b: "hello world" });

    // 5. PUT, PATCH, DELETE, HEAD, OPTIONS
    const putRes = await client.put("/accounts/acc_1", {
      json: { name: "Alice II" },
    });
    putRes.expectStatus(200);
    expect(await putRes.json()).toEqual({ id: "acc_1", replaced: "Alice II" });

    const patchRes = await client.patch("/accounts/acc_1", {
      json: { name: "Alice III" },
    });
    patchRes.expectStatus(200);
    expect(await patchRes.json()).toEqual({ id: "acc_1", patched: "Alice III" });

    const headRes = await client.head("/accounts/set-cookies");
    headRes.expectStatus(200);
    expect(await headRes.text()).toBe("");

    const delRes = await client.delete("/accounts/acc_1");
    delRes.expectStatus(204);

    // 6. Multipart upload via formData
    const form = new FormData();
    form.append(
      "avatar",
      new File(["avatar-bytes"], "pic.txt", { type: "text/plain" }),
    );
    const uploadRes = await client.post("/accounts/upload", {
      formData: form,
    });
    uploadRes.expectStatus(201);
    expect(await uploadRes.json()).toEqual({
      fieldname: "avatar",
      originalname: "pic.txt",
      size: 12,
      content: "avatar-bytes",
    });

    // 7. expectStatus / expectHeader throw informative errors on mismatch
    expect(() => createdRes.expectStatus(404)).toThrow(
      /Expected HTTP status 404, but received 201/,
    );
    expect(() => createdRes.expectHeader("x-missing", "val")).toThrow(
      /Expected response header "x-missing" to be present/,
    );
    expect(() => cookieRes.expectHeader("x-custom", "wrong")).toThrow(
      /Expected header "x-custom" to equal "wrong"/,
    );

    await mod.close();
  });

  it("supports live network HTTP requests via TestClient.fromUrl(info.url) with Bun.serve({ port: 0 })", async () => {
    const mod = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [AccountsStore],
    }).compile();

    const app = mod.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());
    const info = await app.listen(0);

    try {
      const liveClient = TestClient.fromUrl(info.url);
      const res = await liveClient.post("/accounts", {
        json: {
          email: "live@example.com",
          password: "live-password-123",
          name: "Live User",
        },
      });
      res.expectStatus(201);
      expect(await res.json()).toEqual({
        id: "acc_1",
        email: "live@example.com",
        name: "Live User",
        label: "Live User <live@example.com>",
      });

      // Raw fetch escape hatch works too (and preserves default headers on Request objects)
      const authedLive = liveClient.withBearerToken("live-tok");
      const raw = await authedLive.fetch(
        new Request(`${info.url}/accounts/search?page=1`),
      );
      expect(raw.status).toBe(200);
      expect((await raw.json()) as Record<string, unknown>).toMatchObject({
        page: "1",
        auth: "Bearer live-tok",
      });

      // Base URL path prefix preservation (e.g. /accounts as baseUrl)
      const prefixedClient = TestClient.fromUrl(`${info.url}/accounts`);
      const prefixedRes = await prefixedClient.get("/set-cookies");
      prefixedRes.expectStatus(200);
    } finally {
      await mod.close();
    }
  });
});
