import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("GraphQL Schema-First (NestJS 12-graphql-schema-first E2E)", () => {
  it("loads SDL from cats.graphql, resolves @ResolveField('owner'), and enforces GqlExecutionContext guard", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. Query seeded cat + nested owner
      const queryRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `{ cats { id name age owner { id name } } }`,
          }),
        }),
      );
      expect(queryRes.status).toBe(200);
      expect(await queryRes.json()).toEqual({
        data: {
          cats: [
            { id: 1, name: "Garfield", age: 5, owner: { id: 1, name: "Jon" } },
          ],
        },
      });

      // 2. Mutation blocked for guest by CatsGuard (GqlExecutionContext)
      const deniedRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", "x-role": "guest" },
          body: JSON.stringify({
            query: `mutation { createCat(createCatInput: { name: "Nermal", age: 1 }) { id } }`,
          }),
        }),
      );
      const deniedJson = (await deniedRes.json()) as {
        errors?: Array<{
          extensions?: { originalError?: { statusCode?: number } };
        }>;
      };
      expect(deniedJson.errors?.[0]?.extensions?.originalError?.statusCode).toBe(
        403,
      );

      // 3. Mutation allowed for admin -> returns created cat with resolved owner
      const createRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", "x-role": "admin" },
          body: JSON.stringify({
            query: `
              mutation {
                createCat(createCatInput: { name: "Nermal", age: 1, ownerId: 2 }) {
                  id name age owner { id name }
                }
              }
            `,
          }),
        }),
      );
      expect(createRes.status).toBe(200);
      expect(await createRes.json()).toEqual({
        data: {
          createCat: {
            id: 2,
            name: "Nermal",
            age: 1,
            owner: { id: 2, name: "Liz" },
          },
        },
      });
    } finally {
      await app.close();
    }
  });
});
