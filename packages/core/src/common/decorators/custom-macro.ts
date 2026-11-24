import {
  MACRO_DECORATOR_NAME_SYM,
  collectKnownFieldNames,
  defineMacroMemberIfAbsent,
  getOrCreateClassMacroConfig,
  readGlobalMacroDefaults,
  reinstallClassMacrosForFields,
  tagMacroDecorator,
  updateMacroFieldConfig,
  type GlobalMacroDefaults,
} from "./class-macros.decorators";

// ============================================================================
// Single-Realm Global Custom Macro Registry
// ============================================================================

/**
 * Single-realm `globalThis` symbol backing the custom class macro registry so
 * `@bunest/core`, `@bunest/cli` (typegen / analyzer / delombok), and workspace
 * bundle chunks share one unified registry.
 */
export const CUSTOM_MACROS_REGISTRY_SYMBOL: symbol = Symbol.for(
  "bunest:custom_macros:registry",
);

// ============================================================================
// Public Custom Macro Interfaces
// ============================================================================

export interface CustomMacroFieldSpec {
  readonly name: string;
  readonly type: string;
  readonly optional?: boolean;
  readonly readonly?: boolean;
  /**
   * Default value or zero-arg factory `() => value` initialized per instance
   * without breaking plain `new Class()` construction, `of()`, `from()`, or `builder().build()`.
   */
  readonly defaultValue?: unknown;
}

export interface CustomMacroMethodSpec<TOptions = void> {
  /**
   * TypeScript method signature used by typegen & IDE Hover/CodeLens, e.g.
   * `"(by?: string): this"` or `"touch(by?: string): this"`.
   */
  readonly signature: string;
  /** Runtime method implementation receiving the class instance as `self`. */
  readonly impl: (self: any, ...args: any[]) => any;
  /** Optional explicit method body statements used by Delombok expansion. */
  readonly delombokBody?: string;
  /** Optional predicate controlling whether this method is installed for given options. */
  readonly when?: (options: TOptions) => boolean;
  readonly description?: string;
}

export interface CustomMacroStaticSpec<TOptions = void> {
  /**
   * TypeScript static member signature used by typegen & IDE Hover/CodeLens, e.g.
   * `"(): readonly string[]"` or `"static auditFields(): readonly string[]"`.
   */
  readonly signature: string;
  /** Runtime static method implementation. */
  readonly impl: (...args: any[]) => any;
  /** Optional explicit static method body statements used by Delombok expansion. */
  readonly delombokBody?: string;
  /** Optional predicate controlling whether this static member is installed for given options. */
  readonly when?: (options: TOptions) => boolean;
  readonly description?: string;
}

export interface CustomMacroApplyContext<TOptions = void> {
  readonly target: Function;
  readonly options: TOptions;
  readonly fields: readonly string[];
  readonly defaults: GlobalMacroDefaults;
}

export interface CustomMacroGeneratedMember {
  readonly kind: "instance" | "static" | "builder";
  readonly name: string;
  readonly signature: string;
  readonly sourceDecorator?: string;
}

export interface CustomMacroTypegenFieldInfo {
  readonly name: string;
  readonly typeText: string;
  readonly optional?: boolean;
  readonly isReadonly?: boolean;
}

export interface CustomMacroTypegenContext<TOptions = void> {
  readonly className: string;
  readonly options: TOptions;
  readonly fields: readonly CustomMacroTypegenFieldInfo[];
  readonly ownMethodNames?: readonly string[];
  readonly ownPropertyNames?: readonly string[];
  readonly sourceFile?: string;
  readonly defaults?: GlobalMacroDefaults;
}

export interface CustomMacroDelombokContext<TOptions = void> {
  readonly className: string;
  readonly options: TOptions;
  readonly fields: readonly CustomMacroTypegenFieldInfo[];
  readonly indent?: string;
  readonly ownMethodNames?: readonly string[];
  readonly ownPropertyNames?: readonly string[];
  readonly defaults?: GlobalMacroDefaults;
}

/**
 * Single-source definition for a user-extensible Bunest Class Macro or Macro Preset.
 * Drives runtime behavior, `.d.ts` typegen, IDE Hover/CodeLens, and Delombok code generation.
 */
export interface CustomMacroDefinition<TOptions = void> {
  readonly name: string;
  readonly description?: string;
  /** Composes built-in or other custom class decorators (e.g. for macro presets). */
  readonly compose?: (options: TOptions) => readonly ClassDecorator[];
  /**
   * Optional static names of composed macros (e.g. `["Data", "Builder", "FieldNameConstants"]`)
   * so CLI typegen, analyzer, Delombok, and VS Code can statically expand presets.
   */
  readonly composedNames?: readonly string[];
  /** Fields injected and default-initialized by this macro. */
  readonly fields?: readonly CustomMacroFieldSpec[];
  /** Instance methods attached to `target.prototype` (respecting `@Tolerate` non-override). */
  readonly methods?: Readonly<Record<string, CustomMacroMethodSpec<TOptions>>>;
  /** Static methods attached to `target` constructor (respecting `@Tolerate` non-override). */
  readonly statics?: Readonly<Record<string, CustomMacroStaticSpec<TOptions>>>;
  /** Arbitrary runtime hook executed after composed decorators, fields, methods, and statics. */
  readonly apply?: (ctx: CustomMacroApplyContext<TOptions>) => void;
  /** Optional dynamic typegen member generator for advanced macro signatures. */
  readonly typegen?: (
    ctx: CustomMacroTypegenContext<TOptions>,
  ) => readonly CustomMacroGeneratedMember[];
  /** Optional custom Delombok member block generator. */
  readonly delombok?: (
    ctx: CustomMacroDelombokContext<TOptions>,
  ) => readonly string[];
}

export type CustomMacroDecorator<TOptions = void> = ((
  options?: TOptions,
) => ClassDecorator) & {
  readonly macroDefinition: CustomMacroDefinition<TOptions>;
  readonly macroName: string;
};

// ============================================================================
// Registry Helpers
// ============================================================================

function getRegistryMap(): Map<string, CustomMacroDefinition<any>> {
  const host = globalThis as Record<
    symbol,
    Map<string, CustomMacroDefinition<any>> | undefined
  >;
  let registry = host[CUSTOM_MACROS_REGISTRY_SYMBOL];
  if (!registry) {
    registry = new Map<string, CustomMacroDefinition<any>>();
    host[CUSTOM_MACROS_REGISTRY_SYMBOL] = registry;
  }
  return registry;
}

/**
 * Registers a custom class macro definition in the global single-realm registry.
 */
export function registerCustomMacro<TOptions = void>(
  def: CustomMacroDefinition<TOptions>,
): CustomMacroDefinition<TOptions> {
  if (!def || typeof def.name !== "string" || def.name.trim().length === 0) {
    throw new TypeError(
      "CustomMacroDefinition.name must be a non-empty string.",
    );
  }
  getRegistryMap().set(def.name, def as CustomMacroDefinition<any>);
  return def;
}

/**
 * Removes a custom class macro definition from the global registry by name.
 */
export function unregisterCustomMacro(name: string): boolean {
  return getRegistryMap().delete(name);
}

/**
 * Looks up a registered custom class macro definition by name.
 */
export function getCustomMacro<TOptions = any>(
  name: string,
): CustomMacroDefinition<TOptions> | undefined {
  return getRegistryMap().get(name) as
    | CustomMacroDefinition<TOptions>
    | undefined;
}

/**
 * Lists all registered custom class macro definitions in insertion order.
 */
export function listCustomMacros(): readonly CustomMacroDefinition<any>[] {
  return [...getRegistryMap().values()];
}

/**
 * Clears all custom class macro definitions from the global registry.
 */
export function clearCustomMacros(): void {
  getRegistryMap().clear();
}

// ============================================================================
// Field & Member Installation Internals
// ============================================================================

function installCustomMacroFields(
  target: Function,
  fields: readonly CustomMacroFieldSpec[],
): void {
  if (fields.length === 0) return;

  const cfg = getOrCreateClassMacroConfig(target);
  const nextNames: string[] = [];

  for (const field of fields) {
    if (!field.name) continue;
    nextNames.push(field.name);

    const hasDefault =
      Object.prototype.hasOwnProperty.call(field, "defaultValue") &&
      field.defaultValue !== undefined;

    if (hasDefault || field.readonly) {
      updateMacroFieldConfig(target, field.name, {
        ...(hasDefault
          ? { builderDefault: { hasDefault: true, value: field.defaultValue } }
          : {}),
        ...(field.readonly ? { macroReadonly: true } : {}),
      });
    }

    if (hasDefault) {
      const defaultSpec = field.defaultValue;
      const isReadonly = field.readonly === true;
      const fieldName = field.name;
      const evalDefault = (): unknown =>
        typeof defaultSpec === "function"
          ? (defaultSpec as () => unknown)()
          : defaultSpec;

      // Lazy prototype getter/setter initializes default values on plain `new Class()`
      // without wrapping or altering the class constructor, while honoring initial
      // assignments (e.g. `of()`, `from()`, `builder().build()`, constructor body).
      defineMacroMemberIfAbsent(target.prototype, fieldName, {
        enumerable: false,
        configurable: true,
        get(this: Record<string, unknown>) {
          if (this === target.prototype) {
            return undefined;
          }
          const value = evalDefault();
          if (Object.isExtensible(this)) {
            Object.defineProperty(this, fieldName, {
              value,
              enumerable: true,
              configurable: true,
              writable: !isReadonly,
            });
          }
          return value;
        },
        set(this: Record<string, unknown>, nextValue: unknown) {
          if (this === target.prototype) {
            return;
          }
          Object.defineProperty(this, fieldName, {
            value: nextValue,
            enumerable: true,
            configurable: true,
            writable: !isReadonly,
          });
        },
      });
    }
  }

  if (nextNames.length > 0) {
    cfg.explicitFields = [
      ...new Set([...(cfg.explicitFields ?? []), ...nextNames]),
    ];
  }
}

function inferComposedNames(
  decorators: readonly ClassDecorator[],
): string[] | undefined {
  const names: string[] = [];
  for (const dec of decorators) {
    const tag = (dec as unknown as Record<symbol, unknown>)[
      MACRO_DECORATOR_NAME_SYM
    ];
    if (typeof tag === "string" && tag.length > 0) {
      names.push(tag);
    }
  }
  return names.length > 0 ? names : undefined;
}

// ============================================================================
// Single-Source Typegen & Delombok Helpers
// ============================================================================

function formatMethodSignature(name: string, rawSignature: string): string {
  const trimmed = rawSignature.trim();
  if (
    trimmed.startsWith(`${name}(`) ||
    trimmed.startsWith(`${name}<`) ||
    trimmed.startsWith(`${name}:`) ||
    trimmed.startsWith(`${name} `)
  ) {
    return trimmed;
  }
  return `${name}${trimmed}`;
}

function formatStaticSignature(name: string, rawSignature: string): string {
  const trimmed = rawSignature.trim();
  if (trimmed.startsWith("static ")) {
    return trimmed;
  }
  return `static ${formatMethodSignature(name, trimmed)}`;
}

function formatDelombokDefaultValue(value: unknown): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return JSON.stringify(value);
  }
  return undefined;
}

function indentMultilineBody(body: string, innerIndent: string): string {
  return body
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `${innerIndent}${line}`))
    .join("\n");
}

/**
 * Collects all TypeScript members synthesized by a `CustomMacroDefinition` from its
 * declarative `fields`, `methods`, `statics`, and optional dynamic `typegen(ctx)` hook.
 */
export function collectCustomMacroTypegenMembers<TOptions = any>(
  def: CustomMacroDefinition<TOptions>,
  ctx: CustomMacroTypegenContext<TOptions>,
): CustomMacroGeneratedMember[] {
  const members: CustomMacroGeneratedMember[] = [];
  const seen = new Set<string>();
  const sourceDecorator = `@${def.name}`;
  const ownMethods = new Set(ctx.ownMethodNames ?? []);
  const ownProps = new Set(ctx.ownPropertyNames ?? []);

  const pushUnique = (member: CustomMacroGeneratedMember): void => {
    const key = `${member.kind}:${member.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    members.push({
      ...member,
      sourceDecorator: member.sourceDecorator ?? sourceDecorator,
    });
  };

  for (const field of def.fields ?? []) {
    if (!field.name || ownProps.has(field.name)) continue;
    const ro = field.readonly ? "readonly " : "";
    const opt = field.optional ? "?" : "";
    pushUnique({
      kind: "instance",
      name: field.name,
      signature: `${ro}${field.name}${opt}: ${field.type}`,
      sourceDecorator,
    });
  }

  for (const [methodName, spec] of Object.entries(def.methods ?? {})) {
    if (ownMethods.has(methodName)) continue;
    if (spec.when && !spec.when(ctx.options)) continue;
    pushUnique({
      kind: "instance",
      name: methodName,
      signature: formatMethodSignature(methodName, spec.signature),
      sourceDecorator,
    });
  }

  for (const [staticName, spec] of Object.entries(def.statics ?? {})) {
    if (spec.when && !spec.when(ctx.options)) continue;
    pushUnique({
      kind: "static",
      name: staticName,
      signature: formatStaticSignature(staticName, spec.signature),
      sourceDecorator,
    });
  }

  if (def.typegen) {
    for (const generated of def.typegen(ctx) ?? []) {
      pushUnique(generated);
    }
  }

  return members;
}

/**
 * Collects all Delombok source code blocks synthesized by a `CustomMacroDefinition`
 * from its declarative `fields`, `methods`, `statics`, and optional `delombok(ctx)` hook.
 */
export function collectCustomMacroDelombokBlocks<TOptions = any>(
  def: CustomMacroDefinition<TOptions>,
  ctx: CustomMacroDelombokContext<TOptions>,
): string[] {
  const blocks: string[] = [];
  const indent = ctx.indent ?? "  ";
  const innerIndent = `${indent}  `;
  const ownMethods = new Set(ctx.ownMethodNames ?? []);
  const ownProps = new Set(ctx.ownPropertyNames ?? []);

  for (const field of def.fields ?? []) {
    if (!field.name || ownProps.has(field.name)) continue;
    const ro = field.readonly ? "readonly " : "";
    const opt = field.optional ? "?" : "";
    const literalInit =
      Object.prototype.hasOwnProperty.call(field, "defaultValue") &&
      field.defaultValue !== undefined
        ? formatDelombokDefaultValue(field.defaultValue)
        : undefined;
    const initClause = literalInit !== undefined ? ` = ${literalInit}` : "";
    blocks.push(`${indent}${ro}${field.name}${opt}: ${field.type}${initClause};`);
  }

  for (const [methodName, spec] of Object.entries(def.methods ?? {})) {
    if (ownMethods.has(methodName)) continue;
    if (spec.when && !spec.when(ctx.options)) continue;
    const header = formatMethodSignature(methodName, spec.signature);
    const body = spec.delombokBody
      ? indentMultilineBody(spec.delombokBody, innerIndent)
      : `${innerIndent}throw new Error(${JSON.stringify(`Method "${methodName}" generated by @${def.name}`)});`;
    blocks.push(`${indent}${header} {\n${body}\n${indent}}`);
  }

  for (const [staticName, spec] of Object.entries(def.statics ?? {})) {
    if (spec.when && !spec.when(ctx.options)) continue;
    const header = formatStaticSignature(staticName, spec.signature);
    const body = spec.delombokBody
      ? indentMultilineBody(spec.delombokBody, innerIndent)
      : `${innerIndent}throw new Error(${JSON.stringify(`Static method "${staticName}" generated by @${def.name}`)});`;
    blocks.push(`${indent}${header} {\n${body}\n${indent}}`);
  }

  if (def.delombok) {
    for (const block of def.delombok(ctx) ?? []) {
      blocks.push(block);
    }
  }

  return blocks;
}

// ============================================================================
// Public Macro & Preset Factories + Compile-Time Field Registration
// ============================================================================

/**
 * Defines a reusable, single-source Bunest Class Macro, registers it in the global
 * `bunest:custom_macros:registry`, and returns a typed class decorator factory.
 */
export function defineClassMacro<TOptions = void>(
  def: CustomMacroDefinition<TOptions>,
): CustomMacroDecorator<TOptions> {
  registerCustomMacro(def);

  const factory = function customMacroFactory(
    options?: TOptions,
  ): ClassDecorator {
    const resolvedOptions = options as TOptions;

    return tagMacroDecorator(
      <TFunction extends Function>(target: TFunction): TFunction | void => {
        const cfg = getOrCreateClassMacroConfig(target);
        cfg.customMacros = [
          ...(cfg.customMacros ?? []),
          { name: def.name, options: resolvedOptions },
        ];

        // 1. Install macro-declared fields BEFORE composed macros so composed
        //    `@Data`/`@Builder`/`@FieldNameConstants` immediately include them.
        if (def.fields && def.fields.length > 0) {
          installCustomMacroFields(target, def.fields);
        }

        // 2. Apply composed decorators bottom-to-top (matching TS stacking order).
        let currentTarget: Function = target;
        if (def.compose) {
          const composed = def.compose(resolvedOptions) ?? [];
          for (let i = composed.length - 1; i >= 0; i--) {
            const dec = composed[i];
            const result = dec?.(currentTarget);
            if (typeof result === "function") {
              currentTarget = result;
            }
          }
        }

        // 3. Install instance methods onto prototype (`@Tolerate` non-override).
        if (def.methods) {
          for (const [methodName, spec] of Object.entries(def.methods)) {
            if (spec.when && !spec.when(resolvedOptions)) continue;
            defineMacroMemberIfAbsent(currentTarget.prototype, methodName, {
              enumerable: false,
              configurable: true,
              writable: true,
              value: function (this: unknown, ...args: unknown[]) {
                return spec.impl(this, ...args);
              },
            });
          }
        }

        // 4. Install static methods onto constructor (`@Tolerate` non-override).
        if (def.statics) {
          for (const [staticName, spec] of Object.entries(def.statics)) {
            if (spec.when && !spec.when(resolvedOptions)) continue;
            defineMacroMemberIfAbsent(currentTarget, staticName, {
              enumerable: false,
              configurable: true,
              writable: true,
              value: function (this: unknown, ...args: unknown[]) {
                return spec.impl.apply(this, args);
              },
            });
          }
        }

        // 5. Re-install any built-in field macros that ran underneath this custom macro
        //    so newly added macro fields receive getters/setters/withers/constants too.
        if (def.fields && def.fields.length > 0) {
          reinstallClassMacrosForFields(currentTarget);
        }

        // 6. Execute arbitrary runtime hook.
        if (def.apply) {
          def.apply({
            target: currentTarget,
            options: resolvedOptions,
            fields: collectKnownFieldNames(currentTarget),
            defaults: readGlobalMacroDefaults(),
          });
        }

        return currentTarget !== target
          ? (currentTarget as TFunction)
          : undefined;
      },
      def.name,
    );
  };

  Object.defineProperty(factory, "name", {
    value: def.name,
    configurable: true,
  });
  Object.defineProperty(factory, "macroDefinition", {
    value: def,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(factory, "macroName", {
    value: def.name,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  return factory as CustomMacroDecorator<TOptions>;
}

/**
 * Defines a reusable Class Macro Preset composing multiple decorators (built on `defineClassMacro`).
 * Automatically infers `composedNames` for static decorator arrays when not explicitly provided.
 */
export function defineMacroPreset<TOptions = void>(
  name: string,
  decoratorsOrFactory:
    | readonly ClassDecorator[]
    | ((options: TOptions) => readonly ClassDecorator[]),
  composedNames?: readonly string[],
): CustomMacroDecorator<TOptions> {
  const resolvedComposedNames =
    composedNames !== undefined
      ? [...composedNames]
      : Array.isArray(decoratorsOrFactory)
        ? inferComposedNames(decoratorsOrFactory)
        : undefined;

  const compose: (options: TOptions) => readonly ClassDecorator[] =
    typeof decoratorsOrFactory === "function"
      ? decoratorsOrFactory
      : () => decoratorsOrFactory;

  return defineClassMacro<TOptions>({
    name,
    compose,
    ...(resolvedComposedNames && resolvedComposedNames.length > 0
      ? { composedNames: resolvedComposedNames }
      : {}),
  });
}

/**
 * Registers AST-discovered class field names on `METADATA_KEYS.CLASS_MACROS` (`explicitFields`)
 * and re-installs any already-applied class macros (`@Data`, `@Value`, `@Getter`, `@Setter`,
 * `@With`, `@WithBy`, `@FieldNameConstants`).
 *
 * Works identically whether invoked before or after class decorators execute, enabling
 * `@bunest/cli`'s unified `Bun.plugin` to eliminate manual `fields: [...]` boilerplate.
 */
export function registerMacroFields(
  target: Function,
  fields: readonly string[],
): void {
  if (typeof target !== "function" || !Array.isArray(fields) || fields.length === 0) {
    return;
  }

  const validFields = fields.filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
  if (validFields.length === 0) {
    return;
  }

  const cfg = getOrCreateClassMacroConfig(target);
  cfg.explicitFields = [
    ...new Set([...(cfg.explicitFields ?? []), ...validFields]),
  ];

  reinstallClassMacrosForFields(target);
}
