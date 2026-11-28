import { describe, expect, it } from "bun:test";
import { BunestFactory } from "@bunest/core";
import { createGatewayModule } from "../src/gateway/gateway.module";
import { PostsSubgraphModule } from "../src/posts-subgraph/posts-subgraph.module";
import { UsersResolver } from "../src/users-subgraph/users.resolver";
import { UsersSubgraphModule } from "../src/users-subgraph/users-subgraph.module";

describe("GraphQL Federation v2 (NestJS 31-graphql-federation E2E)", () => {
  it("composes code-first Users subgraph + Posts subgraph via ApolloGatewayDriver and forwards auth headers", async () => {
    const usersApp = await BunestFactory.create(UsersSubgraphModule, {
      logger: false,
    });
    const postsApp = await BunestFactory.create(PostsSubgraphModule, {
      logger: false,
    });
    await usersApp.init();
    await postsApp.init();

    const inProcessFetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const req =
        input instanceof Request ? input : new Request(String(input), init);
      if (req.url.startsWith("http://users.internal")) {
        return usersApp.fetch(req);
      }
      if (req.url.startsWith("http://posts.internal")) {
        return postsApp.fetch(req);
      }
      throw new Error(`Unexpected subgraph URL: ${req.url}`);
    };

    const gatewayApp = await BunestFactory.create(
      createGatewayModule({
        usersUrl: "http://users.internal/graphql",
        postsUrl: "http://posts.internal/graphql",
        fetcher: inProcessFetcher,
      }),
      { logger: false },
    );
    await gatewayApp.init();

    try {
      const res = await gatewayApp.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fed-token-123",
          },
          body: JSON.stringify({
            query: `
              query FederatedProfile($id: ID!) {
                user(id: $id) {
                  id
                  name
                  bio
                  posts {
                    id
                    title
                  }
                }
                posts {
                  id
                  title
                }
              }
            `,
            variables: { id: "u2" },
          }),
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          user: {
            id: "u2",
            name: "Ada Lovelace",
            bio: "First computer programmer",
            posts: [{ id: "p2", title: "Notes on the Analytical Engine" }],
          },
          posts: [
            { id: "p1", title: "On Computable Numbers" },
            { id: "p2", title: "Notes on the Analytical Engine" },
          ],
        },
      });

      const usersResolver = usersApp.get(UsersResolver);
      expect(usersResolver.receivedAuthHeaders).toContain(
        "Bearer fed-token-123",
      );
    } finally {
      await gatewayApp.close();
      await postsApp.close();
      await usersApp.close();
    }
  });
});
