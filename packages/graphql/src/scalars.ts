import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLScalarType,
  GraphQLString,
  Kind,
  print,
} from "graphql";

/**
 * Built-in GraphQL scalar tokens usable in `@Field(() => Int)`,
 * `@Query(() => Float)`, `@Args("id", { type: () => ID })`, etc.
 */
export const Int: GraphQLScalarType = GraphQLInt;
export const Float: GraphQLScalarType = GraphQLFloat;
export const ID: GraphQLScalarType = GraphQLID;

function coerceDateTime(value: unknown): Date {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    !(value instanceof Date)
  ) {
    throw new GraphQLError("DateTime cannot represent non-string value.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GraphQLError(
      "DateTime cannot represent an invalid date-time value.",
    );
  }
  return date;
}

/**
 * Built-in ISO-8601 `DateTime` scalar matching `@nestjs/graphql` `GraphQLISODateTime`.
 */
export const GraphQLISODateTime: GraphQLScalarType<Date, string> =
  new GraphQLScalarType<Date, string>({
    name: "DateTime",
    description:
      "A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format.",
    parseValue(value: unknown): Date {
      return coerceDateTime(value);
    },
    serialize(value: unknown): string {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new GraphQLError(
            "DateTime cannot represent an invalid Date instance.",
          );
        }
        return value.toISOString();
      }
      if (typeof value === "string" || typeof value === "number") {
        return coerceDateTime(value).toISOString();
      }
      return null as unknown as string;
    },
    parseLiteral(ast): Date {
      if (ast.kind !== Kind.STRING) {
        throw new GraphQLError(
          `DateTime cannot represent non-string value: ${print(ast)}`,
          { nodes: ast },
        );
      }
      return coerceDateTime(ast.value);
    },
  });

function coerceTimestamp(value: unknown): Date {
  if (
    typeof value !== "number" &&
    typeof value !== "string" &&
    !(value instanceof Date)
  ) {
    throw new GraphQLError("Timestamp cannot represent non-numeric value.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GraphQLError("Timestamp cannot represent an invalid date value.");
  }
  return date;
}

/**
 * Built-in Unix epoch milliseconds `Timestamp` scalar matching `@nestjs/graphql` `GraphQLTimestamp`.
 */
export const GraphQLTimestamp: GraphQLScalarType<Date, number> =
  new GraphQLScalarType<Date, number>({
    name: "Timestamp",
    description:
      "`Date` type as integer. Type represents date and time as number of milliseconds from start of UNIX epoch.",
    serialize(value: unknown): number {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new GraphQLError(
            "Timestamp cannot represent an invalid Date instance.",
          );
        }
        return value.getTime();
      }
      if (typeof value === "number" || typeof value === "string") {
        return coerceTimestamp(value).getTime();
      }
      return null as unknown as number;
    },
    parseValue(value: unknown): Date {
      return coerceTimestamp(value);
    },
    parseLiteral(ast): Date {
      if (ast.kind === Kind.INT) {
        return coerceTimestamp(Number.parseInt(ast.value, 10));
      }
      if (ast.kind === Kind.STRING) {
        return coerceTimestamp(ast.value);
      }
      throw new GraphQLError(
        `Timestamp cannot represent non-numeric value: ${print(ast)}`,
        { nodes: ast },
      );
    },
  });

export {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLScalarType,
  GraphQLString,
};
