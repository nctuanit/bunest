import { BunestFactory } from "@bunest/core";
import { createGatewayModule } from "./gateway/gateway.module";
import { PostsSubgraphModule } from "./posts-subgraph/posts-subgraph.module";
import { UsersSubgraphModule } from "./users-subgraph/users-subgraph.module";

const usersPort = Number(Bun.env.USERS_PORT ?? 4001);
const postsPort = Number(Bun.env.POSTS_PORT ?? 4002);
const gatewayPort = Number(Bun.env.PORT ?? 3000);

const usersApp = await BunestFactory.create(UsersSubgraphModule);
await usersApp.listen(usersPort);

const postsApp = await BunestFactory.create(PostsSubgraphModule);
await postsApp.listen(postsPort);

const gatewayApp = await BunestFactory.create(
  createGatewayModule({
    usersUrl: `http://127.0.0.1:${usersPort}/graphql`,
    postsUrl: `http://127.0.0.1:${postsPort}/graphql`,
  }),
);
await gatewayApp.listen(gatewayPort);

console.log(`Users subgraph:   http://localhost:${usersPort}/graphql`);
console.log(`Posts subgraph:   http://localhost:${postsPort}/graphql`);
console.log(`Apollo Gateway:   http://localhost:${gatewayPort}/graphql`);
