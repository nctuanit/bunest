import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Field,
  ObjectType,
  ResolveField,
  type ResolveFieldOptions,
  Resolver,
  getResolverFields,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

const ResolveFieldWithOptionsOnly = ResolveField as (
  options: ResolveFieldOptions,
) => MethodDecorator;

/**
 * The schema field name is derived from the decorator options, while the
 * resolver map is keyed off field resolver metadata. Both have to agree,
 * otherwise the field is exposed without a resolver attached to it.
 */
describeConformance(
  "@ResolveField decorator",
  {
    upstreamPath:
      "packages/graphql/tests/decorators/resolve-field.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS Reflect.getMetadata(RESOLVER_NAME_METADATA, ...) checks to Bunest getResolverFields(resolverClass) metadata.",
  },
  () => {
    @ObjectType()
    class Author {
      @Field(() => String)
      firstName!: string;
    }

    // BUNEST_BUG: @ResolveField({ name: "posts" }) ignores an options object passed as the sole argument in packages/graphql/src/decorators/resolver.decorators.ts (missing object-argument branch; expected "posts", received "getPosts").
    it.skip('should propagate "name" given as the only argument', () => {
      @Resolver(() => Author)
      class AuthorResolver {
        @ResolveFieldWithOptionsOnly({ name: "posts" })
        getPosts() {
          return [];
        }
      }

      const fields = getResolverFields(AuthorResolver);
      const entry = fields.find((f) => f.handlerKey === "getPosts");
      expect(entry?.name).toEqual("posts");
    });

    it('should propagate "name" given alongside a type function', () => {
      @Resolver(() => Author)
      class AuthorResolver {
        @ResolveField(() => [String], { name: "posts" })
        getPosts() {
          return [];
        }
      }

      const fields = getResolverFields(AuthorResolver);
      const entry = fields.find((f) => f.handlerKey === "getPosts");
      expect(entry?.name).toEqual("posts");
    });

    it('should fall back to the method name when no "name" is given', () => {
      @Resolver(() => Author)
      class AuthorResolver {
        @ResolveField(() => [String])
        posts() {
          return [];
        }
      }

      const fields = getResolverFields(AuthorResolver);
      const entry = fields.find((f) => f.handlerKey === "posts");
      expect(entry?.name).toEqual("posts");
    });
  },
);
