export {
  BUILTIN_CLASS_MACRO_NAMES,
  BUILTIN_DECORATOR_SPECS,
  BUILTIN_DI_CLASS_DECORATORS,
  BUILTIN_ENTITY_DECORATOR_NAMES,
  BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES,
  BUILTIN_FIELD_MACRO_NAMES,
  BUILTIN_ORM_COLUMN_DECORATOR_NAMES,
  BUILTIN_ORM_PRIMARY_COLUMN_DECORATOR_NAMES,
  BUILTIN_ORM_RELATION_DECORATOR_NAMES,
  BUILTIN_REPOSITORY_DECORATOR_NAMES,
  BUILTIN_SERVICE_AOP_DECORATORS,
  CONFLICTING_CLASS_MACRO_PAIRS,
  parseBaseEntityDecoratorAst,
  type BuiltinDecoratorCategory,
  type BuiltinDecoratorSpec,
  type ConflictingDecoratorPair,
  type DecoratorTargetKind,
  type ParseBaseEntityAstInput,
  type ParsedBaseEntityAstResult,
} from "./builtin-specs";

export {
  getExpandedDecoratorNames,
  resolveComposedDecorators,
  type ResolvedDecoratorEntry,
} from "./compose-resolver";
