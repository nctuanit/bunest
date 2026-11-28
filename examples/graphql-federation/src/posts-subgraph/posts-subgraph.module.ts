import { Module } from "@bunest/core";
import { GraphQLModule } from "@bunest/graphql";
import {
  ApolloFederationDriver,
  type ApolloFederationDriverConfig,
} from "@bunest/graphql/apollo";

const POSTS_DATA = [
  { id: "p1", title: "On Computable Numbers", authorId: "u1" },
  { id: "p2", title: "Notes on the Analytical Engine", authorId: "u2" },
];

const USER_BIOS: Record<string, string> = {
  u1: "Father of theoretical computer science",
  u2: "First computer programmer",
};

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      federation: { version: 2 },
      typeDefs: `
        type Post {
          id: ID!
          title: String!
        }
        type User @key(fields: "id") {
          id: ID! @external
          bio: String!
          posts: [Post!]!
        }
        type Query {
          posts: [Post!]!
        }
      `,
      resolvers: {
        Query: {
          posts: () => POSTS_DATA,
        },
        User: {
          __resolveReference: (ref: { id: string }) => ({
            id: ref.id,
            bio: USER_BIOS[ref.id] ?? "Bunest contributor",
            posts: POSTS_DATA.filter((p) => p.authorId === ref.id),
          }),
        },
      },
    }),
  ],
})
export class PostsSubgraphModule {}
