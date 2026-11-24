import { expect, it } from "bun:test";
import type { GraphQLObjectType } from "../../../../../../packages/graphql/src";
import {
  METADATA_KEYS,
  MetadataRegistry,
} from "../../../../../../packages/core/src/common";
import {
  Field,
  GRAPHQL_METADATA_KEYS,
  GraphQLSchemaFactory,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
  type ResolverMetadata,
  type ResolverOptions,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

function resolveTargetName(resolverClass: Function): string | undefined {
  const meta = MetadataRegistry.get<ResolverMetadata>(
    GRAPHQL_METADATA_KEYS.RESOLVER,
    resolverClass,
  );
  if (!meta?.of) return undefined;
  const target =
    typeof meta.of === "function" &&
    !MetadataRegistry.has(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, meta.of) &&
    meta.of.length === 0 &&
    !Function.prototype.toString.call(meta.of).trimStart().startsWith("class")
      ? (meta.of as () => Function)()
      : meta.of;
  if (typeof target !== "function") return undefined;
  const objMeta = MetadataRegistry.get<{ name?: string }>(
    GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
    target,
  );
  return objMeta?.name ?? target.name;
}

describeConformance(
  "@Resolver decorator",
  {
    upstreamPath:
      "packages/graphql/tests/decorators/resolver.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS RESOLVER_TYPE_METADATA / extractMetadata / ENTRY_PROVIDER_WATERMARK checks to Bunest GRAPHQL_METADATA_KEYS.RESOLVER, METADATA_KEYS.INJECTABLE, and GraphQLSchemaFactory.",
  },
  () => {
    @ObjectType()
    class User {
      @Field(() => String)
      iban!: string;
    }

    @ObjectType()
    class Admin {
      @Field(() => String)
      iban!: string;
    }

    @Resolver(() => User)
    class UserFieldsResolver {
      @ResolveField(() => String)
      iban() {
        return "resolved-iban";
      }
    }

    it('should keep the type of the parent resolver for a bare "@Resolver()"', async () => {
      @Resolver()
      class UsersResolver extends UserFieldsResolver {
        @Query(() => User)
        user() {
          return { iban: "" };
        }
      }

      expect(resolveTargetName(UsersResolver)).toBe("User");

      const schema = await new GraphQLSchemaFactory().create([
        new UsersResolver(),
      ]);
      const userType = schema.getType("User") as GraphQLObjectType;
      expect(userType.getFields().iban?.resolve).toBeDefined();
    });

    it('should keep the type of the parent resolver for "@Resolver({ ... })"', () => {
      const ResolverWithOptions = Resolver as unknown as (
        options: ResolverOptions,
      ) => ClassDecorator;

      @ResolverWithOptions({ isAbstract: false })
      class UsersResolver extends UserFieldsResolver {}

      expect(resolveTargetName(UsersResolver)).toBe("User");
    });

    it("should let a subclass override the type of its parent resolver", async () => {
      @Resolver("Admin")
      class AdminsResolver extends UserFieldsResolver {
        @Query(() => Admin)
        admin() {
          return { iban: "" };
        }
      }

      @Resolver(() => Admin)
      class TypedAdminsResolver extends UserFieldsResolver {
        @Query(() => Admin)
        typedAdmin() {
          return { iban: "" };
        }
      }

      expect(resolveTargetName(AdminsResolver)).toBe("Admin");
      expect(resolveTargetName(TypedAdminsResolver)).toBe("Admin");

      const schema = await new GraphQLSchemaFactory().create([
        new AdminsResolver(),
      ]);
      const adminType = schema.getType("Admin") as GraphQLObjectType;
      expect(adminType.getFields().iban?.resolve).toBeDefined();
    });

    it('should mark the class of a method decorated with "@Resolver()" as an entry provider', () => {
      const MethodResolver = Resolver as unknown as (
        name: string,
      ) => MethodDecorator;

      class AuthorsResolver {
        @ResolveField()
        @MethodResolver("Author")
        posts() {
          return [];
        }
      }

      expect(
        MetadataRegistry.hasOwn(METADATA_KEYS.INJECTABLE, AuthorsResolver),
      ).toBe(true);
    });

    it('should mark a class that declares root handlers without "@Resolver()" as an entry provider', async () => {
      class HealthService {
        @Query(() => String)
        health() {
          return "ok";
        }
      }

      expect(
        MetadataRegistry.hasOwn(METADATA_KEYS.INJECTABLE, HealthService),
      ).toBe(true);
      const schema = await new GraphQLSchemaFactory().create([
        new HealthService(),
      ]);
      expect(schema.getQueryType()?.getFields().health).toBeDefined();
    });
  },
);
