/**
 * GraphQL October 2021 Spec Introspection System
 * (__Schema, __Type, __TypeKind, __Field, __InputValue, __EnumValue, __Directive, __DirectiveLocation).
 * Zero external dependencies.
 */

import { DirectiveLocation } from "./ast";
import { print } from "./printer";
import { GraphQLBoolean, GraphQLString } from "./scalars";
import type { GraphQLSchema } from "./schema";
import {
  astFromValue,
  type GraphQLArgument,
  type GraphQLDirective,
  GraphQLEnumType,
  type GraphQLEnumValue,
  type GraphQLField,
  type GraphQLInputField,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLType,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNamedType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  isWrappingType,
} from "./types";

export const TypeKind = {
  SCALAR: "SCALAR",
  OBJECT: "OBJECT",
  INTERFACE: "INTERFACE",
  UNION: "UNION",
  ENUM: "ENUM",
  INPUT_OBJECT: "INPUT_OBJECT",
  LIST: "LIST",
  NON_NULL: "NON_NULL",
} as const;

export const __TypeKind: GraphQLEnumType = new GraphQLEnumType({
  name: "__TypeKind",
  description: "An enum describing what kind of type a given `__Type` is.",
  values: {
    SCALAR: {
      value: TypeKind.SCALAR,
      description: "Indicates this type is a scalar.",
    },
    OBJECT: {
      value: TypeKind.OBJECT,
      description:
        "Indicates this type is an object. `fields` and `interfaces` are valid fields.",
    },
    INTERFACE: {
      value: TypeKind.INTERFACE,
      description:
        "Indicates this type is an interface. `fields`, `interfaces`, and `possibleTypes` are valid fields.",
    },
    UNION: {
      value: TypeKind.UNION,
      description:
        "Indicates this type is a union. `possibleTypes` is a valid field.",
    },
    ENUM: {
      value: TypeKind.ENUM,
      description:
        "Indicates this type is an enum. `enumValues` is a valid field.",
    },
    INPUT_OBJECT: {
      value: TypeKind.INPUT_OBJECT,
      description:
        "Indicates this type is an input object. `inputFields` is a valid field.",
    },
    LIST: {
      value: TypeKind.LIST,
      description:
        "Indicates this type is a list. `ofType` is a valid field.",
    },
    NON_NULL: {
      value: TypeKind.NON_NULL,
      description:
        "Indicates this type is a non-null. `ofType` is a valid field.",
    },
  },
});

export const __DirectiveLocation: GraphQLEnumType = new GraphQLEnumType({
  name: "__DirectiveLocation",
  description:
    "A Directive can be adjacent to many parts of the GraphQL language, a __DirectiveLocation describes one such possible adjacencies.",
  values: {
    QUERY: { value: DirectiveLocation.QUERY },
    MUTATION: { value: DirectiveLocation.MUTATION },
    SUBSCRIPTION: { value: DirectiveLocation.SUBSCRIPTION },
    FIELD: { value: DirectiveLocation.FIELD },
    FRAGMENT_DEFINITION: { value: DirectiveLocation.FRAGMENT_DEFINITION },
    FRAGMENT_SPREAD: { value: DirectiveLocation.FRAGMENT_SPREAD },
    INLINE_FRAGMENT: { value: DirectiveLocation.INLINE_FRAGMENT },
    VARIABLE_DEFINITION: { value: DirectiveLocation.VARIABLE_DEFINITION },
    SCHEMA: { value: DirectiveLocation.SCHEMA },
    SCALAR: { value: DirectiveLocation.SCALAR },
    OBJECT: { value: DirectiveLocation.OBJECT },
    FIELD_DEFINITION: { value: DirectiveLocation.FIELD_DEFINITION },
    ARGUMENT_DEFINITION: { value: DirectiveLocation.ARGUMENT_DEFINITION },
    INTERFACE: { value: DirectiveLocation.INTERFACE },
    UNION: { value: DirectiveLocation.UNION },
    ENUM: { value: DirectiveLocation.ENUM },
    ENUM_VALUE: { value: DirectiveLocation.ENUM_VALUE },
    INPUT_OBJECT: { value: DirectiveLocation.INPUT_OBJECT },
    INPUT_FIELD_DEFINITION: { value: DirectiveLocation.INPUT_FIELD_DEFINITION },
  },
});

export const __InputValue: GraphQLObjectType<GraphQLArgument | GraphQLInputField> =
  new GraphQLObjectType({
    name: "__InputValue",
    description:
      "Arguments provided to Fields or Directives and the input fields of an InputObject are represented as Input Values which describe their type and optionally a default value.",
    fields: () => ({
      name: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (inputValue) => inputValue.name,
      },
      description: {
        type: GraphQLString,
        resolve: (inputValue) => inputValue.description ?? null,
      },
      type: {
        type: new GraphQLNonNull(__Type),
        resolve: (inputValue) => inputValue.type,
      },
      defaultValue: {
        type: GraphQLString,
        description:
          "A GraphQL-formatted string representing the default value for this input value.",
        resolve: (inputValue) => {
          const ast = astFromValue(inputValue.defaultValue, inputValue.type);
          return ast ? print(ast) : null;
        },
      },
      isDeprecated: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve: (inputValue) => inputValue.deprecationReason != null,
      },
      deprecationReason: {
        type: GraphQLString,
        resolve: (inputValue) => inputValue.deprecationReason ?? null,
      },
    }),
  });

export const __Field: GraphQLObjectType<GraphQLField<any, any>> =
  new GraphQLObjectType({
    name: "__Field",
    description:
      "Object and Interface types are described by a list of Fields, each of which has a name, potentially a list of arguments, and a return type.",
    fields: () => ({
      name: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (field) => field.name,
      },
      description: {
        type: GraphQLString,
        resolve: (field) => field.description ?? null,
      },
      args: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(__InputValue))),
        args: {
          includeDeprecated: {
            type: GraphQLBoolean,
            defaultValue: false,
          },
        },
        resolve: (field, { includeDeprecated }) =>
          includeDeprecated
            ? field.args
            : field.args.filter((arg) => arg.deprecationReason == null),
      },
      type: {
        type: new GraphQLNonNull(__Type),
        resolve: (field) => field.type,
      },
      isDeprecated: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve: (field) => field.deprecationReason != null,
      },
      deprecationReason: {
        type: GraphQLString,
        resolve: (field) => field.deprecationReason ?? null,
      },
    }),
  });

export const __EnumValue: GraphQLObjectType<GraphQLEnumValue> =
  new GraphQLObjectType({
    name: "__EnumValue",
    description:
      "One possible value for a given Enum. Enum values are unique values, not a placeholder for a string or numeric value. However an Enum value is returned in a JSON response as a string.",
    fields: () => ({
      name: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (enumValue) => enumValue.name,
      },
      description: {
        type: GraphQLString,
        resolve: (enumValue) => enumValue.description ?? null,
      },
      isDeprecated: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve: (enumValue) => enumValue.deprecationReason != null,
      },
      deprecationReason: {
        type: GraphQLString,
        resolve: (enumValue) => enumValue.deprecationReason ?? null,
      },
    }),
  });

export const __Directive: GraphQLObjectType<GraphQLDirective> =
  new GraphQLObjectType({
    name: "__Directive",
    description:
      "A Directive provides a way to describe alternate runtime execution and type validation behavior in a GraphQL document.",
    fields: () => ({
      name: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (directive) => directive.name,
      },
      description: {
        type: GraphQLString,
        resolve: (directive) => directive.description ?? null,
      },
      isRepeatable: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve: (directive) => directive.isRepeatable,
      },
      locations: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(__DirectiveLocation)),
        ),
        resolve: (directive) => directive.locations,
      },
      args: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(__InputValue))),
        args: {
          includeDeprecated: {
            type: GraphQLBoolean,
            defaultValue: false,
          },
        },
        resolve: (directive, { includeDeprecated }) =>
          includeDeprecated
            ? directive.args
            : directive.args.filter((arg) => arg.deprecationReason == null),
      },
    }),
  });

export const __Type: GraphQLObjectType<GraphQLType> = new GraphQLObjectType({
  name: "__Type",
  description:
    "The fundamental unit of any GraphQL Schema is the type. There are many kinds of types in GraphQL as represented by the `__TypeKind` enum.",
  fields: () => ({
    kind: {
      type: new GraphQLNonNull(__TypeKind),
      resolve(type) {
        if (isScalarType(type)) return TypeKind.SCALAR;
        if (isObjectType(type)) return TypeKind.OBJECT;
        if (isInterfaceType(type)) return TypeKind.INTERFACE;
        if (isUnionType(type)) return TypeKind.UNION;
        if (isEnumType(type)) return TypeKind.ENUM;
        if (isInputObjectType(type)) return TypeKind.INPUT_OBJECT;
        if (isListType(type)) return TypeKind.LIST;
        if (isNonNullType(type)) return TypeKind.NON_NULL;
        throw new Error(`Unexpected type: ${String(type)}`);
      },
    },
    name: {
      type: GraphQLString,
      resolve: (type) => (isNamedType(type) ? type.name : null),
    },
    description: {
      type: GraphQLString,
      resolve: (type) => (isNamedType(type) ? (type.description ?? null) : null),
    },
    specifiedByURL: {
      type: GraphQLString,
      resolve: (type) =>
        isScalarType(type) ? (type.specifiedByURL ?? null) : null,
    },
    isOneOf: {
      type: GraphQLBoolean,
      resolve: (type) => (isInputObjectType(type) ? type.isOneOf : null),
    },
    fields: {
      type: new GraphQLList(new GraphQLNonNull(__Field)),
      args: {
        includeDeprecated: {
          type: GraphQLBoolean,
          defaultValue: false,
        },
      },
      resolve(type, { includeDeprecated }) {
        if (isObjectType(type) || isInterfaceType(type)) {
          const fields = Object.values(type.getFields());
          return includeDeprecated
            ? fields
            : fields.filter((f) => f.deprecationReason == null);
        }
        return null;
      },
    },
    interfaces: {
      type: new GraphQLList(new GraphQLNonNull(__Type)),
      resolve(type) {
        if (isObjectType(type) || isInterfaceType(type)) {
          return type.getInterfaces();
        }
        return null;
      },
    },
    possibleTypes: {
      type: new GraphQLList(new GraphQLNonNull(__Type)),
      resolve(type, _args, _context, { schema }) {
        if (isAbstractType(type)) {
          return schema.getPossibleTypes(type);
        }
        return null;
      },
    },
    enumValues: {
      type: new GraphQLList(new GraphQLNonNull(__EnumValue)),
      args: {
        includeDeprecated: {
          type: GraphQLBoolean,
          defaultValue: false,
        },
      },
      resolve(type, { includeDeprecated }) {
        if (isEnumType(type)) {
          const values = type.getValues();
          return includeDeprecated
            ? values
            : values.filter((v) => v.deprecationReason == null);
        }
        return null;
      },
    },
    inputFields: {
      type: new GraphQLList(new GraphQLNonNull(__InputValue)),
      args: {
        includeDeprecated: {
          type: GraphQLBoolean,
          defaultValue: false,
        },
      },
      resolve(type, { includeDeprecated }) {
        if (isInputObjectType(type)) {
          const values = Object.values(type.getFields());
          return includeDeprecated
            ? values
            : values.filter((f) => f.deprecationReason == null);
        }
        return null;
      },
    },
    ofType: {
      type: __Type,
      resolve: (type) => (isWrappingType(type) ? type.ofType : null),
    },
  }),
});

export const __Schema: GraphQLObjectType<GraphQLSchema> = new GraphQLObjectType({
  name: "__Schema",
  description:
    "A GraphQL Schema defines the capabilities of a GraphQL server. It exposes all available types and directives on the server, as well as the entry points for query, mutation, and subscription operations.",
  fields: () => ({
    description: {
      type: GraphQLString,
      resolve: (schema) => schema.description ?? null,
    },
    types: {
      description: "A list of all types supported by this server.",
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(__Type))),
      resolve: (schema) => Object.values(schema.getTypeMap()),
    },
    queryType: {
      description: "The type that query operations will be rooted at.",
      type: new GraphQLNonNull(__Type),
      resolve: (schema) => schema.getQueryType(),
    },
    mutationType: {
      description:
        "If this server supports mutation, the type that mutation operations will be rooted at.",
      type: __Type,
      resolve: (schema) => schema.getMutationType() ?? null,
    },
    subscriptionType: {
      description:
        "If this server support subscription, the type that subscription operations will be rooted at.",
      type: __Type,
      resolve: (schema) => schema.getSubscriptionType() ?? null,
    },
    directives: {
      description: "A list of all directives supported by this server.",
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(__Directive)),
      ),
      resolve: (schema) => schema.getDirectives(),
    },
  }),
});

export const SchemaMetaFieldDef: GraphQLField<any, any> = {
  name: "__schema",
  type: new GraphQLNonNull(__Schema),
  description: "Access the current type schema of this server.",
  args: [],
  resolve: (_source, _args, _context, { schema }) => schema,
  deprecationReason: undefined,
  extensions: Object.create(null),
  astNode: undefined,
};

export const TypeMetaFieldDef: GraphQLField<any, any> = {
  name: "__type",
  type: __Type,
  description: "Request the type information of a single type.",
  args: [
    {
      name: "name",
      description: undefined,
      type: new GraphQLNonNull(GraphQLString),
      defaultValue: undefined,
      deprecationReason: undefined,
      extensions: Object.create(null),
      astNode: undefined,
    },
  ],
  resolve: (_source, { name }, _context, { schema }) =>
    schema.getType(name as string) ?? null,
  deprecationReason: undefined,
  extensions: Object.create(null),
  astNode: undefined,
};

export const TypeNameMetaFieldDef: GraphQLField<any, any> = {
  name: "__typename",
  type: new GraphQLNonNull(GraphQLString),
  description: "The name of the current Object type at runtime.",
  args: [],
  resolve: (_source, _args, _context, { parentType }) => parentType.name,
  deprecationReason: undefined,
  extensions: Object.create(null),
  astNode: undefined,
};

export const introspectionTypes: readonly GraphQLNamedType[] = Object.freeze([
  __Schema,
  __Directive,
  __DirectiveLocation,
  __Type,
  __Field,
  __InputValue,
  __EnumValue,
  __TypeKind,
]);

const introspectionTypeNames = new Set(introspectionTypes.map((t) => t.name));

export function isIntrospectionType(type: unknown): boolean {
  return isNamedType(type) && introspectionTypeNames.has(type.name);
}

// ---------------------------------------------------------------------------
// Introspection Query Builder & Response Types
// ---------------------------------------------------------------------------

export interface IntrospectionOptions {
  readonly descriptions?: boolean;
  readonly specifiedByUrl?: boolean;
  readonly directiveIsRepeatable?: boolean;
  readonly schemaDescription?: boolean;
  readonly inputValueDeprecation?: boolean;
  readonly oneOf?: boolean;
}

export interface IntrospectionNamedTypeRef<
  T extends IntrospectionType = IntrospectionType,
> {
  readonly kind: T["kind"];
  readonly name: string;
}

export interface IntrospectionListTypeRef<
  T extends IntrospectionTypeRef = IntrospectionTypeRef,
> {
  readonly kind: "LIST";
  readonly ofType: T;
}

export interface IntrospectionNonNullTypeRef<
  T extends IntrospectionTypeRef = IntrospectionTypeRef,
> {
  readonly kind: "NON_NULL";
  readonly ofType: T;
}

export type IntrospectionTypeRef =
  | IntrospectionNamedTypeRef
  | IntrospectionListTypeRef
  | IntrospectionNonNullTypeRef<
      IntrospectionNamedTypeRef | IntrospectionListTypeRef
    >;

export type IntrospectionOutputTypeRef =
  | IntrospectionNamedTypeRef<IntrospectionOutputType>
  | IntrospectionListTypeRef<IntrospectionOutputTypeRef>
  | IntrospectionNonNullTypeRef<
      | IntrospectionNamedTypeRef<IntrospectionOutputType>
      | IntrospectionListTypeRef<IntrospectionOutputTypeRef>
    >;

export type IntrospectionInputTypeRef =
  | IntrospectionNamedTypeRef<IntrospectionInputType>
  | IntrospectionListTypeRef<IntrospectionInputTypeRef>
  | IntrospectionNonNullTypeRef<
      | IntrospectionNamedTypeRef<IntrospectionInputType>
      | IntrospectionListTypeRef<IntrospectionInputTypeRef>
    >;

export interface IntrospectionInputValue {
  readonly name: string;
  readonly description?: string | null;
  readonly type: IntrospectionInputTypeRef;
  readonly defaultValue?: string | null;
  readonly isDeprecated?: boolean;
  readonly deprecationReason?: string | null;
}

export interface IntrospectionField {
  readonly name: string;
  readonly description?: string | null;
  readonly args: readonly IntrospectionInputValue[];
  readonly type: IntrospectionOutputTypeRef;
  readonly isDeprecated: boolean;
  readonly deprecationReason: string | null;
}

export interface IntrospectionEnumValue {
  readonly name: string;
  readonly description?: string | null;
  readonly isDeprecated: boolean;
  readonly deprecationReason: string | null;
}

export interface IntrospectionScalarType {
  readonly kind: "SCALAR";
  readonly name: string;
  readonly description?: string | null;
  readonly specifiedByURL?: string | null;
}

export interface IntrospectionObjectType {
  readonly kind: "OBJECT";
  readonly name: string;
  readonly description?: string | null;
  readonly fields: readonly IntrospectionField[];
  readonly interfaces: readonly IntrospectionNamedTypeRef<IntrospectionInterfaceType>[];
}

export interface IntrospectionInterfaceType {
  readonly kind: "INTERFACE";
  readonly name: string;
  readonly description?: string | null;
  readonly fields: readonly IntrospectionField[];
  readonly interfaces: readonly IntrospectionNamedTypeRef<IntrospectionInterfaceType>[];
  readonly possibleTypes: readonly IntrospectionNamedTypeRef<IntrospectionObjectType>[];
}

export interface IntrospectionUnionType {
  readonly kind: "UNION";
  readonly name: string;
  readonly description?: string | null;
  readonly possibleTypes: readonly IntrospectionNamedTypeRef<IntrospectionObjectType>[];
}

export interface IntrospectionEnumType {
  readonly kind: "ENUM";
  readonly name: string;
  readonly description?: string | null;
  readonly enumValues: readonly IntrospectionEnumValue[];
}

export interface IntrospectionInputObjectType {
  readonly kind: "INPUT_OBJECT";
  readonly name: string;
  readonly description?: string | null;
  readonly inputFields: readonly IntrospectionInputValue[];
  readonly isOneOf?: boolean;
}

export type IntrospectionOutputType =
  | IntrospectionScalarType
  | IntrospectionObjectType
  | IntrospectionInterfaceType
  | IntrospectionUnionType
  | IntrospectionEnumType;

export type IntrospectionInputType =
  | IntrospectionScalarType
  | IntrospectionEnumType
  | IntrospectionInputObjectType;

export type IntrospectionType =
  | IntrospectionScalarType
  | IntrospectionObjectType
  | IntrospectionInterfaceType
  | IntrospectionUnionType
  | IntrospectionEnumType
  | IntrospectionInputObjectType;

export interface IntrospectionDirective {
  readonly name: string;
  readonly description?: string | null;
  readonly isRepeatable?: boolean;
  readonly locations: readonly string[];
  readonly args: readonly IntrospectionInputValue[];
}

export interface IntrospectionSchema {
  readonly description?: string | null;
  readonly queryType: IntrospectionNamedTypeRef<IntrospectionObjectType>;
  readonly mutationType: IntrospectionNamedTypeRef<IntrospectionObjectType> | null;
  readonly subscriptionType: IntrospectionNamedTypeRef<IntrospectionObjectType> | null;
  readonly types: readonly IntrospectionType[];
  readonly directives: readonly IntrospectionDirective[];
}

export interface IntrospectionQuery {
  readonly __schema: IntrospectionSchema;
}

/**
 * Generates the standard GraphQL October 2021 Introspection query string.
 */
export function getIntrospectionQuery(options?: IntrospectionOptions): string {
  const descriptions = options?.descriptions ?? true;
  const specifiedByUrl = options?.specifiedByUrl ?? false;
  const directiveIsRepeatable = options?.directiveIsRepeatable ?? false;
  const schemaDescription = options?.schemaDescription ?? false;
  const inputValueDeprecation = options?.inputValueDeprecation ?? false;
  const oneOf = options?.oneOf ?? false;

  const desc = descriptions ? "description" : "";
  const specifiedBy = specifiedByUrl ? "specifiedByURL" : "";
  const repeatable = directiveIsRepeatable ? "isRepeatable" : "";
  const schemaDesc = schemaDescription ? "description" : "";
  const inputDeprecation = inputValueDeprecation
    ? "isDeprecated deprecationReason"
    : "";
  const inputDeprecationArg = inputValueDeprecation
    ? "(includeDeprecated: true)"
    : "";
  const isOneOf = oneOf ? "isOneOf" : "";

  return `
    query IntrospectionQuery {
      __schema {
        ${schemaDesc}
        queryType { name }
        mutationType { name }
        subscriptionType { name }
        types {
          ...FullType
        }
        directives {
          name
          ${desc}
          ${repeatable}
          locations
          args${inputDeprecationArg} {
            ...InputValue
          }
        }
      }
    }

    fragment FullType on __Type {
      kind
      name
      ${desc}
      ${specifiedBy}
      ${isOneOf}
      fields(includeDeprecated: true) {
        name
        ${desc}
        args${inputDeprecationArg} {
          ...InputValue
        }
        type {
          ...TypeRef
        }
        isDeprecated
        deprecationReason
      }
      inputFields${inputDeprecationArg} {
        ...InputValue
      }
      interfaces {
        ...TypeRef
      }
      enumValues(includeDeprecated: true) {
        name
        ${desc}
        isDeprecated
        deprecationReason
      }
      possibleTypes {
        ...TypeRef
      }
    }

    fragment InputValue on __InputValue {
      name
      ${desc}
      type { ...TypeRef }
      defaultValue
      ${inputDeprecation}
    }

    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
}
