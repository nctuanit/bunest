import type { Decorator, SourceFile } from "../ast";
import type { BunestConfigLike } from "../config/bunest-config.loader";
import { nodeToLocation } from "../typegen/scanner";
import type { SourceLocation, TypegenScanResult } from "../typegen/types";
import type { StaticModuleGraph } from "./module-graph";
import type { AnalyzedEntity, AnalyzedRepository } from "./repository-query";

// ============================================================================
// Custom Architecture & Project Diagnostic Rule API
// ============================================================================

export interface CustomDiagnosticQuickFix {
  readonly description: string;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly filePath?: string;
}

export interface CustomDiagnosticHit {
  readonly message: string;
  readonly location: SourceLocation;
  readonly severity?: "error" | "warning" | "info";
  readonly fix?: CustomDiagnosticQuickFix;
  readonly fixData?: Record<string, unknown>;
}

export interface DiagnosticRuleContext {
  readonly sourceFiles: readonly SourceFile[];
  readonly scan: TypegenScanResult;
  readonly moduleGraph: StaticModuleGraph;
  readonly entities: readonly AnalyzedEntity[];
  readonly repositories: readonly AnalyzedRepository[];
}

export interface CustomDiagnosticRule {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly description: string;
  readonly check: (ctx: DiagnosticRuleContext) => readonly CustomDiagnosticHit[];
}

export interface CustomRuleDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location: SourceLocation;
  readonly fixData?: Record<string, unknown>;
}

/**
 * Defines a reusable static diagnostic rule executed during `bunest check`
 * and inside `BunestStaticAnalyzer`.
 */
export function defineDiagnosticRule(
  rule: CustomDiagnosticRule,
): CustomDiagnosticRule {
  return rule;
}

// ============================================================================
// AST Helpers
// ============================================================================

function getDecoratorShortName(dec: Decorator): string {
  const name = dec.getName();
  const dot = name.lastIndexOf(".");
  return dot !== -1 ? name.slice(dot + 1) : name;
}

const MUTATION_HTTP_DECORATORS = new Set(["Post", "Put", "Patch", "Delete"]);

// ============================================================================
// Built-in Architecture Rules (Opt-In via `bunest.config.ts`)
// ============================================================================

/**
 * `BUNEST_ARCH001`: Flags `@Controller()` classes that inject `*Repository`
 * dependencies directly instead of delegating through a Service layer.
 */
export const noRepositoryInControllerRule: CustomDiagnosticRule =
  defineDiagnosticRule({
    code: "BUNEST_ARCH001",
    severity: "warning",
    description:
      "Disallow @Controller() classes from injecting *Repository dependencies directly.",
    check(ctx) {
      const hits: CustomDiagnosticHit[] = [];
      const knownRepoNames = new Set(ctx.repositories.map((r) => r.className));
      for (const prov of ctx.moduleGraph.providers) {
        if (prov.kind === "repository") {
          knownRepoNames.add(prov.name);
        }
      }

      for (const sf of ctx.sourceFiles) {
        for (const cls of sf.getClasses()) {
          const isController = cls
            .getDecorators()
            .some((d) => getDecoratorShortName(d) === "Controller");
          if (!isController) continue;

          const ctrlName = cls.getName() ?? "AnonymousController";
          const ctor = cls.getConstructors()[0];
          if (!ctor) continue;

          for (const param of ctor.getParameters()) {
            const hasInjectRepoDec = param
              .getDecorators()
              .some((d) => getDecoratorShortName(d) === "InjectRepository");
            const rawType = param.getTypeNode()?.getText().trim() ?? "";
            const baseType = rawType
              .replace(/\s*\|\s*(?:undefined|null)/g, "")
              .replace(/<.*>$/, "")
              .trim();

            const isRepoType =
              hasInjectRepoDec ||
              knownRepoNames.has(baseType) ||
              /Repository$/.test(baseType);

            if (isRepoType) {
              hits.push({
                message: `Controller "${ctrlName}" directly injects repository "${baseType || param.getName()}". Route database access through a domain Service instead.`,
                location: nodeToLocation(param.getNameNode()),
              });
            }
          }
        }
      }

      return hits;
    },
  });

/**
 * `BUNEST_ARCH002`: Flags `@Post` / `@Put` / `@Patch` / `@Delete` route handlers
 * lacking both `@UseGuards(...)` and `@Public()` (at either controller or method level).
 */
export const requireGuardOnMutationsRule: CustomDiagnosticRule =
  defineDiagnosticRule({
    code: "BUNEST_ARCH002",
    severity: "error",
    description:
      "Require @UseGuards(...) or @Public() on all mutating HTTP routes (@Post, @Put, @Patch, @Delete).",
    check(ctx) {
      const hits: CustomDiagnosticHit[] = [];

      for (const sf of ctx.sourceFiles) {
        for (const cls of sf.getClasses()) {
          const clsDecNames = new Set(
            cls.getDecorators().map(getDecoratorShortName),
          );
          if (!clsDecNames.has("Controller")) continue;

          const classHasGuardOrPublic =
            clsDecNames.has("UseGuards") || clsDecNames.has("Public");
          if (classHasGuardOrPublic) continue;

          const ctrlName = cls.getName() ?? "AnonymousController";
          for (const method of cls.getMethods()) {
            const methodDecNames = new Set(
              method.getDecorators().map(getDecoratorShortName),
            );
            const mutationDec = [...methodDecNames].find((name) =>
              MUTATION_HTTP_DECORATORS.has(name),
            );
            if (!mutationDec) continue;

            if (
              methodDecNames.has("UseGuards") ||
              methodDecNames.has("Public")
            ) {
              continue;
            }

            hits.push({
              message: `Mutating route @${mutationDec}() "${ctrlName}.${method.getName()}()" is missing @UseGuards(...) or @Public().`,
              location: nodeToLocation(method.getNameNode()),
            });
          }
        }
      }

      return hits;
    },
  });

export const BUILTIN_ARCHITECTURE_RULES: Readonly<
  Record<string, CustomDiagnosticRule>
> = {
  "no-repository-in-controller": noRepositoryInControllerRule,
  noRepositoryInController: noRepositoryInControllerRule,
  BUNEST_ARCH001: noRepositoryInControllerRule,
  "require-guard-on-mutations": requireGuardOnMutationsRule,
  requireGuardOnMutations: requireGuardOnMutationsRule,
  BUNEST_ARCH002: requireGuardOnMutationsRule,
};

export function resolvePresetDiagnosticRules(
  presetRules?: readonly string[],
): CustomDiagnosticRule[] {
  if (!presetRules || presetRules.length === 0) return [];
  const seen = new Set<string>();
  const resolved: CustomDiagnosticRule[] = [];
  for (const key of presetRules) {
    const rule = BUILTIN_ARCHITECTURE_RULES[key];
    if (rule && !seen.has(rule.code)) {
      seen.add(rule.code);
      resolved.push(rule);
    }
  }
  return resolved;
}

export function collectConfiguredDiagnosticRules(
  config?: BunestConfigLike,
  extraRules?: readonly CustomDiagnosticRule[],
  extraPresetRules?: readonly string[],
): CustomDiagnosticRule[] {
  const byCode = new Map<string, CustomDiagnosticRule>();
  for (const rule of resolvePresetDiagnosticRules(
    config?.diagnostics?.presetRules,
  )) {
    byCode.set(rule.code, rule);
  }
  for (const rule of resolvePresetDiagnosticRules(extraPresetRules)) {
    byCode.set(rule.code, rule);
  }
  for (const rule of (config?.diagnostics?.rules ??
    []) as readonly CustomDiagnosticRule[]) {
    if (rule && typeof rule.check === "function" && rule.code) {
      byCode.set(rule.code, rule);
    }
  }
  for (const rule of extraRules ?? []) {
    if (rule && typeof rule.check === "function" && rule.code) {
      byCode.set(rule.code, rule);
    }
  }
  return [...byCode.values()];
}

export function runCustomDiagnosticRules(
  rules: readonly CustomDiagnosticRule[],
  ctx: DiagnosticRuleContext,
): CustomRuleDiagnostic[] {
  const out: CustomRuleDiagnostic[] = [];
  for (const rule of rules) {
    const hits = rule.check(ctx) ?? [];
    for (const hit of hits) {
      let fixData: Record<string, unknown> | undefined = hit.fixData;
      if (hit.fix) {
        fixData = {
          ...(hit.fixData ?? {}),
          kind: "customRuleFix",
          description: hit.fix.description,
          start: hit.fix.start,
          end: hit.fix.end,
          newText: hit.fix.newText,
          ...(hit.fix.filePath ? { filePath: hit.fix.filePath } : {}),
        };
      }

      out.push({
        code: rule.code,
        severity: hit.severity ?? rule.severity,
        message: hit.message,
        location: hit.location,
        ...(fixData ? { fixData } : {}),
      });
    }
  }
  return out;
}
