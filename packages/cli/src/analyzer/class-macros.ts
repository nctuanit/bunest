import type { SourceFile } from "../ast";
import {
  collectCustomMacros,
  type BunestConfigLike,
  type CustomMacroPluginInput,
} from "../config/bunest-config.loader";
import { nodeToLocation } from "../typegen/scanner";
import type {
  ExtractedClassMacroEntry,
  ExtractedMacroAccessors,
  SourceLocation,
} from "../typegen/types";
import { findClosestMatch } from "./repository-query";

export interface ResolveClassMacroMembersOptions {
  readonly bunestConfig?: BunestConfigLike;
  readonly customMacros?: readonly CustomMacroPluginInput[];
  readonly presets?: Readonly<Record<string, readonly string[]>>;
}

export interface GeneratedMacroMember {
  readonly kind: "instance" | "static" | "builder";
  readonly name: string;
  readonly signature: string;
  readonly sourceDecorator: string;
}

export interface ClassMacroDiagnostic {
  readonly code:
    | "BUNEST_MACRO001"
    | "BUNEST_MACRO002"
    | "BUNEST_MACRO003"
    | "BUNEST_MACRO004"
    | "BUNEST_MACRO005";
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly location: SourceLocation;
  readonly fixData?: {
    readonly kind: "replaceFieldName";
    readonly replacement: string;
  };
}

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function stripAccessorPrefix(
  fieldName: string,
  accessors?: ExtractedMacroAccessors,
): string {
  for (const prefix of accessors?.prefix ?? []) {
    if (
      prefix &&
      fieldName.startsWith(prefix) &&
      fieldName.length > prefix.length
    ) {
      const rest = fieldName.slice(prefix.length);
      return rest[0]!.toLowerCase() + rest.slice(1);
    }
  }
  return fieldName;
}

function singularize(name: string): string {
  if (name.endsWith("ies") && name.length > 3) return `${name.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|ses)$/i.test(name) && name.length > 3) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss") && name.length > 1) {
    return name.slice(0, -1);
  }
  return name;
}

function formatCustomSig(name: string, raw: string): string {
  const trimmed = raw.trim().replace(/;+$/, "");
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
    trimmed.startsWith(`${name}<`) ||
    trimmed.startsWith(`${name}:`) ||
    trimmed.startsWith(`${name}?:`) ||
    trimmed.startsWith("static ") ||
    trimmed.startsWith("readonly ")
  ) {
    return trimmed;
  }
  if (/^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(trimmed)) {
    return trimmed;
  }
  return `${name}: ${trimmed}`;
}

/**
 * Computes every member synthesized at runtime + typegen time for a macro-decorated class
 * (powers IntelliJ-style Hover preview tables and CodeLens counts in VS Code),
 * including custom macros (`defineClassMacro`) and macro presets.
 */
export function resolveClassMacroMembers(
  rawEntry: ExtractedClassMacroEntry,
  options: ResolveClassMacroMembersOptions = {},
): GeneratedMacroMember[] {
  const customMacroMap = collectCustomMacros(
    options.bunestConfig,
    options.customMacros,
  );
  const presets: Record<string, readonly string[]> = {
    ...(options.bunestConfig?.macros?.presets ?? {}),
    ...(options.presets ?? {}),
  };

  // Expand any presets present on `rawEntry.decorators` in case entry was constructed manually
  const expandedNames = new Set<string>(rawEntry.decorators);
  const visited = new Set<string>();
  const visitName = (n: string): void => {
    if (visited.has(n)) return;
    visited.add(n);
    expandedNames.add(n);
    for (const sub of presets[n] ?? []) visitName(sub);
    const customDef = customMacroMap.get(n);
    for (const sub of customDef?.composedNames ?? []) visitName(sub);
  };
  for (const d of rawEntry.decorators) visitName(d);

  const entry: ExtractedClassMacroEntry = {
    ...rawEntry,
    isData: rawEntry.isData || expandedNames.has("Data"),
    isValue: rawEntry.isValue || expandedNames.has("Value"),
    isBuilder: rawEntry.isBuilder || expandedNames.has("Builder"),
    isSuperBuilder: rawEntry.isSuperBuilder || expandedNames.has("SuperBuilder"),
    isGetter: rawEntry.isGetter || expandedNames.has("Getter"),
    isSetter: rawEntry.isSetter || expandedNames.has("Setter"),
    isWith: rawEntry.isWith || expandedNames.has("With"),
    isWithBy: rawEntry.isWithBy || expandedNames.has("WithBy"),
    isToString: rawEntry.isToString || expandedNames.has("ToString"),
    isEqualsAndHashCode:
      rawEntry.isEqualsAndHashCode || expandedNames.has("EqualsAndHashCode"),
    isJsonSerializable:
      rawEntry.isJsonSerializable || expandedNames.has("JsonSerializable"),
    isFieldNameConstants:
      rawEntry.isFieldNameConstants || expandedNames.has("FieldNameConstants"),
    isWithLogger: rawEntry.isWithLogger || expandedNames.has("WithLogger"),
    isStandardException:
      rawEntry.isStandardException || expandedNames.has("StandardException"),
    isUtilityClass:
      rawEntry.isUtilityClass || expandedNames.has("UtilityClass"),
  };

  const members: GeneratedMacroMember[] = [];
  const ownMethods = new Set(entry.ownMethodNames);
  const ownProps = new Set(entry.ownPropertyNames);
  const seenInstance = new Set<string>();
  const seenStatic = new Set<string>();
  const seenBuilder = new Set<string>();

  const addInstance = (
    name: string,
    signature: string,
    sourceDecorator: string,
  ): void => {
    if (ownMethods.has(name) || seenInstance.has(name)) return;
    seenInstance.add(name);
    members.push({ kind: "instance", name, signature, sourceDecorator });
  };

  if (entry.isBaseEntity && entry.baseEntityFields) {
    const label = entry.baseEntityKeyType
      ? `@BaseEntity<${entry.baseEntityKeyType}>`
      : "@BaseEntity";
    for (const bf of entry.baseEntityFields) {
      if (!ownProps.has(bf.name) && !seenInstance.has(bf.name)) {
        seenInstance.add(bf.name);
        members.push({
          kind: "instance",
          name: bf.name,
          signature: `${bf.name}${bf.optional ? "?" : ""}: ${bf.typeText}`,
          sourceDecorator: label,
        });
      }
    }
  }

  if (entry.isWithLogger && !ownProps.has(entry.loggerPropertyName)) {
    seenInstance.add(entry.loggerPropertyName);
    members.push({
      kind: "instance",
      name: entry.loggerPropertyName,
      signature: `readonly ${entry.loggerPropertyName}: Logger`,
      sourceDecorator: "@WithLogger",
    });
  }

  const wantsGetters =
    entry.isGetter ||
    entry.isValue ||
    (entry.isData && entry.accessorsEnabled);
  const wantsSetters =
    !entry.isValue &&
    (entry.isSetter || (entry.isData && entry.accessorsEnabled));
  const wantsWith = entry.isWith || entry.isData || entry.isValue;
  const wantsWithBy = entry.isWithBy;
  const fluent = entry.accessors.fluent === true;
  const chain = entry.accessors.chain !== false;

  for (const field of entry.fields) {
    const clean = stripAccessorPrefix(field.name, entry.accessors);
    const valType = field.optional
      ? `${field.typeText} | undefined`
      : field.typeText;

    if (wantsGetters || field.hasGetter) {
      const gName = fluent ? clean : `get${capitalize(clean)}`;
      addInstance(
        gName,
        `${gName}(): ${valType}`,
        entry.isData ? "@Data" : entry.isValue ? "@Value" : "@Getter",
      );
    }
    if (!entry.isValue && (wantsSetters || field.hasSetter)) {
      const sName = fluent ? clean : `set${capitalize(clean)}`;
      addInstance(
        sName,
        `${sName}(value: ${valType}): ${chain ? "this" : "void"}`,
        entry.isData ? "@Data" : "@Setter",
      );
    }
    if (wantsWith || field.hasWith) {
      const wName = `with${capitalize(field.name)}`;
      addInstance(
        wName,
        `${wName}(value: ${valType}): ${entry.className}`,
        entry.isData ? "@Data" : entry.isValue ? "@Value" : "@With",
      );
    }
    if (wantsWithBy || field.hasWithBy) {
      const wbName = `with${capitalize(field.name)}By`;
      addInstance(
        wbName,
        `${wbName}(updater: (current: ${valType}) => ${valType}): ${entry.className}`,
        "@WithBy",
      );
    }
  }

  if (wantsWith) {
    addInstance(
      "with",
      `with(patch: Partial<${entry.className}>): ${entry.className}`,
      entry.isData ? "@Data" : entry.isValue ? "@Value" : "@With",
    );
  }
  if (entry.isEqualsAndHashCode || entry.isData || entry.isValue) {
    const src = entry.isData
      ? "@Data"
      : entry.isValue
        ? "@Value"
        : "@EqualsAndHashCode";
    addInstance("equals", "equals(other: unknown): boolean", src);
    addInstance("hashCode", "hashCode(): number", src);
  }
  if (entry.isToString || entry.isData || entry.isValue) {
    addInstance(
      "toString",
      "toString(): string",
      entry.isData ? "@Data" : entry.isValue ? "@Value" : "@ToString",
    );
  }
  if (entry.isJsonSerializable || entry.isData || entry.isValue) {
    const src = entry.isData
      ? "@Data"
      : entry.isValue
        ? "@Value"
        : "@JsonSerializable";
    addInstance("toJSON", `toJSON(): Record<string, unknown>`, src);
    members.push({
      kind: "static",
      name: "fromJSON",
      signature: `static fromJSON(raw: string | Record<string, unknown>): ${entry.className}`,
      sourceDecorator: src,
    });
  }
  if (entry.isData || entry.isValue) {
    const src = entry.isData ? "@Data" : "@Value";
    addInstance("clone", `clone(): ${entry.className}`, src);
    members.push({
      kind: "static",
      name: "of",
      signature: `static of(props: ...): ${entry.className}`,
      sourceDecorator: src,
    });
    members.push({
      kind: "static",
      name: "from",
      signature: `static from(source: Partial<...>): ${entry.className}`,
      sourceDecorator: src,
    });
  }

  for (const del of entry.delegates) {
    for (const mem of del.members) {
      addInstance(
        mem.name,
        `${mem.name}${mem.signatureText}`,
        `@Delegate(${del.propertyName})`,
      );
    }
  }

  if (entry.isBuilder || entry.isSuperBuilder) {
    const src = entry.isSuperBuilder ? "@SuperBuilder" : "@Builder";
    members.push({
      kind: "static",
      name: entry.builderMethodName,
      signature: `static ${entry.builderMethodName}(): ${entry.className}Builder`,
      sourceDecorator: src,
    });
    if (entry.toBuilder) {
      addInstance(
        "toBuilder",
        `toBuilder(): ${entry.className}Builder`,
        src,
      );
    }
    const prefix = entry.setterPrefix;
    for (const field of entry.fields) {
      const setter = prefix
        ? `${prefix}${capitalize(field.name)}`
        : field.name;
      if (field.isSingular) {
        const sBase = field.singularName ?? singularize(field.name);
        const sMethod = prefix ? `${prefix}${capitalize(sBase)}` : sBase;
        members.push({
          kind: "builder",
          name: sMethod,
          signature:
            field.collectionKind === "map"
              ? `${sMethod}(key: ${field.collectionKeyTypeText ?? "unknown"}, value: ${field.collectionValueTypeText ?? "unknown"}): this`
              : `${sMethod}(item: ${field.collectionItemTypeText ?? "unknown"}): this`,
          sourceDecorator: "@Singular",
        });
        members.push({
          kind: "builder",
          name: `clear${capitalize(field.name)}`,
          signature: `clear${capitalize(field.name)}(): this`,
          sourceDecorator: "@Singular",
        });
      }
      members.push({
        kind: "builder",
        name: setter,
        signature: `${setter}(value: ${field.typeText}): this`,
        sourceDecorator: src,
      });
    }
    members.push({
      kind: "builder",
      name: entry.buildMethodName,
      signature: `${entry.buildMethodName}(): ${entry.className}`,
      sourceDecorator: src,
    });
  }

  if (entry.isFieldNameConstants) {
    members.push({
      kind: "static",
      name: entry.fieldConstantsInnerName,
      signature: `static readonly ${entry.fieldConstantsInnerName}: { ${entry.fields.map((f) => `${f.name}: "${f.name}"`).join("; ")} }`,
      sourceDecorator: "@FieldNameConstants",
    });
  }

  if (entry.isStandardException) {
    seenStatic.add("from");
    members.push({
      kind: "static",
      name: "from",
      signature: `static from(message: string, cause?: unknown): ${entry.className}`,
      sourceDecorator: "@StandardException",
    });
  }

  // Emit custom macro members (pre-scanned on entry OR resolved dynamically from registry/config)
  const addCustomMember = (
    kind: "instance" | "static" | "builder",
    name: string,
    signature: string,
    sourceDecorator: string,
  ): void => {
    if (kind === "instance") {
      const isMethod = /^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(signature);
      if (isMethod) {
        addInstance(name, signature, sourceDecorator);
      } else if (!ownProps.has(name) && !seenInstance.has(name)) {
        seenInstance.add(name);
        members.push({ kind: "instance", name, signature, sourceDecorator });
      }
    } else if (kind === "static") {
      if (seenStatic.has(name)) return;
      seenStatic.add(name);
      const sig = signature.startsWith("static ")
        ? signature
        : `static ${signature}`;
      members.push({ kind: "static", name, signature: sig, sourceDecorator });
    } else {
      if (seenBuilder.has(name)) return;
      seenBuilder.add(name);
      members.push({ kind: "builder", name, signature, sourceDecorator });
    }
  };

  for (const cm of entry.customMembers ?? []) {
    addCustomMember(cm.kind, cm.name, cm.signature, cm.sourceDecorator);
  }

  for (const decName of expandedNames) {
    const def = customMacroMap.get(decName);
    if (!def) continue;
    const src = `@${def.name}`;
    for (const f of def.fields ?? []) {
      const sig = `${f.readonly ? "readonly " : ""}${f.name}${f.optional ? "?" : ""}: ${f.type}`;
      addCustomMember("instance", f.name, sig, src);
    }
    for (const [mName, mSpec] of Object.entries(def.methods ?? {})) {
      addCustomMember(
        "instance",
        mName,
        formatCustomSig(mName, mSpec.signature),
        src,
      );
    }
    for (const [sName, sSpec] of Object.entries(def.statics ?? {})) {
      addCustomMember(
        "static",
        sName,
        formatCustomSig(sName, sSpec.signature),
        src,
      );
    }
    if (typeof def.typegen === "function") {
      try {
        const refOpt = entry.customMacros?.find(
          (r) => r.name === def.name,
        )?.options;
        const generated = def.typegen({
          className: entry.className,
          fields: entry.fields.map((f) => ({
            name: f.name,
            typeText: f.typeText,
            optional: f.optional,
            isReadonly: f.isReadonly,
          })),
          options: refOpt,
          decorators: entry.decorators,
        });
        for (const g of generated ?? []) {
          if (!g || !g.name || !g.signature) continue;
          addCustomMember(
            g.kind,
            g.name,
            formatCustomSig(g.name, g.signature),
            g.sourceDecorator ?? src,
          );
        }
      } catch {
        // Ignore user hook errors during hover preview
      }
    }
  }

  return members;
}

/**
 * Evaluates all 5 Class Macro static diagnostics (`BUNEST_MACRO001`–`BUNEST_MACRO005`).
 */
export function runClassMacroDiagnostics(
  macros: readonly ExtractedClassMacroEntry[],
  sourceFiles: readonly SourceFile[],
): ClassMacroDiagnostic[] {
  const diagnostics: ClassMacroDiagnostic[] = [];
  const sfByPath = new Map<string, SourceFile>();
  for (const sf of sourceFiles) {
    sfByPath.set(sf.getFilePath(), sf);
  }

  for (const entry of macros) {
    const fieldNames = entry.fields.map((f) => f.name);
    const fieldNameSet = new Set(fieldNames);

    // BUNEST_MACRO001: Unknown field in exclude/include/mask
    for (const ref of entry.fieldReferences) {
      if (!fieldNameSet.has(ref.fieldName)) {
        const suggestion = findClosestMatch(ref.fieldName, fieldNames);
        const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
        diagnostics.push({
          code: "BUNEST_MACRO001",
          severity: "error",
          message: `@${ref.decoratorName}({ ${ref.optionName}: ["${ref.fieldName}"] }) references unknown field "${ref.fieldName}" on "${entry.className}".${hint}`,
          location: ref.location,
          ...(suggestion
            ? {
                fixData: {
                  kind: "replaceFieldName" as const,
                  replacement: JSON.stringify(suggestion),
                },
              }
            : {}),
        });
      }
    }

    // BUNEST_MACRO002: Conflicting decorators (@Value + @Setter, or @UtilityClass with instance members)
    if (entry.isValue && (entry.isSetter || entry.fields.some((f) => f.hasSetter))) {
      diagnostics.push({
        code: "BUNEST_MACRO002",
        severity: "error",
        message: `"${entry.className}" combines immutable @Value() with @Setter(). Remove @Setter() or use @Data() instead.`,
        location: entry.location,
      });
    }

    if (entry.isUtilityClass) {
      const sf = sfByPath.get(entry.sourceFile);
      const cls = sf?.getClass(entry.className);
      if (cls) {
        for (const m of cls.getMethods()) {
          if (!m.isStatic()) {
            diagnostics.push({
              code: "BUNEST_MACRO002",
              severity: "warning",
              message: `@UtilityClass() "${entry.className}" declares non-static method "${m.getName()}()". Mark it static.`,
              location: nodeToLocation(m.getNameNode()),
            });
          }
        }
        for (const p of cls.getProperties()) {
          if (!p.isStatic()) {
            diagnostics.push({
              code: "BUNEST_MACRO002",
              severity: "warning",
              message: `@UtilityClass() "${entry.className}" declares non-static property "${p.getName()}". Mark it static.`,
              location: nodeToLocation(p.getNameNode()),
            });
          }
        }
      }
    }

    // BUNEST_MACRO003: @WithLogger() shadowing existing property
    if (
      entry.isWithLogger &&
      entry.ownPropertyNames.includes(entry.loggerPropertyName)
    ) {
      diagnostics.push({
        code: "BUNEST_MACRO003",
        severity: "warning",
        message: `@WithLogger() on "${entry.className}" is shadowed by an existing "${entry.loggerPropertyName}" property. Remove the manual property or set a custom propertyName.`,
        location: entry.location,
      });
    }

    // BUNEST_MACRO004: @Singular() on non-collection property
    for (const f of entry.fields) {
      if (f.isSingular && !f.inherited && !f.collectionKind) {
        diagnostics.push({
          code: "BUNEST_MACRO004",
          severity: "error",
          message: `@Singular() on "${entry.className}.${f.name}" requires an Array, Set, or Map type (found "${f.typeText}").`,
          location: f.location,
        });
      }
    }

    // BUNEST_MACRO005: @Delegate() on primitive or unresolved type
    for (const del of entry.delegates) {
      if (!del.resolved) {
        diagnostics.push({
          code: "BUNEST_MACRO005",
          severity: "warning",
          message: `@Delegate() on "${entry.className}.${del.propertyName}" could not resolve any callable methods from type "${del.targetTypeName}".`,
          location: del.location,
        });
      }
    }
  }

  return diagnostics;
}
