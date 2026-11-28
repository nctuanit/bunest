import { describe, expect, it } from "bun:test";
import { GraphQLService } from "@bunest/graphql";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("GraphQL Code-First (NestJS 23-graphql-code-first E2E)", () => {
  it("generates SDL schema, executes queries with @ArgsType and @ResolveField, validates mutations, and serves GraphiQL", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. Verify generated code-first SDL
      const sdl = mod.get(GraphQLService).printSDL();
      expect(sdl).toContain("type Recipe");
      expect(sdl).toContain("input NewRecipeInput");

      // 2. Query recipes with pagination @ArgsType and computed @ResolveField
      const listRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `
              query ($take: Int) {
                recipes(skip: 0, take: $take) {
                  id
                  title
                  ingredientCount
                }
              }
            `,
            variables: { take: 2 },
          }),
        }),
      );
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({
        data: {
          recipes: [
            { id: "1", title: "Pho Bo", ingredientCount: 4 },
            { id: "2", title: "Banh Mi", ingredientCount: 4 },
          ],
        },
      });

      // 3. Valid mutation
      const createRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation ($input: NewRecipeInput!) {
                addRecipe(newRecipeData: $input) {
                  id
                  title
                  ingredientCount
                }
              }
            `,
            variables: {
              input: {
                title: "Bun Cha",
                description: "Grilled pork with vermicelli",
                ingredients: ["pork", "vermicelli", "fish sauce"],
              },
            },
          }),
        }),
      );
      expect(createRes.status).toBe(200);
      expect(await createRes.json()).toEqual({
        data: {
          addRecipe: { id: "3", title: "Bun Cha", ingredientCount: 3 },
        },
      });

      // 4. Invalid mutation rejected by ValidationPipe (title < 3 chars)
      const invalidRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation {
                addRecipe(newRecipeData: { title: "X", ingredients: ["salt"] }) {
                  id
                }
              }
            `,
          }),
        }),
      );
      const invalidJson = (await invalidRes.json()) as {
        errors?: Array<{
          extensions?: { originalError?: { statusCode?: number } };
        }>;
      };
      expect(invalidJson.errors).toHaveLength(1);
      expect(invalidJson.errors?.[0]?.extensions?.originalError?.statusCode).toBe(
        400,
      );

      // 5. Remove mutation
      const delRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation { removeRecipe(id: "3") }`,
          }),
        }),
      );
      expect(await delRes.json()).toEqual({ data: { removeRecipe: true } });

      // 6. GraphiQL HTML explorer
      const uiRes = await app.fetch(
        new Request("http://localhost/graphql", {
          headers: { accept: "text/html" },
        }),
      );
      expect(uiRes.status).toBe(200);
      expect(uiRes.headers.get("content-type")).toContain("text/html");
    } finally {
      await app.close();
    }
  });
});
