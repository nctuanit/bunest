import {
  GraphQLDirective,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  type GraphQLType,
  GraphQLUnionType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isListType,
  isNonNullType,
  isObjectType,
  isUnionType,
} from "../engine";

function mapRecordValues<T, R>(
  object: Record<string, T>,
  callback: (val: T) => R,
): Record<string, R> {
  const result: Record<string, R> = Object.create(null);
  for (const [key, value] of Object.entries(object)) {
    result[key] = callback(value);
  }
  return result;
}

/**
 * Rebuilds a `GraphQLSchema` applying `transformType` to every non-introspection
 * named type (returning `null` removes the type; `undefined` preserves it).
 * Matches `@nestjs/graphql` `transformSchema`.
 */
export function transformSchema(
  schema: GraphQLSchema,
  transformType: (
    type: GraphQLNamedType,
  ) => GraphQLNamedType | null | undefined,
): GraphQLSchema {
  const typeMap: Record<string, GraphQLNamedType> = Object.create(null);

  for (const oldType of Object.values(schema.getTypeMap())) {
    if (isIntrospectionType(oldType)) {
      continue;
    }
    const result = transformType(oldType);
    if (result === null) {
      continue;
    }
    const newType = result ?? oldType;
    typeMap[newType.name] = recreateNamedType(newType);
  }

  const schemaConfig = schema.toConfig();
  return new GraphQLSchema({
    ...schemaConfig,
    types: Object.values(typeMap),
    query: replaceMaybeType(schemaConfig.query) as
      GraphQLObjectType | undefined,
    mutation: replaceMaybeType(schemaConfig.mutation) as
      GraphQLObjectType | undefined,
    subscription: replaceMaybeType(schemaConfig.subscription) as
      GraphQLObjectType | undefined,
    directives: replaceDirectives([...schemaConfig.directives]),
  });

  function recreateNamedType(type: GraphQLNamedType): GraphQLNamedType {
    if (isObjectType(type)) {
      const config = type.toConfig();
      const objectType = new GraphQLObjectType({
        ...config,
        interfaces: () =>
          config.interfaces.map(
            (iface) => replaceNamedType(iface) as GraphQLInterfaceType,
          ),
        fields: () => replaceFields(config.fields),
      });
      const apolloExt = (
        type.extensions as
          { apollo?: { subgraph?: { resolveReference?: unknown } } } | undefined
      )?.apollo;
      if (apolloExt?.subgraph?.resolveReference) {
        const objApollo = (
          objectType.extensions as
            { apollo?: { subgraph?: Record<string, unknown> } } | undefined
        )?.apollo;
        objectType.extensions = {
          ...objectType.extensions,
          apollo: {
            ...objApollo,
            subgraph: {
              ...objApollo?.subgraph,
              resolveReference: apolloExt.subgraph.resolveReference,
            },
          },
        };
      }
      return objectType;
    }

    if (isInterfaceType(type)) {
      const config = type.toConfig();
      return new GraphQLInterfaceType({
        ...config,
        interfaces: () =>
          config.interfaces.map(
            (iface) => replaceNamedType(iface) as GraphQLInterfaceType,
          ),
        fields: () => replaceFields(config.fields),
      });
    }

    if (isUnionType(type)) {
      const config = type.toConfig();
      return new GraphQLUnionType({
        ...config,
        types: () =>
          config.types.map(
            (member) => replaceNamedType(member) as GraphQLObjectType,
          ),
      });
    }

    if (isInputObjectType(type)) {
      const config = type.toConfig();
      return new GraphQLInputObjectType({
        ...config,
        fields: () => replaceInputFields(config.fields),
      });
    }

    return type;
  }

  function replaceType(type: GraphQLType): GraphQLType {
    if (isListType(type)) {
      return new GraphQLList(replaceType(type.ofType));
    }
    if (isNonNullType(type)) {
      return new GraphQLNonNull(
        replaceType(type.ofType) as Exclude<GraphQLType, GraphQLNonNull<any>>,
      );
    }
    return replaceNamedType(type);
  }

  function replaceNamedType(type: GraphQLNamedType): GraphQLNamedType {
    return typeMap[type.name] ?? type;
  }

  function replaceMaybeType(
    type: GraphQLNamedType | null | undefined,
  ): GraphQLNamedType | undefined {
    return type ? replaceNamedType(type) : undefined;
  }

  function replaceFields(
    fieldsMap: GraphQLFieldConfigMap<any, any>,
  ): GraphQLFieldConfigMap<any, any> {
    return mapRecordValues(fieldsMap, (field) => ({
      ...field,
      type: replaceType(field.type) as typeof field.type,
      args: field.args ? replaceArgs(field.args) : undefined,
    }));
  }

  function replaceInputFields(
    fieldsMap: GraphQLInputFieldConfigMap,
  ): GraphQLInputFieldConfigMap {
    return mapRecordValues(fieldsMap, (field) => ({
      ...field,
      type: replaceType(field.type) as typeof field.type,
    }));
  }

  function replaceArgs(
    args: GraphQLFieldConfigArgumentMap,
  ): GraphQLFieldConfigArgumentMap {
    return mapRecordValues(args, (arg) => ({
      ...arg,
      type: replaceType(arg.type) as typeof arg.type,
    }));
  }

  function replaceDirectives(
    directives: readonly GraphQLDirective[],
  ): GraphQLDirective[] {
    return directives.map((directive) => {
      const config = directive.toConfig();
      return new GraphQLDirective({
        ...config,
        args: replaceArgs(config.args),
      });
    });
  }
}
