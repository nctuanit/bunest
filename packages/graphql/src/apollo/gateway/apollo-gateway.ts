import { toArray } from "@bunest/core/common";
import {
  type ArgumentNode,
  buildASTSchema,
  type ConstDirectiveNode,
  type DefinitionNode,
  type DirectiveNode,
  type DocumentNode,
  execute,
  type FieldDefinitionNode,
  type FieldNode,
  GraphQLError,
  type GraphQLFormattedError,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLSchema,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  type NamedTypeNode,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type OperationDefinitionNode,
  parse,
  print,
  type SelectionNode,
  type SelectionSetNode,
  type ValueNode,
} from "../../engine";
import type {
  BaseContext,
  GatewayExecutor,
  GatewayInterface,
  GatewayLoadResult,
  GatewaySchemaLoadContext,
  GatewaySchemaLoadOrUpdateCallback,
  GraphQLRequestContext,
} from "../server/apollo-server.types";
import {
  type FetcherFn,
  type GraphQLDataSource,
  RemoteGraphQLDataSource,
} from "./graphql-data-source";
import {
  IntrospectAndCompose,
  type ServiceEndpointDefinition,
  type SubgraphSdlEntry,
  type SupergraphManager,
} from "./introspect-and-compose";

export interface GatewayConfig {
  supergraphSdl?: string | SupergraphManager;
  serviceList?: ServiceEndpointDefinition[];
  buildService?: (definition: ServiceEndpointDefinition) => GraphQLDataSource;
  fetcher?: FetcherFn;
  pollIntervalInMs?: number;
  debug?: boolean;
  serviceHealthCheck?: boolean;
  introspectionHeaders?: Record<string, string>;
}

const FEDERATION_INTERNAL_TYPES = new Set([
  "_Any",
  "_Entity",
  "_FieldSet",
  "_Service",
  "FieldSet",
  "link__Import",
  "link__Purpose",
  "join__Graph",
  "join__FieldSet",
]);

const FEDERATION_INTERNAL_FIELDS = new Set(["_service", "_entities"]);

const FEDERATION_DIRECTIVES = new Set([
  "key",
  "external",
  "requires",
  "provides",
  "extends",
  "shareable",
  "inaccessible",
  "override",
  "tag",
  "composeDirective",
  "interfaceObject",
  "link",
  "join__type",
  "join__field",
  "join__graph",
  "join__enumValue",
  "join__implements",
  "join__unionMember",
]);

interface EntityOwnership {
  readonly keyFieldsBySubgraph: Map<string, string[]>;
  readonly fieldOwners: Map<string, string>;
}

interface ComposedGatewayModel {
  readonly schema: GraphQLSchema;
  readonly supergraphSdl: string;
  readonly queryFieldOwners: Map<string, string>;
  readonly mutationFieldOwners: Map<string, string>;
  readonly entities: Map<string, EntityOwnership>;
}

function stripFederationDirectives<
  T extends {
    readonly directives?: readonly (DirectiveNode | ConstDirectiveNode)[];
  },
>(node: T): T {
  if (!node.directives || node.directives.length === 0) {
    return node;
  }
  const filtered = node.directives.filter(
    (d) => !FEDERATION_DIRECTIVES.has(d.name?.value),
  );
  return { ...node, directives: filtered };
}

function extractKeyFields(
  node: ObjectTypeDefinitionNode | ObjectTypeExtensionNode,
): string[] {
  const keys: string[] = [];
  for (const dir of node.directives ?? []) {
    if (dir.name.value === "key") {
      const fieldsArg = dir.arguments?.find(
        (a: ArgumentNode) => a.name.value === "fields",
      );
      if (fieldsArg && fieldsArg.value.kind === Kind.STRING) {
        for (const token of fieldsArg.value.value.split(/\s+/)) {
          const clean = token.trim();
          if (clean && !clean.includes("{") && !clean.includes("}")) {
            keys.push(clean);
          }
        }
      }
    }
  }
  return keys;
}

function isExternalField(field: FieldDefinitionNode): boolean {
  return Boolean(field.directives?.some((d) => d.name.value === "external"));
}

function composeSubgraphs(entries: SubgraphSdlEntry[]): ComposedGatewayModel {
  const objectFields = new Map<string, Map<string, FieldDefinitionNode>>();
  const objectInterfaces = new Map<string, Map<string, NamedTypeNode>>();
  const otherDefinitions = new Map<string, DefinitionNode>();
  const queryFieldOwners = new Map<string, string>();
  const mutationFieldOwners = new Map<string, string>();
  const entities = new Map<string, EntityOwnership>();

  const ensureObject = (name: string) => {
    let fields = objectFields.get(name);
    if (!fields) {
      fields = new Map();
      objectFields.set(name, fields);
    }
    let ifaces = objectInterfaces.get(name);
    if (!ifaces) {
      ifaces = new Map();
      objectInterfaces.set(name, ifaces);
    }
    return { fields, ifaces };
  };

  for (const entry of entries) {
    const doc = parse(entry.sdl);
    for (const def of doc.definitions) {
      if (
        def.kind === Kind.SCHEMA_DEFINITION ||
        def.kind === Kind.SCHEMA_EXTENSION ||
        def.kind === Kind.DIRECTIVE_DEFINITION
      ) {
        continue;
      }
      if (
        "name" in def &&
        def.name &&
        FEDERATION_INTERNAL_TYPES.has(def.name.value)
      ) {
        continue;
      }

      if (
        def.kind === Kind.OBJECT_TYPE_DEFINITION ||
        def.kind === Kind.OBJECT_TYPE_EXTENSION
      ) {
        const typeName = def.name.value;
        const { fields, ifaces } = ensureObject(typeName);
        for (const iface of def.interfaces ?? []) {
          ifaces.set(iface.name.value, iface);
        }

        const keyFields = extractKeyFields(def);
        if (keyFields.length > 0) {
          let ent = entities.get(typeName);
          if (!ent) {
            ent = {
              keyFieldsBySubgraph: new Map(),
              fieldOwners: new Map(),
            };
            entities.set(typeName, ent);
          }
          ent.keyFieldsBySubgraph.set(entry.name, keyFields);
        }

        for (const f of def.fields ?? []) {
          const fname = f.name.value;
          if (
            (typeName === "Query" || typeName === "Mutation") &&
            FEDERATION_INTERNAL_FIELDS.has(fname)
          ) {
            continue;
          }
          const cleanField = stripFederationDirectives(f);
          if (!fields.has(fname) || !isExternalField(f)) {
            fields.set(fname, cleanField);
          }
          if (typeName === "Query" && !queryFieldOwners.has(fname)) {
            queryFieldOwners.set(fname, entry.name);
          } else if (
            typeName === "Mutation" &&
            !mutationFieldOwners.has(fname)
          ) {
            mutationFieldOwners.set(fname, entry.name);
          } else if (!isExternalField(f)) {
            const ent = entities.get(typeName);
            if (ent && !ent.fieldOwners.has(fname)) {
              ent.fieldOwners.set(fname, entry.name);
            }
          }
        }
        continue;
      }

      if ("name" in def && def.name) {
        const key = `${def.kind}:${def.name.value}`;
        if (!otherDefinitions.has(key)) {
          otherDefinitions.set(
            key,
            "directives" in def ? stripFederationDirectives(def) : def,
          );
        }
      }
    }
  }

  const finalDefs: DefinitionNode[] = [...otherDefinitions.values()];
  for (const [typeName, fieldsMap] of objectFields.entries()) {
    if (fieldsMap.size === 0) continue;
    const ifaces = [...(objectInterfaces.get(typeName)?.values() ?? [])];
    const objDef: ObjectTypeDefinitionNode = {
      kind: Kind.OBJECT_TYPE_DEFINITION,
      name: { kind: Kind.NAME, value: typeName },
      interfaces: ifaces,
      directives: [],
      fields: [...fieldsMap.values()],
    };
    finalDefs.push(objDef);
  }

  const composedDoc: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: finalDefs,
  };
  const schema = buildASTSchema(composedDoc, { assumeValidSDL: true });
  return {
    schema,
    supergraphSdl: print(composedDoc),
    queryFieldOwners,
    mutationFieldOwners,
    entities,
  };
}

function collectUsedVariables(
  selections: readonly SelectionNode[],
  used: Set<string>,
): void {
  const visitValue = (val: ValueNode | undefined) => {
    if (!val) return;
    if (val.kind === Kind.VARIABLE) {
      used.add(val.name.value);
    } else if (val.kind === Kind.LIST) {
      for (const item of val.values) visitValue(item);
    } else if (val.kind === Kind.OBJECT) {
      for (const field of val.fields) visitValue(field.value);
    }
  };
  for (const sel of selections) {
    if (sel.kind === Kind.FIELD) {
      for (const arg of sel.arguments ?? []) {
        visitValue(arg.value);
      }
      if (sel.selectionSet) {
        collectUsedVariables(sel.selectionSet.selections, used);
      }
    } else if (sel.kind === Kind.INLINE_FRAGMENT && sel.selectionSet) {
      collectUsedVariables(sel.selectionSet.selections, used);
    }
  }
}

function unwrapNamedType(type: GraphQLOutputType): GraphQLNamedType {
  let cur: GraphQLOutputType = type;
  while (isNonNullType(cur) || isListType(cur)) {
    cur = cur.ofType;
  }
  return cur;
}

function getSelectionResponseKey(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}

function splitSelectionsForEntity(
  selectionSet: SelectionSetNode,
  owningSubgraph: string,
  entity: EntityOwnership,
): {
  localSelections: FieldNode[];
  remoteBySubgraph: Map<string, FieldNode[]>;
  requiredKeys: Set<string>;
} {
  const localSelections: FieldNode[] = [];
  const remoteBySubgraph = new Map<string, FieldNode[]>();
  const requiredKeys = new Set<string>();

  for (const sel of selectionSet.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    const fname = sel.name.value;
    if (fname === "__typename") {
      localSelections.push(sel);
      continue;
    }
    const fieldOwner = entity.fieldOwners.get(fname) ?? owningSubgraph;
    if (fieldOwner === owningSubgraph) {
      localSelections.push(sel);
    } else {
      let bucket = remoteBySubgraph.get(fieldOwner);
      if (!bucket) {
        bucket = [];
        remoteBySubgraph.set(fieldOwner, bucket);
      }
      bucket.push(sel);
      const keys =
        entity.keyFieldsBySubgraph.get(fieldOwner) ??
        entity.keyFieldsBySubgraph.get(owningSubgraph) ??
        [];
      for (const k of keys) requiredKeys.add(k);
    }
  }

  return { localSelections, remoteBySubgraph, requiredKeys };
}

/**
 * Bun-native Apollo Federation Gateway composing multiple subgraphs (via `supergraphSdl`,
 * `IntrospectAndCompose`, or `serviceList`) and executing federated queries/mutations
 * with cross-subgraph `_entities` resolution over native `fetch()`.
 */
export class ApolloGateway implements GatewayInterface {
  private readonly config: GatewayConfig;
  private readonly dataSources = new Map<string, GraphQLDataSource>();
  private readonly listeners = new Set<GatewaySchemaLoadOrUpdateCallback>();
  private composedModel?: ComposedGatewayModel;
  private supergraphCleanup?: () => Promise<void> | void;

  constructor(config: GatewayConfig = {}) {
    this.config = config;
  }

  private getOrCreateDataSource(
    def: ServiceEndpointDefinition,
  ): GraphQLDataSource {
    let ds = this.dataSources.get(def.name);
    if (!ds) {
      if (this.config.buildService) {
        ds = this.config.buildService(def);
      } else {
        if (!def.url) {
          throw new Error(
            `Subgraph "${def.name}" requires a "url" or custom "buildService" factory.`,
          );
        }
        ds = new RemoteGraphQLDataSource({
          url: def.url,
          fetcher: this.config.fetcher,
        });
      }
      this.dataSources.set(def.name, ds);
    }
    return ds;
  }

  onSchemaLoadOrUpdate(
    callback: GatewaySchemaLoadOrUpdateCallback,
  ): () => void {
    this.listeners.add(callback);
    if (this.composedModel) {
      callback({
        apiSchema: this.composedModel.schema,
        coreSupergraphSdl: this.composedModel.supergraphSdl,
      });
    }
    return () => {
      this.listeners.delete(callback);
    };
  }

  private emitSchemaUpdate(model: ComposedGatewayModel): void {
    this.composedModel = model;
    const ctx: GatewaySchemaLoadContext = {
      apiSchema: model.schema,
      coreSupergraphSdl: model.supergraphSdl,
    };
    for (const cb of [...this.listeners]) {
      cb(ctx);
    }
  }

  async load(): Promise<GatewayLoadResult> {
    let entries: SubgraphSdlEntry[] = [];

    if (typeof this.config.supergraphSdl === "string") {
      entries = [{ name: "supergraph", sdl: this.config.supergraphSdl }];
    } else if (
      this.config.supergraphSdl &&
      typeof this.config.supergraphSdl.initialize === "function"
    ) {
      const initResult = await this.config.supergraphSdl.initialize({
        getDataSource: (def) => this.getOrCreateDataSource(def),
        update: (newSdl: string) => {
          const updated = composeSubgraphs([
            { name: "supergraph", sdl: newSdl },
          ]);
          this.emitSchemaUpdate(updated);
        },
      });
      this.supergraphCleanup = initResult.cleanup;
      entries =
        initResult.subgraphs && initResult.subgraphs.length > 0
          ? initResult.subgraphs
          : [{ name: "supergraph", sdl: initResult.supergraphSdl }];
    } else if (this.config.serviceList && this.config.serviceList.length > 0) {
      const introspector = new IntrospectAndCompose({
        subgraphs: this.config.serviceList,
        introspectionHeaders: this.config.introspectionHeaders,
        fetcher: this.config.fetcher,
      });
      entries = await introspector.loadSubgraphSdls((def) =>
        this.getOrCreateDataSource(def),
      );
    } else {
      throw new Error(
        "ApolloGateway requires `supergraphSdl` or a non-empty `serviceList`.",
      );
    }

    const model = composeSubgraphs(entries);
    this.emitSchemaUpdate(model);

    return {
      schema: model.schema,
      executor: this.createExecutor(),
    };
  }

  async stop(): Promise<void> {
    if (this.supergraphCleanup) {
      await this.supergraphCleanup();
      this.supergraphCleanup = undefined;
    }
    this.listeners.clear();
  }

  private createExecutor(): GatewayExecutor {
    return async (requestContext: GraphQLRequestContext<BaseContext>) => {
      const model = this.composedModel;
      if (!model) {
        return {
          errors: [new GraphQLError("ApolloGateway has not been loaded.")],
        };
      }

      const document = requestContext.document;
      const operation = requestContext.operation;
      if (!document || !operation) {
        return {
          errors: [new GraphQLError("Unable to resolve GraphQL operation.")],
        };
      }

      // If no remote data sources (e.g. static supergraphSdl-only schema), run directly against schema
      if (this.dataSources.size === 0) {
        return await execute({
          schema: model.schema,
          document,
          variableValues: requestContext.request.variables,
          operationName: requestContext.request.operationName,
          contextValue: requestContext.contextValue,
        });
      }

      return await this.executeFederatedOperation(
        model,
        document,
        operation,
        requestContext,
      );
    };
  }

  private async executeFederatedOperation(
    model: ComposedGatewayModel,
    document: DocumentNode,
    operation: OperationDefinitionNode,
    requestContext: GraphQLRequestContext<BaseContext>,
  ): Promise<{
    data?: Record<string, unknown> | null;
    errors?: readonly (GraphQLError | GraphQLFormattedError)[];
  }> {
    const ownerMap =
      operation.operation === "mutation"
        ? model.mutationFieldOwners
        : model.queryFieldOwners;

    const rootType =
      operation.operation === "mutation"
        ? model.schema.getMutationType()
        : model.schema.getQueryType();

    // Group root selections by owning subgraph (plus handle introspection locally)
    const introspectionSelections: SelectionNode[] = [];
    const perSubgraphSelections = new Map<
      string,
      Array<{
        originalField: FieldNode;
        rewrittenField: FieldNode;
        entityName?: string;
        remoteBySubgraph?: Map<string, FieldNode[]>;
        addedKeyFields?: Set<string>;
      }>
    >();

    for (const sel of operation.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) continue;
      const fieldName = sel.name.value;
      if (fieldName.startsWith("__")) {
        introspectionSelections.push(sel);
        continue;
      }

      const owner = ownerMap.get(fieldName);
      if (!owner) {
        return {
          data: null,
          errors: [
            new GraphQLError(
              `No subgraph owns ${operation.operation} field "${fieldName}".`,
            ),
          ],
        };
      }

      let rewrittenField = sel;
      let entityName: string | undefined;
      let remoteBySubgraph: Map<string, FieldNode[]> | undefined;
      let addedKeyFields: Set<string> | undefined;

      const rootFieldDef = rootType?.getFields()[fieldName];
      const returnType = rootFieldDef
        ? unwrapNamedType(rootFieldDef.type)
        : undefined;

      if (
        returnType &&
        isObjectType(returnType) &&
        sel.selectionSet &&
        model.entities.has(returnType.name)
      ) {
        const entity = model.entities.get(returnType.name)!;
        const split = splitSelectionsForEntity(sel.selectionSet, owner, entity);
        if (split.remoteBySubgraph.size > 0) {
          entityName = returnType.name;
          remoteBySubgraph = split.remoteBySubgraph;
          const existingFieldNames = new Set(
            split.localSelections.map((f) => f.name.value),
          );
          addedKeyFields = new Set<string>();
          const augmentedLocal: FieldNode[] = [...split.localSelections];
          for (const keyField of split.requiredKeys) {
            if (!existingFieldNames.has(keyField)) {
              addedKeyFields.add(keyField);
              augmentedLocal.push({
                kind: Kind.FIELD,
                name: { kind: Kind.NAME, value: keyField },
              });
            }
          }
          rewrittenField = {
            ...sel,
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: augmentedLocal,
            },
          };
        }
      }

      let list = perSubgraphSelections.get(owner);
      if (!list) {
        list = [];
        perSubgraphSelections.set(owner, list);
      }
      list.push({
        originalField: sel,
        rewrittenField,
        entityName,
        remoteBySubgraph,
        addedKeyFields,
      });
    }

    const mergedData: Record<string, unknown> = {};
    const mergedErrors: (GraphQLError | GraphQLFormattedError)[] = [];

    // Execute introspection fields locally against the composed schema
    if (introspectionSelections.length > 0) {
      const introDoc: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: [
          {
            ...operation,
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: introspectionSelections,
            },
          },
          ...document.definitions.filter(
            (d) => d.kind === Kind.FRAGMENT_DEFINITION,
          ),
        ],
      };
      const introRes = await execute({
        schema: model.schema,
        document: introDoc,
        variableValues: requestContext.request.variables,
        contextValue: requestContext.contextValue,
      });
      if (introRes.data) Object.assign(mergedData, introRes.data);
      if (introRes.errors) mergedErrors.push(...introRes.errors);
    }

    // Dispatch root selections to each owning subgraph in parallel
    const fragments = document.definitions.filter(
      (d) => d.kind === Kind.FRAGMENT_DEFINITION,
    );
    const allVariables = requestContext.request.variables ?? {};

    await Promise.all(
      [...perSubgraphSelections.entries()].map(
        async ([subgraphName, plans]) => {
          const ds = this.dataSources.get(subgraphName);
          if (!ds) {
            mergedErrors.push(
              new GraphQLError(
                `Data source for subgraph "${subgraphName}" not found.`,
              ),
            );
            return;
          }

          const subSelections = plans.map((p) => p.rewrittenField);
          const usedVars = new Set<string>();
          collectUsedVariables(subSelections, usedVars);

          const subVarDefs = (operation.variableDefinitions ?? []).filter(
            (vd) => usedVars.has(vd.variable.name.value),
          );
          const subVars: Record<string, unknown> = {};
          for (const name of usedVars) {
            if (name in allVariables) {
              subVars[name] = allVariables[name];
            }
          }

          const subDoc: DocumentNode = {
            kind: Kind.DOCUMENT,
            definitions: [
              {
                ...operation,
                variableDefinitions: subVarDefs,
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  selections: subSelections,
                },
              },
              ...fragments,
            ],
          };

          const subRes = await ds.process({
            request: {
              query: print(subDoc),
              variables: Object.keys(subVars).length > 0 ? subVars : undefined,
              operationName: operation.name?.value,
              http: requestContext.request.http,
            },
            context: requestContext.contextValue,
            kind: "incoming operation",
          });

          if (subRes.errors) {
            mergedErrors.push(...subRes.errors);
          }
          if (!subRes.data) {
            return;
          }

          for (const plan of plans) {
            const respKey = getSelectionResponseKey(plan.originalField);
            const rawVal = subRes.data[respKey];
            mergedData[respKey] = rawVal;

            // Resolve cross-subgraph entity extensions via `_entities`!
            if (
              plan.entityName &&
              plan.remoteBySubgraph &&
              plan.remoteBySubgraph.size > 0 &&
              rawVal !== null &&
              rawVal !== undefined
            ) {
              const items = toArray(rawVal).filter(
                (x): x is Record<string, unknown> =>
                  x !== null && typeof x === "object",
              );

              if (items.length > 0) {
                const entity = model.entities.get(plan.entityName)!;
                for (const [
                  remoteSubgraph,
                  remoteFields,
                ] of plan.remoteBySubgraph.entries()) {
                  const remoteDs = this.dataSources.get(remoteSubgraph);
                  if (!remoteDs) continue;
                  const keys = entity.keyFieldsBySubgraph.get(remoteSubgraph) ??
                    entity.keyFieldsBySubgraph.get(subgraphName) ?? ["id"];

                  const representations = items.map((item) => {
                    const rep: Record<string, unknown> = {
                      __typename: plan.entityName,
                    };
                    for (const k of keys) {
                      rep[k] = item[k];
                    }
                    return rep;
                  });

                  const remoteFieldsSdl = remoteFields
                    .map((f) => print(f))
                    .join(" ");
                  const entitiesQuery = `query ($representations: [_Any!]!) { _entities(representations: $representations) { ... on ${plan.entityName} { ${remoteFieldsSdl} } } }`;

                  const entRes = await remoteDs.process({
                    request: {
                      query: entitiesQuery,
                      variables: { representations },
                      http: requestContext.request.http,
                    },
                    context: requestContext.contextValue,
                    kind: "incoming operation",
                  });

                  if (entRes.errors) {
                    mergedErrors.push(...entRes.errors);
                  }
                  const resolvedEntities = (
                    entRes.data as
                      | { _entities?: Array<Record<string, unknown> | null> }
                      | undefined
                  )?._entities;
                  if (Array.isArray(resolvedEntities)) {
                    for (let i = 0; i < items.length; i++) {
                      const ext = resolvedEntities[i];
                      if (ext && typeof ext === "object") {
                        Object.assign(items[i]!, ext);
                      }
                    }
                  }
                }

                // Clean up synthetic key fields that were not requested by the client
                if (plan.addedKeyFields && plan.addedKeyFields.size > 0) {
                  for (const item of items) {
                    for (const syntheticKey of plan.addedKeyFields) {
                      delete item[syntheticKey];
                    }
                  }
                }
              }
            }
          }
        },
      ),
    );

    return {
      data: mergedData,
      ...(mergedErrors.length > 0 ? { errors: mergedErrors } : {}),
    };
  }
}

export type { TypeNode } from "../../engine";
