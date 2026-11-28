import { cond } from "@bunest/core/common";
import {
  Node,
  SyntaxKind,
  type Decorator,
  type Expression,
} from "../ast";
import { sanitizeTypeText } from "../typegen/emitter";
import type {
  ExtractedBaseEntityField,
  ExtractedImportRef,
} from "../typegen/types";

// ============================================================================
// Unified Built-In Decorator Specification Registry (Single Source of Truth)
// ============================================================================

export type BuiltinDecoratorCategory =
  | "class-macro"
  | "field-macro"
  | "orm-entity"
  | "orm-column"
  | "orm-relation"
  | "orm-repository"
  | "di"
  | "aop";

export type DecoratorTargetKind = "class" | "property" | "method" | "parameter";

export interface BuiltinDecoratorSpec {
  readonly name: string;
  readonly category: BuiltinDecoratorCategory;
  readonly targets: readonly DecoratorTargetKind[];
  /** True when the decorator is a built-in Class Macro (or macro-aware like `@BaseEntity`). */
  readonly isClassMacro?: boolean;
  /** True when the decorator is a built-in Property/Field Macro (`@Secret`, `@Singular`, etc.). */
  readonly isFieldMacro?: boolean;
  /** True when `createBunestPlugin()` Stage 1 should auto-register AST-discovered class fields. */
  readonly needsMacroFieldRegistration?: boolean;
  /** True when the decorator marks an ORM / unified Entity class (`@Entity`, `@BaseEntity`). */
  readonly isEntity?: boolean;
  /** True when the decorator declares an ORM column (`@Column`, `@CreateDateColumn`, etc.). */
  readonly isColumn?: boolean;
  /** True when the decorator declares a primary key column (`@PrimaryColumn`, `@PrimaryGeneratedColumn`, etc.). */
  readonly isPrimaryColumn?: boolean;
  /** True when the decorator declares a relation or embedded nested class (`@ManyToOne`, `@Embedded`, etc.). */
  readonly isRelation?: boolean;
  /** True when the decorator marks a declarative ORM repository class. */
  readonly isRepository?: boolean;
  /** True when the decorator marks a DI-managed container class (eligible for AOP weaving). */
  readonly isDiManaged?: boolean;
  /** True when the decorator is a Service-Layer AOP decorator requiring a DI-managed host class. */
  readonly isServiceAop?: boolean;
  readonly description?: string;
}

const RAW_BUILTIN_SPECS: readonly BuiltinDecoratorSpec[] = [
  // ---- Built-In Class Macros ----
  {
    name: "Data",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates getters, setters, of/from/with/clone, equals/hashCode, toString, and toJSON/fromJSON.",
  },
  {
    name: "Value",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Immutable value object macro (getters, of/from/with/clone, equals/hashCode, toString, toJSON, Object.freeze).",
  },
  {
    name: "Builder",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates fluent static Class.builder()...build() builder.",
  },
  {
    name: "SuperBuilder",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Inheritance-aware fluent builder.",
  },
  {
    name: "Getter",
    category: "class-macro",
    targets: ["class", "property"],
    isClassMacro: true,
    isFieldMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates getter methods on class fields or a single property.",
  },
  {
    name: "Setter",
    category: "class-macro",
    targets: ["class", "property"],
    isClassMacro: true,
    isFieldMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates chainable setter methods on class fields or a single property.",
  },
  {
    name: "Accessors",
    category: "class-macro",
    targets: ["class", "property"],
    isClassMacro: true,
    isFieldMacro: true,
    description: "Configures fluent/chain/prefix conventions for generated accessors.",
  },
  {
    name: "With",
    category: "class-macro",
    targets: ["class", "property"],
    isClassMacro: true,
    isFieldMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates immutable with(patch) and per-field withField(value) copy methods.",
  },
  {
    name: "WithBy",
    category: "class-macro",
    targets: ["class", "property"],
    isClassMacro: true,
    isFieldMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates functional immutable copy methods withFieldBy(fn).",
  },
  {
    name: "ToString",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates structured toString() honoring @Secret and include/exclude options.",
  },
  {
    name: "EqualsAndHashCode",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates structural equals() and deterministic FNV-1a hashCode().",
  },
  {
    name: "FieldNameConstants",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates static Class.Fields constants.",
  },
  {
    name: "JsonSerializable",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Generates toJSON() and static fromJSON().",
  },
  {
    name: "WithLogger",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    description: "Attaches a lazy non-enumerable readonly logger: Logger property.",
  },
  {
    name: "StandardException",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    description: "Standardizes Error subclasses with prototype fix, code, statusCode, and static from().",
  },
  {
    name: "UtilityClass",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    description: "Marks a helper class as static-only (new throws TypeError).",
  },
  {
    name: "FieldDefaults",
    category: "class-macro",
    targets: ["class"],
    isClassMacro: true,
    description: "Applies default readonly/modifier behavior to class fields.",
  },

  // ---- Built-In Field-Only Macros ----
  { name: "Secret", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "Singular", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "NonNull", category: "field-macro", targets: ["property", "parameter"], isFieldMacro: true },
  { name: "NonFinal", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "Delegate", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "Builder.Default", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "Builder.ObtainVia", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "ToString.Include", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "ToString.Exclude", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "EqualsAndHashCode.Include", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "EqualsAndHashCode.Exclude", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "FieldNameConstants.Include", category: "field-macro", targets: ["property"], isFieldMacro: true },
  { name: "FieldNameConstants.Exclude", category: "field-macro", targets: ["property"], isFieldMacro: true },

  // ---- ORM Entity & Column Decorators ----
  {
    name: "Entity",
    category: "orm-entity",
    targets: ["class"],
    isEntity: true,
    description: "Declares an ORM / unified entity schema mapped to a database table.",
  },
  {
    name: "BaseEntity",
    category: "orm-entity",
    targets: ["class"],
    isEntity: true,
    isClassMacro: true,
    needsMacroFieldRegistration: true,
    description: "Declares an ORM entity with standard id, createdAt, updatedAt, and deletedAt columns.",
  },
  { name: "Column", category: "orm-column", targets: ["property"], isColumn: true },
  { name: "CreateDateColumn", category: "orm-column", targets: ["property"], isColumn: true },
  { name: "UpdateDateColumn", category: "orm-column", targets: ["property"], isColumn: true },
  { name: "DeleteDateColumn", category: "orm-column", targets: ["property"], isColumn: true },
  { name: "VersionColumn", category: "orm-column", targets: ["property"], isColumn: true },
  { name: "PrimaryColumn", category: "orm-column", targets: ["property"], isColumn: true, isPrimaryColumn: true },
  { name: "PrimaryGeneratedColumn", category: "orm-column", targets: ["property"], isColumn: true, isPrimaryColumn: true },
  { name: "ObjectIdColumn", category: "orm-column", targets: ["property"], isColumn: true, isPrimaryColumn: true },
  { name: "PrimaryKey", category: "orm-column", targets: ["property"], isColumn: true, isPrimaryColumn: true },

  // ---- ORM Relation / Embedded Decorators ----
  { name: "OneToOne", category: "orm-relation", targets: ["property"], isRelation: true },
  { name: "ManyToOne", category: "orm-relation", targets: ["property"], isRelation: true },
  { name: "OneToMany", category: "orm-relation", targets: ["property"], isRelation: true },
  { name: "ManyToMany", category: "orm-relation", targets: ["property"], isRelation: true },
  { name: "Embedded", category: "orm-relation", targets: ["property"], isRelation: true },
  { name: "Nested", category: "orm-relation", targets: ["property"], isRelation: true },

  // ---- ORM Repository Decorators ----
  { name: "Repository", category: "orm-repository", targets: ["class"], isRepository: true, isDiManaged: true },

  // ---- DI Managed Classes ----
  { name: "Injectable", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Controller", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Resolver", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Processor", category: "di", targets: ["class"], isDiManaged: true },
  { name: "WebSocketGateway", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Policy", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Workflow", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Module", category: "di", targets: ["class"], isDiManaged: true },
  { name: "AutoModule", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Global", category: "di", targets: ["class"], isDiManaged: true },
  { name: "CommandHandler", category: "di", targets: ["class"], isDiManaged: true },
  { name: "QueryHandler", category: "di", targets: ["class"], isDiManaged: true },
  { name: "EventsHandler", category: "di", targets: ["class"], isDiManaged: true },
  { name: "Saga", category: "di", targets: ["method"] },

  // ---- Service-Layer AOP Decorators (Require DI-Managed Host Class) ----
  { name: "Transactional", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Cacheable", category: "aop", targets: ["method"], isServiceAop: true },
  { name: "CacheEvict", category: "aop", targets: ["method"], isServiceAop: true },
  { name: "CachePut", category: "aop", targets: ["method"], isServiceAop: true },
  { name: "WithLock", category: "aop", targets: ["method"], isServiceAop: true },
  { name: "Retry", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Timeout", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "CircuitBreaker", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Bulkhead", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Fallback", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Resilience", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Idempotent", category: "aop", targets: ["class", "method"], isServiceAop: true },
  { name: "Span", category: "aop", targets: ["class", "method"], isServiceAop: true },
];

export const BUILTIN_DECORATOR_SPECS: ReadonlyMap<
  string,
  BuiltinDecoratorSpec
> = new Map(RAW_BUILTIN_SPECS.map((spec) => [spec.name, spec]));

function buildNameSet(
  predicate: (spec: BuiltinDecoratorSpec) => boolean,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of RAW_BUILTIN_SPECS) {
    if (predicate(spec)) {
      out.add(spec.name);
    }
  }
  return out;
}

export const BUILTIN_CLASS_MACRO_NAMES: ReadonlySet<string> = buildNameSet(
  (s) => s.isClassMacro === true,
);

export const BUILTIN_FIELD_MACRO_NAMES: ReadonlySet<string> = buildNameSet(
  (s) => s.isFieldMacro === true,
);

export const BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES: ReadonlySet<string> =
  buildNameSet((s) => s.needsMacroFieldRegistration === true);

export const BUILTIN_ENTITY_DECORATOR_NAMES: ReadonlySet<string> = buildNameSet(
  (s) => s.isEntity === true,
);

export const BUILTIN_REPOSITORY_DECORATOR_NAMES: ReadonlySet<string> =
  buildNameSet((s) => s.isRepository === true);

export const BUILTIN_ORM_COLUMN_DECORATOR_NAMES: ReadonlySet<string> =
  buildNameSet((s) => s.isColumn === true && s.isPrimaryColumn !== true);

export const BUILTIN_ORM_PRIMARY_COLUMN_DECORATOR_NAMES: ReadonlySet<string> =
  buildNameSet((s) => s.isPrimaryColumn === true);

export const BUILTIN_ORM_RELATION_DECORATOR_NAMES: ReadonlySet<string> =
  buildNameSet((s) => s.isRelation === true);

export const BUILTIN_DI_CLASS_DECORATORS: ReadonlySet<string> = buildNameSet(
  (s) => s.isDiManaged === true,
);

export const BUILTIN_SERVICE_AOP_DECORATORS: ReadonlySet<string> = buildNameSet(
  (s) => s.isServiceAop === true,
);

export interface ConflictingDecoratorPair {
  readonly first: string;
  readonly second: string;
  readonly reason: string;
}

export const CONFLICTING_CLASS_MACRO_PAIRS: readonly ConflictingDecoratorPair[] =
  [
    {
      first: "Value",
      second: "Setter",
      reason:
        "@Value() creates frozen immutable value objects and conflicts with @Setter(). Remove @Setter() or switch @Value() to @Data().",
    },
    {
      first: "Value",
      second: "Data",
      reason:
        "@Value() (immutable, frozen) conflicts with @Data() (mutable with setters). Keep only one of @Value() or @Data().",
    },
    {
      first: "UtilityClass",
      second: "Data",
      reason:
        "@UtilityClass() forbids instantiation (`new` throws TypeError) and cannot be combined with @Data().",
    },
    {
      first: "UtilityClass",
      second: "Value",
      reason:
        "@UtilityClass() forbids instantiation (`new` throws TypeError) and cannot be combined with @Value().",
    },
    {
      first: "UtilityClass",
      second: "Builder",
      reason:
        "@UtilityClass() forbids instantiation (`new` throws TypeError) and cannot be combined with @Builder().",
    },
    {
      first: "UtilityClass",
      second: "SuperBuilder",
      reason:
        "@UtilityClass() forbids instantiation (`new` throws TypeError) and cannot be combined with @SuperBuilder().",
    },
  ];

// ============================================================================
// Shared `@BaseEntity<Key>(options?)` AST Parser (Used by Scanner + Analyzer)
// ============================================================================

function unwrapExpr(expr: Expression | undefined): Expression | undefined {
  let current = expr;
  while (current) {
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
    } else if (Node.isAsExpression(current)) {
      current = current.getExpression();
    } else if (Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
    } else {
      break;
    }
  }
  return current;
}

function readStringLiteral(expr: Expression | undefined): string | undefined {
  const u = unwrapExpr(expr);
  if (!u) return undefined;
  if (Node.isStringLiteral(u) || Node.isNoSubstitutionTemplateLiteral(u)) {
    return u.getLiteralValue();
  }
  return undefined;
}

function readObjProp(
  expr: Expression | undefined,
  propName: string,
): Expression | undefined {
  const u = unwrapExpr(expr);
  if (!u || !Node.isObjectLiteralExpression(u)) return undefined;
  const prop = u.getProperty(propName);
  if (prop && Node.isPropertyAssignment(prop)) {
    return prop.getInitializer();
  }
  return undefined;
}

export interface ParseBaseEntityAstInput {
  readonly decorator?: Decorator;
  /** Optional first argument expression (overrides `decorator.getArguments()[0]`, e.g. from `applyDecorators`). */
  readonly arg0?: Expression;
  /** Optional explicit type argument node (overrides `decorator.getCallExpression()?.getTypeArguments()[0]`). */
  readonly typeArgNode?: Node;
  /** Optional substituted key type text (e.g. generic `<Key>` resolved to `"string"` via `applyDecorators`). */
  readonly keyTypeOverride?: string;
  /** Optional rich type printer hook used by Typegen scanner to collect cross-file type imports. */
  readonly formatTypeArg?: (typeArgNode: Node) => {
    readonly text: string;
    readonly imports?: readonly ExtractedImportRef[];
  };
}

export interface ParsedBaseEntityAstResult {
  readonly keyTypeText: string;
  readonly idProperty: string;
  readonly idColumnName?: string;
  readonly idStrategy: "increment" | "uuid" | "objectid" | false;
  readonly tableName?: string;
  readonly camelCaseMapping?: boolean;
  readonly deletedAtDisabled: boolean;
  readonly deletedAtProperty?: string;
  readonly fields: readonly ExtractedBaseEntityField[];
  readonly imports: readonly ExtractedImportRef[];
}

/**
 * Single-source AST parser for `@BaseEntity<Key>(tableOrOptions?)`.
 * Consumed by both `@bunest/cli` Typegen Scanner and ORM Repository Query Analyzer
 * so option parsing, key-type inference, and column naming never drift apart.
 */
export function parseBaseEntityDecoratorAst(
  input: ParseBaseEntityAstInput,
): ParsedBaseEntityAstResult {
  const dec = input.decorator;
  const callExpr = dec?.getCallExpression();
  const arg0 =
    input.arg0 ?? (dec?.getArguments()[0] as Expression | undefined);
  const unwrappedArg0 = unwrapExpr(arg0);
  const optsExpr =
    unwrappedArg0 && Node.isObjectLiteralExpression(unwrappedArg0)
      ? unwrappedArg0
      : undefined;

  const explicitTableName =
    readStringLiteral(unwrappedArg0) ??
    readStringLiteral(readObjProp(optsExpr, "tableName")) ??
    readStringLiteral(readObjProp(optsExpr, "name")) ??
    readStringLiteral(readObjProp(optsExpr, "table"));

  const camelExpr = readObjProp(optsExpr, "camelCaseMapping");
  const camelKind = camelExpr?.getKind();
  const camelCaseMapping = cond<boolean, undefined>(
    [
      [camelKind === SyntaxKind.FalseKeyword, false],
      [camelKind === SyntaxKind.TrueKeyword, true],
    ],
    undefined,
  );

  const idStrategyExpr = readObjProp(optsExpr, "idStrategy");
  let idStrategy: "increment" | "uuid" | "objectid" | false | undefined;
  if (idStrategyExpr?.getKind() === SyntaxKind.FalseKeyword) {
    idStrategy = false;
  } else {
    const s = readStringLiteral(idStrategyExpr);
    if (s === "increment" || s === "uuid" || s === "objectid") {
      idStrategy = s;
    }
  }

  const idColExpr = readObjProp(optsExpr, "idColumn");
  const idColExplicitName =
    readStringLiteral(idColExpr) ??
    readStringLiteral(readObjProp(idColExpr, "name"));
  const idColType = readStringLiteral(readObjProp(idColExpr, "type"));

  const imports: ExtractedImportRef[] = [];
  const typeArgNode = input.typeArgNode ?? callExpr?.getTypeArguments()[0];
  let keyTypeText: string;

  if (input.keyTypeOverride && input.keyTypeOverride.trim().length > 0) {
    keyTypeText = sanitizeTypeText(input.keyTypeOverride.trim(), "number");
  } else if (typeArgNode) {
    const rawText = typeArgNode.getText().trim();
    if (
      rawText === "number" ||
      rawText === "string" ||
      rawText === "bigint" ||
      rawText === "symbol" ||
      rawText === "unknown"
    ) {
      keyTypeText = rawText;
    } else if (input.formatTypeArg) {
      const printed = input.formatTypeArg(typeArgNode);
      keyTypeText = sanitizeTypeText(
        printed.text,
        sanitizeTypeText(rawText, "number"),
      );
      if (printed.imports) {
        imports.push(...printed.imports);
      }
    } else {
      keyTypeText = sanitizeTypeText(rawText, "number");
    }
  } else if (
    idStrategy === "uuid" ||
    idStrategy === "objectid" ||
    idColType === "uuid" ||
    idColType === "objectid" ||
    idColType === "text" ||
    idColType === "varchar"
  ) {
    keyTypeText = "string";
  } else if (idColType === "bigint") {
    keyTypeText = "bigint";
  } else {
    keyTypeText = "number";
  }

  const effectiveStrategy: "increment" | "uuid" | "objectid" | false =
    idStrategy ??
    (idColType === "objectid" || idColType === "uuid"
      ? idColType
      : "increment");

  const idProperty =
    readStringLiteral(readObjProp(optsExpr, "idProperty")) ?? "id";
  const idColumnName =
    idColExplicitName ??
    (effectiveStrategy === "objectid" ? "_id" : undefined);

  const parseTimestampOpt = (
    optKey: "createdAt" | "updatedAt" | "deletedAt",
    defaultProp: string,
  ): { readonly name: string; readonly columnName?: string } | undefined => {
    const expr = readObjProp(optsExpr, optKey);
    if (!expr || expr.getKind() === SyntaxKind.TrueKeyword) {
      return { name: defaultProp };
    }
    if (expr.getKind() === SyntaxKind.FalseKeyword) {
      return undefined;
    }
    const strVal = readStringLiteral(expr);
    if (strVal) {
      return { name: strVal };
    }
    const u = unwrapExpr(expr);
    if (u && Node.isObjectLiteralExpression(u)) {
      const prop =
        readStringLiteral(readObjProp(u, "property")) ?? defaultProp;
      const col = readStringLiteral(readObjProp(u, "name"));
      return { name: prop, ...(col ? { columnName: col } : {}) };
    }
    return { name: defaultProp };
  };

  const fields: ExtractedBaseEntityField[] = [
    {
      role: "id",
      name: idProperty,
      ...(idColumnName ? { columnName: idColumnName } : {}),
      typeText: keyTypeText,
      optional: false,
      strategy: effectiveStrategy,
    },
  ];

  const createdOpt = parseTimestampOpt("createdAt", "createdAt");
  if (createdOpt) {
    fields.push({
      role: "createdAt",
      name: createdOpt.name,
      ...(createdOpt.columnName ? { columnName: createdOpt.columnName } : {}),
      typeText: "Date",
      optional: false,
    });
  }

  const updatedOpt = parseTimestampOpt("updatedAt", "updatedAt");
  if (updatedOpt) {
    fields.push({
      role: "updatedAt",
      name: updatedOpt.name,
      ...(updatedOpt.columnName ? { columnName: updatedOpt.columnName } : {}),
      typeText: "Date",
      optional: false,
    });
  }

  const deletedOpt = parseTimestampOpt("deletedAt", "deletedAt");
  if (deletedOpt) {
    fields.push({
      role: "deletedAt",
      name: deletedOpt.name,
      ...(deletedOpt.columnName ? { columnName: deletedOpt.columnName } : {}),
      typeText: "Date | null",
      optional: true,
    });
  }

  return {
    keyTypeText,
    idProperty,
    ...(idColumnName !== undefined ? { idColumnName } : {}),
    idStrategy: effectiveStrategy,
    ...(explicitTableName !== undefined ? { tableName: explicitTableName } : {}),
    ...(camelCaseMapping !== undefined ? { camelCaseMapping } : {}),
    deletedAtDisabled: deletedOpt === undefined,
    ...(deletedOpt ? { deletedAtProperty: deletedOpt.name } : {}),
    fields,
    imports,
  };
}
