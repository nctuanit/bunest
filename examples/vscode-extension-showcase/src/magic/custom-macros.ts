import {
  Builder,
  Data,
  FieldNameConstants,
  defineClassMacro,
  defineMacroPreset,
  registerMacroFields,
} from "@bunest/core";

/**
 * Custom Class Macro defined via `defineClassMacro(...)`:
 * drives runtime fields/methods/statics, `.d.ts` typegen, Hover/CodeLens, and Delombok.
 */
export const Auditable = defineClassMacro({
  name: "Auditable",
  description: "Adds audit metadata fields and helper methods to domain models.",
  fields: [
    { name: "auditTag", type: "string", defaultValue: "showcase" },
    { name: "updatedBy", type: "string", optional: true },
  ],
  methods: {
    markUpdated: {
      signature: "(actor: string): this",
      impl(self: { updatedBy?: string }, actor: string) {
        self.updatedBy = actor;
        return self;
      },
      delombokBody: "this.updatedBy = actor;\nreturn this;",
    },
  },
  statics: {
    auditVersion: {
      signature: "(): number",
      impl() {
        return 1;
      },
      delombokBody: "return 1;",
    },
  },
});

/**
 * Reusable Macro Preset defined via `defineMacroPreset(...)`:
 * composes `@Data()`, `@Builder({ toBuilder: true })`, and `@FieldNameConstants()`.
 */
export const DomainEntity = defineMacroPreset(
  "DomainEntity",
  [Data(), Builder({ toBuilder: true }), FieldNameConstants()],
  ["Data", "Builder", "FieldNameConstants"],
);

/**
 * Showcase domain model demonstrating `@DomainEntity()` preset + custom `@Auditable()`.
 * Hover over `AuditNote` or click CodeLens in VS Code to inspect synthesized members or Delombok!
 */
@DomainEntity()
@Auditable()
export class AuditNote {
  id!: number;
  title!: string;
}

// Register AST-discovered fields for zero-initializer runtime usage (emitted automatically by `createBunestPlugin()`).
registerMacroFields(AuditNote, ["id", "title"]);
