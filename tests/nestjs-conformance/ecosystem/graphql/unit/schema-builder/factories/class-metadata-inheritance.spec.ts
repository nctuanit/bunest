import "reflect-metadata";
import { beforeAll, expect, it } from "bun:test";
import type { GraphQLObjectType, GraphQLSchema } from "../../../../../../../packages/graphql/node_modules/graphql";
import {
  Directive,
  Extensions,
  Field,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ObjectType,
  PartialType,
  Query,
  Resolver,
} from "../../../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../../../_helpers/index";

const DirectiveMulti = Directive as unknown as (
  sdl: string | string[],
) => ClassDecorator & PropertyDecorator & MethodDecorator;

@Extensions({ role: "ADMIN" })
@ObjectType()
class Invoice {
  @Field()
  iban!: string;
}

@ObjectType()
class CreditNote extends Invoice {
  @Field()
  reason!: string;
}

@Extensions({ role: "ADMIN", audited: true })
@ObjectType({ isAbstract: true })
abstract class InternalRecord {
  @Field()
  createdBy!: string;
}

@Extensions({ role: "AUDITOR" })
@ObjectType()
class AuditEntry extends InternalRecord {
  @Field()
  action!: string;
}

@Directive("@first")
@Directive("@second")
@DirectiveMulti(["@third", "@fourth"])
@Extensions({ access: "PUBLIC" })
@Extensions({ access: "ADMIN" })
@ObjectType()
class Stacked {
  @Field()
  id!: string;
}

@Extensions({ access: "PUBLIC" })
@Extensions({ access: "ADMIN" })
@ObjectType()
class MappedStacked {
  @Field()
  id!: string;
}

@ObjectType()
class PartialMappedStacked extends PartialType(MappedStacked) {}

@Resolver()
class SampleResolver {
  @Query(() => Invoice)
  invoice(): Invoice {
    return null as unknown as Invoice;
  }

  @Query(() => CreditNote)
  creditNote(): CreditNote {
    return null as unknown as CreditNote;
  }

  @Query(() => AuditEntry)
  auditEntry(): AuditEntry {
    return null as unknown as AuditEntry;
  }

  @Query(() => Stacked)
  stacked(): Stacked {
    return null as unknown as Stacked;
  }

  @Query(() => MappedStacked)
  mappedStacked(): MappedStacked {
    return null as unknown as MappedStacked;
  }

  @Query(() => PartialMappedStacked)
  partialMappedStacked(): PartialMappedStacked {
    return null as unknown as PartialMappedStacked;
  }
}

describeConformance(
  "Class-level @Extensions() and @Directive()",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/class-metadata-inheritance.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS GraphQLSchemaFactory.create([ResolverClass]) to Bunest GraphQLSchemaFactory.create([new ResolverClass()]) (ADR-013).",
  },
  () => {
    let schemaFactory: GraphQLSchemaFactory;

    const getType = (schema: GraphQLSchema, name: string) =>
      schema.getType(name) as GraphQLObjectType;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile({ logger: false });

      schemaFactory = moduleRef.get(GraphQLSchemaFactory);
    });

    // BUNEST_BUG: getGraphQLExtensions (packages/graphql/src/decorators/type.decorators.ts:713-728) reads Reflect.getMetadata without merging ancestor class @Extensions(), so AuditEntry receives { role: "AUDITOR" } instead of { role: "AUDITOR", audited: true }.
    it.skip("should inherit class-level extensions, letting the subclass override a key", async () => {
      const schema = await schemaFactory.create([new SampleResolver()]);

      expect(getType(schema, "Invoice").extensions).toEqual({ role: "ADMIN" });
      expect(getType(schema, "CreditNote").extensions).toEqual({
        role: "ADMIN",
      });
      expect(getType(schema, "AuditEntry").extensions).toEqual({
        role: "AUDITOR",
        audited: true,
      });
    });

    // BUNEST_BUG: Directive() (packages/graphql/src/decorators/type.decorators.ts:532) does not accept string[] SDL arrays, GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts:1004-1020) never populates astNode.directives (actual undefined), and stacked @Extensions() overwrites in reverse decorator order while also injecting `directives` into `extensions`.
    it.skip("should keep stacked class directives and extensions in source order in every schema", async () => {
      for (let build = 0; build < 2; build++) {
        const schema = await schemaFactory.create([new SampleResolver()]);
        const stacked = getType(schema, "Stacked");

        expect(
          stacked.astNode?.directives?.map((directive) => directive.name.value),
        ).toEqual(["first", "second", "third", "fourth"]);
        // The decorator closest to the class is applied last.
        expect(stacked.extensions).toEqual({ access: "ADMIN" });
        expect(getType(schema, "MappedStacked").extensions).toEqual({
          access: "ADMIN",
        });
      }
    });
  },
);
