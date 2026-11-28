import { capitalize } from "@bunest/core/common";
import { Node, type ClassDeclaration, type SourceFile } from "../ast";
import {
  collectCustomMacros,
  type BunestConfigLike,
  type CustomMacroPluginInput,
} from "../config/bunest-config.loader";
import type { ExtractedClassMacroEntry } from "../typegen/types";
import type {
  AnalyzedEntity,
  AnalyzedQueryMethod,
  AnalyzedRepository,
  RepoSqlDialect,
} from "./repository-query";
import { TextEditor } from "./text-editor";

export interface TextEditSpan {
  readonly filePath: string;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly description: string;
}

export interface MagicEditResult {
  readonly filePath: string;
  readonly original: string;
  readonly updated: string;
  readonly changed: boolean;
  readonly edits: readonly TextEditSpan[];
}

const BASE_ENTITY_ID_DECORATORS: Readonly<Record<string, string>> = {
  objectid: "@ObjectIdColumn()",
  uuid: '@PrimaryGeneratedColumn("uuid")',
  false: "@PrimaryColumn()",
};

function detectIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const linePrefix = text.slice(lineStart, offset);
  const m = /^[ \t]*/.exec(linePrefix);
  return m ? m[0] : "";
}

function computeSingleFileDiffSpan(
  filePath: string,
  original: string,
  s: TextEditor,
  description: string,
): MagicEditResult {
  const updated = s.toString();
  return {
    filePath,
    original,
    updated,
    changed: updated !== original,
    edits:
      updated === original
        ? []
        : [
            {
              filePath,
              start: 0,
              end: original.length,
              newText: updated,
              description,
            },
          ],
  };
}

// ============================================================================
// 1. Auto-Wire Provider / Controller into @Module({ ... })
// ============================================================================

export function buildAddProviderToModuleEdit(options: {
  readonly sourceFile: SourceFile;
  readonly moduleClassName: string;
  readonly symbolName: string;
  readonly arrayProperty: "providers" | "controllers" | "exports" | "imports";
  readonly importSpecifier?: string;
}): MagicEditResult {
  const filePath = options.sourceFile.getFilePath();
  const original = options.sourceFile.getFullText();
  const s = new TextEditor(original);

  const cls = options.sourceFile.getClass(options.moduleClassName);
  const modDec = cls
    ?.getDecorators()
    .find((d) => d.getName() === "Module" || d.getName() === "AutoModule");
  if (!modDec) {
    return { filePath, original, updated: original, changed: false, edits: [] };
  }

  // Ensure import exists when `importSpecifier` is provided
  if (options.importSpecifier) {
    const alreadyImported = options.sourceFile
      .getImportDeclarations()
      .some((imp) =>
        imp.getNamedImports().some((n) => n.getName() === options.symbolName),
      );
    if (!alreadyImported) {
      const existingFromSame = options.sourceFile
        .getImportDeclarations()
        .find((imp) => imp.getModuleSpecifierValue() === options.importSpecifier);
      if (existingFromSame) {
        const named = existingFromSame.getNamedImports();
        const lastNamed = named[named.length - 1];
        if (lastNamed) {
          s.appendRight(lastNamed.getEnd(), `, ${options.symbolName}`);
        }
      } else {
        const imports = options.sourceFile.getImportDeclarations();
        const insertAt =
          imports.length > 0 ? imports[imports.length - 1]!.getEnd() : 0;
        const prefix = insertAt > 0 ? "\n" : "";
        const suffix = insertAt === 0 ? "\n" : "";
        s.appendRight(
          insertAt,
          `${prefix}import { ${options.symbolName} } from ${JSON.stringify(options.importSpecifier)};${suffix}`,
        );
      }
    }
  }

  const arg0 = modDec.getArguments()[0];
  if (!arg0 || !Node.isObjectLiteralExpression(arg0)) {
    const callExpr = modDec.getCallExpression();
    if (callExpr) {
      s.overwrite(
        callExpr.getStart(),
        callExpr.getEnd(),
        `${modDec.getName()}({ ${options.arrayProperty}: [${options.symbolName}] })`,
      );
    }
    return computeSingleFileDiffSpan(
      filePath,
      original,
      s,
      `Add ${options.symbolName} to ${options.moduleClassName}.${options.arrayProperty}`,
    );
  }

  const existingProp = arg0.getProperty(options.arrayProperty);
  if (existingProp && Node.isPropertyAssignment(existingProp)) {
    const init = existingProp.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) {
      const elements = init.getElements();
      const alreadyPresent = elements.some(
        (el) => el.getText().trim() === options.symbolName,
      );
      if (!alreadyPresent) {
        if (elements.length === 0) {
          s.overwrite(init.getStart(), init.getEnd(), `[${options.symbolName}]`);
        } else {
          const last = elements[elements.length - 1]!;
          const isMultiline = init.getText().includes("\n");
          if (isMultiline) {
            const itemIndent = detectIndent(original, last.getStart());
            s.appendRight(last.getEnd(), `,\n${itemIndent}${options.symbolName}`);
          } else {
            s.appendRight(last.getEnd(), `, ${options.symbolName}`);
          }
        }
      }
    }
  } else {
    const props = arg0.getProperties();
    const isMultiline = arg0.getText().includes("\n");
    if (props.length === 0) {
      s.overwrite(
        arg0.getStart(),
        arg0.getEnd(),
        `{ ${options.arrayProperty}: [${options.symbolName}] }`,
      );
    } else {
      const last = props[props.length - 1]!;
      if (isMultiline) {
        const propIndent = detectIndent(original, last.getStart());
        s.appendRight(
          last.getEnd(),
          `,\n${propIndent}${options.arrayProperty}: [${options.symbolName}]`,
        );
      } else {
        s.appendRight(
          last.getEnd(),
          `, ${options.arrayProperty}: [${options.symbolName}]`,
        );
      }
    }
  }

  return computeSingleFileDiffSpan(
    filePath,
    original,
    s,
    `Add ${options.symbolName} to ${options.moduleClassName}.${options.arrayProperty}`,
  );
}

// ============================================================================
// 2. Fix `import type` -> Value `import` (BUNEST004)
// ============================================================================

export function buildConvertTypeImportEdit(options: {
  readonly sourceFile: SourceFile;
  readonly symbolName: string;
}): MagicEditResult {
  const filePath = options.sourceFile.getFilePath();
  const original = options.sourceFile.getFullText();
  const s = new TextEditor(original);

  for (const imp of options.sourceFile.getImportDeclarations()) {
    const matching = imp
      .getNamedImports()
      .find(
        (n) => (n.getAliasNode()?.getText() ?? n.getName()) === options.symbolName,
      );
    if (!matching) continue;

    if (imp.isTypeOnly()) {
      const allNamed = imp.getNamedImports();
      const modSpec = imp.getModuleSpecifier().getText();
      if (allNamed.length === 1) {
        // `import type { Foo } from "./foo";` -> `import { Foo } from "./foo";`
        const text = imp.getText();
        const replaced = text.replace(/\bimport\s+type\s+/, "import ");
        s.overwrite(imp.getStart(), imp.getEnd(), replaced);
      } else {
        // Split out the value import cleanly while preserving remaining type imports
        const remaining = allNamed
          .filter((n) => n !== matching)
          .map((n) => n.getText());
        const newBlock = `import type { ${remaining.join(", ")} } from ${modSpec};\nimport { ${matching.getText()} } from ${modSpec};`;
        s.overwrite(imp.getStart(), imp.getEnd(), newBlock);
      }
      break;
    }

    if (matching.isTypeOnly()) {
      // `import { type Foo, Bar } from "./x"` -> `import { Foo, Bar } from "./x"`
      const clean = matching.getText().replace(/^type\s+/, "");
      s.overwrite(matching.getStart(), matching.getEnd(), clean);
      break;
    }
  }

  return computeSingleFileDiffSpan(
    filePath,
    original,
    s,
    `Convert type-only import of ${options.symbolName} to value import for DI metadata`,
  );
}

// ============================================================================
// 3. Wrap Bare Mongoose `@Prop({ ref: "..." })` with `type: Schema.Types.ObjectId` (BUNEST006)
// ============================================================================

export function buildWrapMongooseRefEdit(options: {
  readonly filePath: string;
  readonly sourceText: string;
  readonly decoratorStart: number;
  readonly decoratorEnd: number;
}): MagicEditResult {
  const original = options.sourceText;
  const s = new TextEditor(original);
  const raw = original.slice(options.decoratorStart, options.decoratorEnd);
  const patched = raw.replace(
    /(\{\s*)(ref\s*:)/,
    "$1type: Schema.Types.ObjectId, $2",
  );
  if (patched !== raw) {
    s.overwrite(options.decoratorStart, options.decoratorEnd, patched);
  }
  return computeSingleFileDiffSpan(
    options.filePath,
    original,
    s,
    "Add explicit `type: Schema.Types.ObjectId` to Mongoose @Prop({ ref })",
  );
}

// ============================================================================
// 4. Convert Derived Repository Method -> Explicit `@Query(...)` SQL
// ============================================================================

export function buildConvertDerivedToQueryEdit(options: {
  readonly filePath: string;
  readonly sourceText: string;
  readonly method: AnalyzedQueryMethod;
  readonly repo: AnalyzedRepository;
}): MagicEditResult {
  const original = options.sourceText;
  const derived = options.method.derived;
  if (!derived) {
    return {
      filePath: options.filePath,
      original,
      updated: original,
      changed: false,
      edits: [],
    };
  }

  const s = new TextEditor(original);
  const indent = detectIndent(original, options.method.methodStart);

  // Convert `?` / `$1` placeholders into readable `:paramName` named placeholders
  let sql = derived.sqlPreview;
  const paramNames =
    options.method.params.length === derived.expectedParams.length
      ? options.method.params.map((p) => p.name)
      : derived.expectedParams.map((p) => p.name);

  let pIdx = 0;
  sql = sql.replace(/\?|\$\d+/g, () => {
    const name = paramNames[pIdx] ?? `param${pIdx + 1}`;
    pIdx++;
    return `:${name}`;
  });

  const decoratedParams = (
    options.method.params.length === derived.expectedParams.length
      ? options.method.params.map((p) => ({ name: p.name, tsType: p.tsType }))
      : derived.expectedParams
  ).map((p) => `@SqlParam(${JSON.stringify(p.name)}) ${p.name}: ${p.tsType}`);

  const queryDecName = "Query";
  const modifyingLine =
    derived.kind === "delete" ? `\n${indent}@Modifying()` : "";
  const replacement = `@${queryDecName}(${JSON.stringify(sql)})${modifyingLine}\n${indent}${options.method.name}(${decoratedParams.join(", ")}): ${options.method.returnTypeText || derived.expectedReturnType} {\n${indent}  throw new Error("Implemented by Bunest repository proxy");\n${indent}}`;

  s.overwrite(options.method.methodStart, options.method.methodEnd, replacement);

  return computeSingleFileDiffSpan(
    options.filePath,
    original,
    s,
    `Convert derived query ${options.method.name} to explicit @${queryDecName}()`,
  );
}

// ============================================================================
// 5. Generate Declarative CrudRepository from @Entity()
// ============================================================================

export function buildGenerateRepositorySource(options: {
  readonly entity: AnalyzedEntity;
  readonly entityImportPath: string;
  readonly dialect?: RepoSqlDialect;
}): { readonly fileName: string; readonly content: string } {
  const baseName = options.entity.className.replace(/Entity$/i, "") || options.entity.className;
  const repoClassName = `${baseName}Repository`;
  const kebab = baseName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const pkg = "@bunest/orm";
  const repoDec = "Repository";

  const derivedMethods: string[] = [];
  for (const field of options.entity.fields) {
    if (field.primary) continue;
    const cap = capitalize(field.propertyName);
    const cleanType = field.tsType.replace(/\s*\|\s*(?:null|undefined)/g, "").trim() || "unknown";
    if (field.unique) {
      derivedMethods.push(
        `  abstract findBy${cap}(${field.propertyName}: ${cleanType}): Promise<${options.entity.className} | null>;`,
      );
      derivedMethods.push(
        `  abstract existsBy${cap}(${field.propertyName}: ${cleanType}): Promise<boolean>;`,
      );
    } else if (field.indexed) {
      derivedMethods.push(
        `  abstract findAllBy${cap}(${field.propertyName}: ${cleanType}): Promise<${options.entity.className}[]>;`,
      );
    }
  }

  if (derivedMethods.length === 0) {
    const firstNonPk = options.entity.fields.find((f) => !f.primary);
    if (firstNonPk) {
      const cap = capitalize(firstNonPk.propertyName);
      derivedMethods.push(
        `  abstract findAllBy${cap}(${firstNonPk.propertyName}: ${firstNonPk.tsType}): Promise<${options.entity.className}[]>;`,
      );
    }
  }

  const content = [
    `import { ${repoDec} } from ${JSON.stringify(pkg)};`,
    `import type { ${options.entity.className} } from ${JSON.stringify(options.entityImportPath)};`,
    "",
    `@${repoDec}<${options.entity.className}, ${options.entity.idTsType}>()`,
    `export abstract class ${repoClassName} {`,
    ...derivedMethods,
    "}",
    "",
  ].join("\n");

  return {
    fileName: `${kebab}.repository.ts`,
    content,
  };
}

// ============================================================================
// 6. 1-Click Delombok: Expand Class Macro Decorators into Explicit TypeScript
// ============================================================================

function formatDelombokDefaultValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  if (value instanceof Date) return `new Date(${JSON.stringify(value.toISOString())})`;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function formatCustomDelombokSignature(name: string, raw: string): string {
  const trimmed = raw.trim().replace(/;+$/, "").replace(/^static\s+/, "");
  if (!trimmed) return `${name}(): unknown`;
  if (trimmed.startsWith("(") || trimmed.startsWith("<")) {
    const arrowIdx = trimmed.indexOf("=>");
    if (arrowIdx !== -1 && !trimmed.slice(0, arrowIdx).includes("{")) {
      return `${name}${trimmed.slice(0, arrowIdx).trim()}: ${trimmed.slice(arrowIdx + 2).trim()}`;
    }
    return `${name}${trimmed}`;
  }
  if (
    trimmed.startsWith(`${name}(`) ||
    trimmed.startsWith(`${name}<`)
  ) {
    return trimmed;
  }
  if (/^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(trimmed)) {
    return trimmed;
  }
  return `${name}(): ${trimmed}`;
}

function indentBlockLines(code: string, indent: string): string {
  return code
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim().length > 0 ? `${indent}${line}` : ""))
    .join("\n");
}

export function buildDelombokEdit(options: {
  readonly sourceFile: SourceFile;
  readonly classDecl: ClassDeclaration;
  readonly macro: ExtractedClassMacroEntry;
  readonly targetDecorator?: string;
  readonly bunestConfig?: BunestConfigLike;
  readonly customMacros?: readonly CustomMacroPluginInput[];
  readonly presets?: Readonly<Record<string, readonly string[]>>;
}): MagicEditResult {
  const filePath = options.sourceFile.getFilePath();
  const original = options.sourceFile.getFullText();
  const s = new TextEditor(original);

  const cls = options.classDecl;
  const macro = options.macro;
  const target = options.targetDecorator;
  const clsIndent = detectIndent(original, cls.getStart());
  const memberIndent = `${clsIndent}  `;
  const ownMethods = new Set(macro.ownMethodNames);
  const ownProps = new Set(macro.ownPropertyNames);
  const generatedBlocks: string[] = [];

  const customMacroMap = collectCustomMacros(
    options.bunestConfig,
    options.customMacros,
  );
  const presets: Record<string, readonly string[]> = {
    ...(options.bunestConfig?.macros?.presets ?? {}),
    ...(options.presets ?? {}),
  };

  // Resolve target preset expansion so `delombok --decorator DomainEntity` expands all composed built-in macros
  const targetExpanded = new Set<string>();
  if (target) {
    const visitTarget = (name: string): void => {
      if (targetExpanded.has(name)) return;
      targetExpanded.add(name);
      for (const sub of presets[name] ?? []) visitTarget(sub);
      for (const sub of customMacroMap.get(name)?.composedNames ?? []) {
        visitTarget(sub);
      }
    };
    visitTarget(target);
  }

  const shouldExpand = (decName: string): boolean =>
    !target || targetExpanded.has(decName);

  const removedDecorators = new Set<string>();
  const removeDecorator = (decName: string): void => {
    if (removedDecorators.has(decName)) return;
    const dec = cls.getDecorators().find((d) => {
      const n = d.getName();
      const dot = n.lastIndexOf(".");
      const short = dot !== -1 ? n.slice(dot + 1) : n;
      return short === decName;
    });
    if (!dec) return;
    removedDecorators.add(decName);
    let start = dec.getStart();
    let end = dec.getEnd();
    // Remove leading indent on the decorator's own line + trailing newline
    const lineStart = original.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    if (/^[ \t]*$/.test(original.slice(lineStart, start))) {
      start = lineStart;
    }
    if (original[end] === "\r") end++;
    if (original[end] === "\n") end++;
    s.remove(start, end);
  };

  // Remove any preset decorators matching `target` (or all presets when expanding all)
  const activePresetNames = new Set<string>([
    ...(macro.expandedPresets ?? []),
    ...macro.decorators.filter((d) => Object.prototype.hasOwnProperty.call(presets, d)),
  ]);
  for (const presetName of activePresetNames) {
    if (shouldExpand(presetName)) {
      removeDecorator(presetName);
    }
  }

  // @BaseEntity<Key>
  if (macro.isBaseEntity && shouldExpand("BaseEntity")) {
    removeDecorator("BaseEntity");
    const hasEntityDecorator = cls
      .getDecorators()
      .some((d) => {
        const name = d.getName();
        return name === "Entity" || name.endsWith(".Entity");
      });
    if (!hasEntityDecorator) {
      const clsStart = cls.getStart();
      s.prependLeft(clsStart, `${clsIndent}@Entity()\n`);
    }
    for (const bf of macro.baseEntityFields ?? []) {
      if (macro.ownPropertyNames.includes(bf.name)) continue;
      if (bf.role === "id") {
        const decLine =
          BASE_ENTITY_ID_DECORATORS[String(bf.strategy)] ??
          "@PrimaryGeneratedColumn()";
        generatedBlocks.push(
          `${memberIndent}${decLine}\n${memberIndent}${bf.name}!: ${bf.typeText};`,
        );
      } else if (bf.role === "createdAt") {
        generatedBlocks.push(
          `${memberIndent}@CreateDateColumn()\n${memberIndent}${bf.name}!: Date;`,
        );
      } else if (bf.role === "updatedAt") {
        generatedBlocks.push(
          `${memberIndent}@UpdateDateColumn()\n${memberIndent}${bf.name}!: Date;`,
        );
      } else if (bf.role === "deletedAt") {
        generatedBlocks.push(
          `${memberIndent}@DeleteDateColumn()\n${memberIndent}${bf.name}?: Date | null;`,
        );
      }
    }
  }

  // @WithLogger
  if (macro.isWithLogger && shouldExpand("WithLogger")) {
    removeDecorator("WithLogger");
    if (!macro.ownPropertyNames.includes(macro.loggerPropertyName)) {
      generatedBlocks.push(
        `${memberIndent}readonly ${macro.loggerPropertyName} = new Logger(${JSON.stringify(macro.loggerContext ?? macro.className)});`,
      );
    }
  }

  // @FieldNameConstants
  if (macro.isFieldNameConstants && shouldExpand("FieldNameConstants")) {
    removeDecorator("FieldNameConstants");
    const pairs = macro.fields
      .filter((f) => !f.fieldConstantExclude)
      .map((f) => `${memberIndent}  ${f.name}: ${JSON.stringify(f.name)},`)
      .join("\n");
    generatedBlocks.push(
      `${memberIndent}static readonly ${macro.fieldConstantsInnerName} = {\n${pairs}\n${memberIndent}} as const;`,
    );
  }

  // @Data / @Value / @Getter / @Setter
  const expandData = macro.isData && shouldExpand("Data");
  const expandValue = macro.isValue && shouldExpand("Value");
  const expandGetter = macro.isGetter && shouldExpand("Getter");
  const expandSetter = macro.isSetter && shouldExpand("Setter");
  const expandWith = macro.isWith && shouldExpand("With");
  const expandWithBy = macro.isWithBy && shouldExpand("WithBy");
  const expandToString = macro.isToString && shouldExpand("ToString");
  const expandEquals =
    macro.isEqualsAndHashCode && shouldExpand("EqualsAndHashCode");
  const expandJson =
    macro.isJsonSerializable && shouldExpand("JsonSerializable");
  const expandBuilder =
    (macro.isBuilder && shouldExpand("Builder")) ||
    (macro.isSuperBuilder && shouldExpand("SuperBuilder"));

  if (expandData) removeDecorator("Data");
  if (expandValue) removeDecorator("Value");
  if (expandGetter) removeDecorator("Getter");
  if (expandSetter) removeDecorator("Setter");
  if (expandWith) removeDecorator("With");
  if (expandWithBy) removeDecorator("WithBy");
  if (expandToString) removeDecorator("ToString");
  if (expandEquals) removeDecorator("EqualsAndHashCode");
  if (expandJson) removeDecorator("JsonSerializable");
  if (expandBuilder) {
    removeDecorator("Builder");
    removeDecorator("SuperBuilder");
  }

  const fieldsTypeInline =
    macro.fields
      .map((f) => `${f.name}${f.optional || f.hasDefault ? "?" : ""}: ${f.typeText}`)
      .join("; ") || "";

  if (expandData || expandValue) {
    const freezeWrap = expandValue ? "Object.freeze(instance)" : "instance";
    generatedBlocks.push(
      [
        `${memberIndent}static of(props: { ${fieldsTypeInline} }): ${macro.className} {`,
        `${memberIndent}  const instance = Object.assign(new ${macro.className}(), props);`,
        `${memberIndent}  return ${freezeWrap};`,
        `${memberIndent}}`,
      ].join("\n"),
    );
    if (!ownMethods.has("clone")) {
      generatedBlocks.push(
        [
          `${memberIndent}clone(): ${macro.className} {`,
          `${memberIndent}  return ${macro.className}.of({ ...this });`,
          `${memberIndent}}`,
        ].join("\n"),
      );
    }
  }

  if (expandGetter || expandData || expandValue) {
    for (const f of macro.fields) {
      const gName = `get${capitalize(f.name)}`;
      if (ownMethods.has(gName)) continue;
      generatedBlocks.push(
        `${memberIndent}${gName}(): ${f.typeText}${f.optional ? " | undefined" : ""} {\n${memberIndent}  return this.${f.name};\n${memberIndent}}`,
      );
    }
  }

  if ((expandSetter || expandData) && !macro.isValue) {
    for (const f of macro.fields) {
      const sName = `set${capitalize(f.name)}`;
      if (ownMethods.has(sName)) continue;
      generatedBlocks.push(
        `${memberIndent}${sName}(value: ${f.typeText}${f.optional ? " | undefined" : ""}): this {\n${memberIndent}  this.${f.name} = value;\n${memberIndent}  return this;\n${memberIndent}}`,
      );
    }
  }

  if (expandWith || expandData || expandValue) {
    if (!ownMethods.has("with")) {
      const freeze = macro.isValue ? "Object.freeze(" : "";
      const freezeEnd = macro.isValue ? ")" : "";
      generatedBlocks.push(
        [
          `${memberIndent}with(patch: Partial<{ ${fieldsTypeInline} }>): ${macro.className} {`,
          `${memberIndent}  return ${freeze}Object.assign(new ${macro.className}(), this, patch)${freezeEnd};`,
          `${memberIndent}}`,
        ].join("\n"),
      );
    }
  }

  if (expandWithBy) {
    for (const f of macro.fields) {
      const wbName = `with${capitalize(f.name)}By`;
      if (ownMethods.has(wbName)) continue;
      generatedBlocks.push(
        `${memberIndent}${wbName}(updater: (current: ${f.typeText}) => ${f.typeText}): ${macro.className} {\n${memberIndent}  return Object.assign(new ${macro.className}(), this, { ${f.name}: updater(this.${f.name}) });\n${memberIndent}}`,
      );
    }
  }

  if (expandToString || expandData || expandValue) {
    if (!ownMethods.has("toString")) {
      const parts = macro.fields
        .filter((f) => !f.toStringExclude)
        .map((f) => (f.isSecret ? `${f.name}=***` : `${f.name}=\${String(this.${f.name})}`))
        .join(", ");
      generatedBlocks.push(
        `${memberIndent}toString(): string {\n${memberIndent}  return \`${macro.className}(${parts})\`;\n${memberIndent}}`,
      );
    }
  }

  if (expandEquals || expandData || expandValue) {
    if (!ownMethods.has("equals")) {
      const checks =
        macro.fields
          .filter((f) => !f.equalsExclude)
          .map((f) => `Object.is(this.${f.name}, other.${f.name})`)
          .join(" && ") || "true";
      generatedBlocks.push(
        [
          `${memberIndent}equals(other: unknown): boolean {`,
          `${memberIndent}  if (this === other) return true;`,
          `${memberIndent}  if (!(other instanceof ${macro.className})) return false;`,
          `${memberIndent}  return ${checks};`,
          `${memberIndent}}`,
        ].join("\n"),
      );
    }
  }

  if (expandJson || expandData || expandValue) {
    if (!ownMethods.has("toJSON")) {
      const pairs = macro.fields
        .filter((f) => !(f.isSecret && f.secretOmitFromJson))
        .map((f) => `${f.name}: this.${f.name}`)
        .join(", ");
      generatedBlocks.push(
        `${memberIndent}toJSON() {\n${memberIndent}  return { ${pairs} };\n${memberIndent}}`,
      );
    }
  }

  if (expandBuilder) {
    const builderSetters = macro.fields
      .map(
        (f) =>
          `${memberIndent}    ${f.name}(value: ${f.typeText}) { data.${f.name} = value; return api; },`,
      )
      .join("\n");
    generatedBlocks.push(
      [
        `${memberIndent}static ${macro.builderMethodName}() {`,
        `${memberIndent}  const data: Partial<${macro.className}> = {};`,
        `${memberIndent}  const api = {`,
        builderSetters,
        `${memberIndent}    ${macro.buildMethodName}(): ${macro.className} { return Object.assign(new ${macro.className}(), data); },`,
        `${memberIndent}  };`,
        `${memberIndent}  return api;`,
        `${memberIndent}}`,
      ].join("\n"),
    );
  }

  // Custom class macros (`defineClassMacro`)
  const customMacroNames = new Set<string>([
    ...(macro.customMacros?.map((c) => c.name) ?? []),
    ...macro.decorators.filter((d) => customMacroMap.has(d)),
  ]);
  for (const customName of customMacroNames) {
    const def = customMacroMap.get(customName);
    if (!def || !shouldExpand(customName)) continue;
    removeDecorator(customName);

    const refOpt = macro.customMacros?.find((c) => c.name === customName)?.options;
    if (typeof def.delombok === "function") {
      const customBlocks = def.delombok({
        className: macro.className,
        fields: macro.fields.map((f) => ({
          name: f.name,
          typeText: f.typeText,
          optional: f.optional,
          isReadonly: f.isReadonly,
        })),
        options: refOpt,
        indent: memberIndent,
      });
      for (const block of customBlocks ?? []) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        generatedBlocks.push(
          block.startsWith(memberIndent)
            ? block
            : indentBlockLines(block, memberIndent),
        );
      }
      continue;
    }

    for (const f of def.fields ?? []) {
      if (ownProps.has(f.name)) continue;
      ownProps.add(f.name);
      const ro = f.readonly ? "readonly " : "";
      const opt = f.optional ? "?" : "";
      const initExpr = formatDelombokDefaultValue(f.defaultValue);
      const initSuffix = initExpr !== undefined ? ` = ${initExpr}` : "";
      generatedBlocks.push(
        `${memberIndent}${ro}${f.name}${opt}: ${f.type}${initSuffix};`,
      );
    }

    for (const [mName, mSpec] of Object.entries(def.methods ?? {})) {
      if (ownMethods.has(mName)) continue;
      ownMethods.add(mName);
      const sig = formatCustomDelombokSignature(mName, mSpec.signature);
      const body = mSpec.delombokBody
        ? indentBlockLines(mSpec.delombokBody, `${memberIndent}  `)
        : `${memberIndent}  throw new Error(${JSON.stringify(`Expanded from @${def.name}()`)});`;
      generatedBlocks.push(
        `${memberIndent}${sig} {\n${body}\n${memberIndent}}`,
      );
    }

    for (const [sName, sSpec] of Object.entries(def.statics ?? {})) {
      const sig = formatCustomDelombokSignature(sName, sSpec.signature);
      const body = sSpec.delombokBody
        ? indentBlockLines(sSpec.delombokBody, `${memberIndent}  `)
        : `${memberIndent}  throw new Error(${JSON.stringify(`Expanded from @${def.name}()`)});`;
      generatedBlocks.push(
        `${memberIndent}static ${sig} {\n${body}\n${memberIndent}}`,
      );
    }
  }

  if (generatedBlocks.length > 0) {
    const closeBracePos = cls.getEnd() - 1;
    s.appendLeft(closeBracePos, `\n${generatedBlocks.join("\n\n")}\n${clsIndent}`);
  }

  return computeSingleFileDiffSpan(
    filePath,
    original,
    s,
    `Expand (Delombok) ${target ? `@${target}` : "class macros"} on ${macro.className}`,
  );
}

// ============================================================================
// 7. 1-Click Collapse Boilerplate `new Logger(...)` -> `@WithLogger()`
// ============================================================================

export function buildCollapseLoggerBoilerplateEdit(options: {
  readonly sourceFile: SourceFile;
  readonly classDecl: ClassDeclaration;
}): MagicEditResult {
  const filePath = options.sourceFile.getFilePath();
  const original = options.sourceFile.getFullText();
  const s = new TextEditor(original);

  const cls = options.classDecl;
  const loggerProp = cls.getProperties().find((p) => {
    const init = p.getInitializer();
    if (!init || !Node.isNewExpression(init)) return false;
    return init.getExpression().getText() === "Logger";
  });

  if (!loggerProp) {
    return { filePath, original, updated: original, changed: false, edits: [] };
  }

  const propName = loggerProp.getName();
  const clsIndent = detectIndent(original, cls.getStart());
  const decText =
    propName === "logger"
      ? `@WithLogger()\n${clsIndent}`
      : `@WithLogger({ propertyName: ${JSON.stringify(propName)} })\n${clsIndent}`;

  // Remove the manual logger field line cleanly
  let propStart = loggerProp.getStart();
  let propEnd = loggerProp.getEnd();
  const lineStart = original.lastIndexOf("\n", Math.max(0, propStart - 1)) + 1;
  if (/^[ \t]*$/.test(original.slice(lineStart, propStart))) {
    propStart = lineStart;
  }
  if (original[propEnd] === "\r") propEnd++;
  if (original[propEnd] === "\n") propEnd++;
  s.remove(propStart, propEnd);

  // Add @WithLogger() above class declaration (or above existing decorators)
  const firstDec = cls.getDecorators()[0];
  const insertPos = firstDec ? firstDec.getStart() : cls.getStart();
  s.prependLeft(insertPos, decText);

  // Ensure WithLogger is imported from @bunest/common
  const commonImp = options.sourceFile
    .getImportDeclarations()
    .find((i) => i.getModuleSpecifierValue() === "@bunest/core");
  if (commonImp) {
    const hasWithLogger = commonImp
      .getNamedImports()
      .some((n) => n.getName() === "WithLogger");
    if (!hasWithLogger) {
      const named = commonImp.getNamedImports();
      const last = named[named.length - 1];
      if (last) s.appendRight(last.getEnd(), ", WithLogger");
    }
  } else {
    s.prepend('import { WithLogger } from "@bunest/core";\n');
  }

  return computeSingleFileDiffSpan(
    filePath,
    original,
    s,
    `Collapse manual Logger property into @WithLogger() on ${cls.getName() ?? "class"}`,
  );
}

// ============================================================================
// 8. Auto-Sync DI Constructor (TypeScript @RequiredArgsConstructor equivalent)
// ============================================================================

export function buildSyncDiConstructorEdit(options: {
  readonly sourceFile: SourceFile;
  readonly classDecl: ClassDeclaration;
}): MagicEditResult {
  const filePath = options.sourceFile.getFilePath();
  const original = options.sourceFile.getFullText();
  const s = new TextEditor(original);

  const cls = options.classDecl;
  // Find readonly non-initialized typed fields that represent DI dependencies
  const candidateProps = cls.getProperties().filter((p) => {
    if (p.isStatic() || p.hasInitializer()) return false;
    const typeNode = p.getTypeNode();
    if (!typeNode) return false;
    const t = typeNode.getText().trim();
    if (/^(?:string|number|boolean|unknown|any|object|bigint|symbol)\b/.test(t)) {
      return false;
    }
    return p.isReadonly() || p.hasExclamationToken();
  });

  if (candidateProps.length === 0) {
    return { filePath, original, updated: original, changed: false, edits: [] };
  }

  const clsIndent = detectIndent(original, cls.getStart());
  const memberIndent = `${clsIndent}  `;
  const ctorParams = candidateProps.map((p) => {
    const modifiers = p
      .getModifiers()
      .map((m) => m.getText())
      .filter((m) => m === "private" || m === "protected" || m === "public");
    const vis = modifiers[0] ?? "private";
    const typeText = p.getTypeNode()!.getText().trim();
    return `${memberIndent}  ${vis} readonly ${p.getName()}: ${typeText},`;
  });

  // Remove the field declarations (moved into parameter properties!)
  for (const p of candidateProps) {
    let start = p.getStart();
    let end = p.getEnd();
    const lineStart = original.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    if (/^[ \t]*$/.test(original.slice(lineStart, start))) {
      start = lineStart;
    }
    if (original[end] === "\r") end++;
    if (original[end] === "\n") end++;
    s.remove(start, end);
  }

  const existingCtor = cls.getConstructors()[0];
  if (existingCtor) {
    const existingParams = existingCtor.getParameters();
    const lastParam = existingParams[existingParams.length - 1];
    if (lastParam) {
      s.appendRight(lastParam.getEnd(), `,\n${ctorParams.join("\n")}`);
    } else {
      const openParen = original.indexOf("(", existingCtor.getStart());
      const closeParen = original.indexOf(")", openParen);
      if (openParen !== -1 && closeParen !== -1) {
        s.overwrite(
          openParen,
          closeParen + 1,
          `(\n${ctorParams.join("\n")}\n${memberIndent})`,
        );
      }
    }
  } else {
    const openBrace = original.indexOf("{", cls.getStart());
    if (openBrace !== -1) {
      s.appendRight(
        openBrace + 1,
        `\n${memberIndent}constructor(\n${ctorParams.join("\n")}\n${memberIndent}) {}\n`,
      );
    }
  }

  return computeSingleFileDiffSpan(
    filePath,
    original,
    s,
    `Auto-sync DI constructor parameters on ${cls.getName() ?? "class"}`,
  );
}
