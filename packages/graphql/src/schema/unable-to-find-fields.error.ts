/**
 * Thrown by `getFieldsAndDecoratorForType()` when a class has no GraphQL
 * `@ObjectType`, `@InputType`, `@InterfaceType`, or `@ArgsType` metadata.
 */
export class UnableToFindFieldsError extends Error {
  constructor(name: string) {
    super(
      `Unable to find fields for type "${name}". Make sure it is decorated with @ObjectType(), @InputType(), @InterfaceType(), or @ArgsType().`,
    );
    this.name = "UnableToFindFieldsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
