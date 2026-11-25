# GraphQL & Apollo

Bunest cung cấp độ tương thích đầy đủ với `@nestjs/graphql` v14 và `@nestjs/apollo` chạy native trên Bun:

- **`@bunest/graphql`** (**142/142** export) — Hỗ trợ GraphQL theo cả code-first và schema-first, `@Resolver`, `@Query`, `@Mutation`, `@Subscription`, `@ResolveField`, `@ObjectType`, `@InputType`, `@InterfaceType`, `createUnionType`, `@Scalar`, `@Directive`, `@UseFilters`, `BunestDataLoader`, Federation v2 Subgraph và subscription qua SSE + `graphql-ws`.
- **`@bunest/graphql/apollo`** (**20/20** export) — `ApolloDriver`, `ApolloFederationDriver` (Federation v2 Subgraph) và `ApolloGatewayDriver` (gateway đa subgraph) tối ưu native cho Bun.

## Cài đặt

```bash
bun add @bunest/graphql graphql
```

## Bắt đầu nhanh với Code-First

Đăng ký `GraphQLModule.forRoot()` cùng `ApolloDriver`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import { ApolloDriver, type ApolloDriverConfig } from "@bunest/graphql/apollo";
import { BooksResolver } from "./books.resolver";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      path: "/graphql",
    }),
  ],
  providers: [BooksResolver],
})
export class AppModule {}
```

Định nghĩa các object type và resolver bằng những decorator quen thuộc:

@@filename(books.resolver.ts)

```ts
import { Args, Field, ID, ObjectType, Query, Resolver } from "@bunest/graphql";

@ObjectType()
export class Book {
  @Field(() => ID)
  id: string;

  @Field()
  title: string;
}

@Resolver(() => Book)
export class BooksResolver {
  @Query(() => [Book])
  books(): Book[] {
    return [{ id: "1", title: "Bunest in Action" }];
  }

  @Query(() => Book, { nullable: true })
  book(@Args("id") id: string): Book | null {
    return id === "1" ? { id: "1", title: "Bunest in Action" } : null;
  }
}
```

## Federation v2 & DataLoader

- Sử dụng `ApolloFederationDriver` cho các subgraph (`@Directive('@key(fields: "id")')`, `@ResolveReference()`) và `ApolloGatewayDriver` để ghép nhiều subgraph thành một gateway thống nhất.
- Gom nhóm (batch) các truy vấn trường dữ liệu tránh N+1 bằng `BunestDataLoader` theo phạm vi từng request.
- Truyền tải cập nhật thời gian thực qua WebSocket `graphql-ws` hoặc HTTP Server-Sent Events (SSE).
