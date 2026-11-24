import { afterEach, beforeEach, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import {
  ensureDir,
  join,
  removePath,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  GraphQLFactory,
  GraphQLFederationDefinitionsFactory,
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const HEADER = `
/*
 * -------------------------------------------------------
 * THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)
 * -------------------------------------------------------
 */

/* tslint:disable */
/* eslint-disable */`;

const SIMPLE_TYPE_GQL = `type Cat {
  id: Int!
  name: String!
  age: Int
  color: String
  weight: Int
}
`;

const SIMPLE_TYPE_EXPECTED = `${HEADER}

export interface Cat {
    id: number;
    name: string;
    age?: Nullable<number>;
    color?: Nullable<string>;
    weight?: Nullable<number>;
}

type Nullable<T> = T | null;
`;

const INTERFACE_PROPERTY_GQL = `type Bar {
  id: Int!
}

type Foo {
  a: Bar!
  b: Bar
}
`;

const INTERFACE_PROPERTY_EXPECTED = `${HEADER}

export interface Bar {
    id: number;
}

export interface Foo {
    a: Bar;
    b?: Nullable<Bar>;
}

type Nullable<T> = T | null;
`;

const ARRAY_PROPERTY_GQL = `type Foo {
  a: [String!]!
  b: [String!]
  c: [String]!
  d: [String]
  e: [[String!]!]!
  f: [[[String!]!]!]!
  g: [[[String]]]
}
`;

const ARRAY_PROPERTY_EXPECTED = `${HEADER}

export interface Foo {
    a: string[];
    b?: Nullable<string[]>;
    c: Nullable<string>[];
    d?: Nullable<Nullable<string>[]>;
    e: string[][];
    f: string[][][];
    g?: Nullable<Nullable<Nullable<Nullable<string>[]>[]>[]>;
}

type Nullable<T> = T | null;
`;

const QUERY_GQL = `type Cat {
  id: Int!
}

type Query {
  cat(id: ID!): Cat
}
`;

const QUERY_EXPECTED = `${HEADER}

export interface Cat {
    id: number;
}

export interface IQuery {
    cat(id: string): Nullable<Cat> | Promise<Nullable<Cat>>;
}

type Nullable<T> = T | null;
`;

const QUERY_SKIP_ARGS_EXPECTED = `${HEADER}

export interface Cat {
    id: number;
}

export interface IQuery {
    cat?: Nullable<Cat>;
}

type Nullable<T> = T | null;
`;

const MUTATION_GQL = `type Cat {
  id: Int!
}

type Mutation {
  createCat(name: String): Cat
  returnsQuery: Query
}

type Query {
  query: Int
}
`;

const MUTATION_EXPECTED = `${HEADER}

export interface Cat {
    id: number;
}

export interface IMutation {
    createCat(name?: Nullable<string>): Nullable<Cat> | Promise<Nullable<Cat>>;
    returnsQuery(): Nullable<IQuery> | Promise<Nullable<IQuery>>;
}

export interface IQuery {
    query(): Nullable<number> | Promise<Nullable<number>>;
}

type Nullable<T> = T | null;
`;

const ENUM_GQL = `enum Foobar {
  Foo
  Bar
  Baz
}
`;

const ENUM_EXPECTED = `${HEADER}

export enum Foobar {
    Foo = "Foo",
    Bar = "Bar",
    Baz = "Baz"
}

type Nullable<T> = T | null;
`;

const ENUM_AS_TYPE_EXPECTED = `${HEADER}
export type Foobar = "Foo" | "Bar" | "Baz";
type Nullable<T> = T | null;
`;

const CUSTOM_SCALAR_GQL = `scalar CustomDate
`;

const CUSTOM_SCALAR_EXPECTED = `${HEADER}
export type CustomDate = any;
type Nullable<T> = T | null;
`;

const CUSTOM_SCALAR_DEFAULT_TYPE_EXPECTED = `${HEADER}
export type CustomDate = unknown;
type Nullable<T> = T | null;
`;

const CUSTOM_SCALAR_TYPE_MAPPING_GQL = `scalar List
scalar Point
scalar DateTime`;

const CUSTOM_SCALAR_TYPE_MAPPING_EXPECTED = `${HEADER}
export type List = string[];
export type Point = [number, number];
export type DateTime = Date;
type Nullable<T> = T | null;
`;

const CUSTOM_HEADER_EXPECTED = `${HEADER}

/* Put anything here you like */
export type CustomDate = any;
type Nullable<T> = T | null;
`;

const FEDERATION_GQL = `type Post {
  id: ID!
  title: String!
  author: User!
  category: Category!
}

extend type User @key(fields: "id") {
  id: ID! @external
  posts: [Post]
}

extend type Query {
  getPosts: [Post]
}

extend enum Category {
  POST
}
`;

const FEDERATION_EXPECTED = `${HEADER}

export enum Category {
    POST = "POST"
}

export class Post {
    id: string;
    title: string;
    author: User;
    category: Category;
}

export class User {
    id: string;
    posts?: Nullable<Nullable<Post>[]>;
}

export abstract class IQuery {
    abstract getPosts(): Nullable<Nullable<Post>[]> | Promise<Nullable<Nullable<Post>[]>>;
}

type Nullable<T> = T | null;
`;

const FEDERATION_TYPEDEF_EXPECTED = `${HEADER}

export enum Animal {
    DOG = "DOG",
    CAT = "CAT"
}

export enum Category {
    POST = "POST"
}

export class Post {
    id: string;
    title: string;
    author: User;
    category: Category;
}

export class User {
    id: string;
    posts?: Nullable<Nullable<Post>[]>;
}

export abstract class IQuery {
    abstract getPosts(): Nullable<Nullable<Post>[]> | Promise<Nullable<Nullable<Post>[]>>;
}

type Nullable<T> = T | null;
`;

const TYPENAME_EXPECTED = `${HEADER}

export interface Cat {
    __typename?: 'Cat';
    id: number;
    name: string;
    age?: Nullable<number>;
    color?: Nullable<string>;
    weight?: Nullable<number>;
}

type Nullable<T> = T | null;
`;

const FEDERATION_PARTIAL_QUERY_GQL = `extend type Query {
    foo: Boolean
}
`;

const FEDERATION_PARTIAL_QUERY_EXPECTED = `${HEADER}

export interface IQuery {
    foo(): Nullable<boolean> | Promise<Nullable<boolean>>;
}

type Nullable<T> = T | null;
`;

const TYPE_NAME_GQL = `type User {
  id: ID!
  name: String!
  email: String!
  role: UserRole!
  profile: Profile
}

type Profile {
  bio: String
  avatar: String
}

enum UserRole {
  ADMIN
  USER
  GUEST
}

union SearchResult = User | Profile

input CreateUserInput {
  name: String!
  email: String!
  role: UserRole!
}

type Query {
  user(id: ID!): User
  searchUsers(query: String!): [SearchResult!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
}

scalar DateTime
`;

const TYPE_NAME_EXPECTED = `${HEADER}

export enum UserRoleSchema {
    ADMIN = "ADMIN",
    USER = "USER",
    GUEST = "GUEST"
}

export interface CreateUserInputSchema {
    name: string;
    email: string;
    role: UserRoleSchema;
}

export interface UserSchema {
    id: string;
    name: string;
    email: string;
    role: UserRoleSchema;
    profile?: Nullable<ProfileSchema>;
}

export interface ProfileSchema {
    bio?: Nullable<string>;
    avatar?: Nullable<string>;
}

export interface IQuery {
    user(id: string): Nullable<UserSchema> | Promise<Nullable<UserSchema>>;
    searchUsers(query: string): SearchResultSchema[] | Promise<SearchResultSchema[]>;
}

export interface IMutation {
    createUser(input: CreateUserInputSchema): UserSchema | Promise<UserSchema>;
}

export type DateTimeSchema = any;
export type SearchResultSchema = UserSchema | ProfileSchema;
type Nullable<T> = T | null;
`;

@Resolver()
class MinimalResolver {
  @Query(() => String)
  ping(): string {
    return "pong";
  }
}

@Module({
  imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
  providers: [MinimalResolver],
})
class DefinitionsAppModule {}

describeConformance(
  "Generated Definitions",
  {
    upstreamPath: "packages/apollo/tests/e2e/generated-definitions.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo GraphQLFactory & GraphQLFederationDefinitionsFactory TypeScript definition generation E2E to native @bunest/graphql using isolated temp directories.",
  },
  () => {
    let app: BunestApplication;
    let graphqlFactory: GraphQLFactory;
    let workDir: string;

    beforeEach(async () => {
      workDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-gql-defs-${crypto.randomUUID()}`,
      );
      await ensureDir(workDir);

      const moduleRef = await Test.createTestingModule({
        imports: [DefinitionsAppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      graphqlFactory = app.get<GraphQLFactory>(GraphQLFactory);
    });

    afterEach(async () => {
      await app.close();
      await removePath(workDir, { recursive: true, force: true });
    });

    it("should generate interface definitions for types", async () => {
      const outputFile = join(workDir, "simple-type.test-definitions.ts");
      await graphqlFactory.generateDefinitions(SIMPLE_TYPE_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(SIMPLE_TYPE_EXPECTED);
    });

    it("should generate properties referencing other interfaces", async () => {
      const outputFile = join(
        workDir,
        "interface-property.test-definitions.ts",
      );
      await graphqlFactory.generateDefinitions(INTERFACE_PROPERTY_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(
        INTERFACE_PROPERTY_EXPECTED,
      );
    });

    it("should generate array properties with correct optionality", async () => {
      const outputFile = join(workDir, "array-property.test-definitions.ts");
      await graphqlFactory.generateDefinitions(ARRAY_PROPERTY_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(ARRAY_PROPERTY_EXPECTED);
    });

    it("should generate queries", async () => {
      const outputFile = join(workDir, "query.test-definitions.ts");
      await graphqlFactory.generateDefinitions(QUERY_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(QUERY_EXPECTED);
    });

    it("should generate queries with methods as fields (skipResolverArgs: true)", async () => {
      const outputFile = join(workDir, "query-skip-args.test-definitions.ts");
      await graphqlFactory.generateDefinitions(QUERY_GQL, {
        definitions: {
          path: outputFile,
          skipResolverArgs: true,
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(QUERY_SKIP_ARGS_EXPECTED);
    });

    it("should generate mutations", async () => {
      const outputFile = join(workDir, "mutation.test-definitions.ts");
      await graphqlFactory.generateDefinitions(MUTATION_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(MUTATION_EXPECTED);
    });

    it("should generate enums", async () => {
      const outputFile = join(workDir, "enum.test-definitions.ts");
      await graphqlFactory.generateDefinitions(ENUM_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(ENUM_EXPECTED);
    });

    it("should generate enums as types", async () => {
      const outputFile = join(workDir, "enum-as-type.test-definitions.ts");
      await graphqlFactory.generateDefinitions(ENUM_GQL, {
        definitions: {
          path: outputFile,
          enumsAsTypes: true,
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(ENUM_AS_TYPE_EXPECTED);
    });

    it("should generate custom scalars", async () => {
      const outputFile = join(workDir, "custom-scalar.test-definitions.ts");
      await graphqlFactory.generateDefinitions(CUSTOM_SCALAR_GQL, {
        definitions: { path: outputFile },
      });

      expect(await Bun.file(outputFile).text()).toBe(CUSTOM_SCALAR_EXPECTED);
    });

    it("should generate custom scalars with a default type", async () => {
      const outputFile = join(
        workDir,
        "custom-scalar-default-type.test-definitions.ts",
      );
      await graphqlFactory.generateDefinitions(CUSTOM_SCALAR_GQL, {
        definitions: {
          path: outputFile,
          defaultScalarType: "unknown",
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(
        CUSTOM_SCALAR_DEFAULT_TYPE_EXPECTED,
      );
    });

    it("should generate custom scalars with a type mapping", async () => {
      const outputFile = join(
        workDir,
        "custom-scalar-type-mapping.test-definitions.ts",
      );
      await graphqlFactory.generateDefinitions(CUSTOM_SCALAR_TYPE_MAPPING_GQL, {
        definitions: {
          path: outputFile,
          customScalarTypeMapping: {
            List: "string[]",
            Point: "[number, number]",
            DateTime: Date,
          },
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(
        CUSTOM_SCALAR_TYPE_MAPPING_EXPECTED,
      );
    });

    it("should prepend a custom header", async () => {
      const outputFile = join(workDir, "custom-header.test-definitions.ts");
      await graphqlFactory.generateDefinitions(CUSTOM_SCALAR_GQL, {
        definitions: {
          path: outputFile,
          additionalHeader: "/* Put anything here you like */",
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(CUSTOM_HEADER_EXPECTED);
    });

    it("should generate for a federated graph", async () => {
      const gqlFile = join(workDir, "federation.graphql");
      await Bun.write(gqlFile, FEDERATION_GQL);
      const outputFile = join(workDir, "federation.test-definitions.ts");

      const factory = new GraphQLFederationDefinitionsFactory();
      await factory.generate({
        typePaths: [gqlFile],
        path: outputFile,
        outputAs: "class",
      });

      expect(await Bun.file(outputFile).text()).toBe(FEDERATION_EXPECTED);
    });

    it("should generate for a federated graph with typeDef", async () => {
      const gqlFile = join(workDir, "federation-typedef.graphql");
      await Bun.write(gqlFile, FEDERATION_GQL);
      const outputFile = join(
        workDir,
        "federation-typedef.test-definitions.ts",
      );

      const factory = new GraphQLFederationDefinitionsFactory();
      await factory.generate({
        typePaths: [gqlFile],
        typeDefs: `enum Animal {
          DOG
          CAT
        }`,
        path: outputFile,
        outputAs: "class",
      });

      expect(await Bun.file(outputFile).text()).toBe(
        FEDERATION_TYPEDEF_EXPECTED,
      );
    });

    it("should generate with __typename field for each object type", async () => {
      const outputFile = join(workDir, "typename.test-definitions.ts");
      await graphqlFactory.generateDefinitions(SIMPLE_TYPE_GQL, {
        definitions: {
          path: outputFile,
          emitTypenameField: true,
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(TYPENAME_EXPECTED);
    });

    it("should generate for a federated graph with partial query definition", async () => {
      const gqlFile = join(workDir, "federation-partial-query.graphql");
      await Bun.write(gqlFile, FEDERATION_PARTIAL_QUERY_GQL);
      const outputFile = join(
        workDir,
        "federation-partial-query.test-definitions.ts",
      );

      const factory = new GraphQLFederationDefinitionsFactory();
      await factory.generate({
        typePaths: [gqlFile],
        path: outputFile,
        outputAs: "interface",
      });

      expect(await Bun.file(outputFile).text()).toBe(
        FEDERATION_PARTIAL_QUERY_EXPECTED,
      );
    });

    it("should apply typeName function to transform type names", async () => {
      const outputFile = join(workDir, "type-name.test-definitions.ts");
      await graphqlFactory.generateDefinitions(TYPE_NAME_GQL, {
        definitions: {
          path: outputFile,
          typeName: (name: string) => `${name}Schema`,
        },
      });

      expect(await Bun.file(outputFile).text()).toBe(TYPE_NAME_EXPECTED);
    });
  },
);
