import {
  Directive,
  Extensions,
  Field,
  ObjectType,
} from "../../../../../../../../packages/graphql/src";

@ObjectType({ isAbstract: true })
export abstract class BaseType {
  @Field()
  @Directive("@upper")
  @Extensions({ extension: true })
  id!: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  // Adapted per ADR-002: explicit @Field() replaces SWC MetadataLoader serialized metadata
  @Field()
  meta!: string;
}
