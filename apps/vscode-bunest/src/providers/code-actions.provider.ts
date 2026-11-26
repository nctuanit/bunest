import { dirname, relative } from "@bunest/core";
import * as vscode from "vscode";
import {
  buildAddProviderToModuleEdit,
  buildConvertTypeImportEdit,
  buildSyncDiConstructorEdit,
  buildWrapMongooseRefEdit,
  type MagicEditResult,
} from "@bunest/cli";
import {
  sourceLocationToVscodeRange,
  type BunestWorkspaceIndex,
} from "../workspace/workspace-index";

function toWorkspaceEdit(
  editResult: MagicEditResult,
  document?: vscode.TextDocument,
): vscode.WorkspaceEdit | undefined {
  if (!editResult.changed) return undefined;
  const wsEdit = new vscode.WorkspaceEdit();
  const uri = vscode.Uri.file(editResult.filePath);
  const fullRange = document
    ? new vscode.Range(
        document.positionAt(0),
        document.positionAt(editResult.original.length),
      )
    : new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0);
  wsEdit.replace(uri, fullRange, editResult.updated);
  return wsEdit;
}

/**
 * Provides 1-click `magic-string` Quick Fixes for Bunest diagnostics plus
 * Refactor actions (Collapse Logger, Auto-Sync DI Constructor).
 */
export class BunestCodeActionsProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  constructor(private readonly index: BunestWorkspaceIndex) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const ctx = this.index.getContextForFile(document.uri.fsPath);
    const snap = ctx?.snapshot;
    if (!ctx || !snap) return [];

    const actions: vscode.CodeAction[] = [];
    const filePath = document.uri.fsPath;
    const sf = ctx.analyzer.getSourceFile(filePath);

    // 1. Diagnostic-backed Quick Fixes
    for (const vDiag of context.diagnostics) {
      if (vDiag.source !== "bunest") continue;
      const code = String(vDiag.code ?? "");

      // Quick Fix for BUNEST_SQL002: replace `return ... as unknown as Promise<...>` with `return generatedQuery();`
      if (code === "BUNEST_SQL002") {
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(document.uri, vDiag.range, "return generatedQuery();");
        const fullText = document.getText();
        if (!/\bgeneratedQuery\b/.test(fullText)) {
          const ormImportMatch =
            /import\s*\{([^}]*)\}\s*from\s*["']@bunest\/orm["']/.exec(fullText);
          if (ormImportMatch && ormImportMatch.index !== undefined) {
            const closeBraceIdx =
              ormImportMatch.index + ormImportMatch[0].indexOf("}");
            const existing = ormImportMatch[1]!.trim();
            const prefix = existing.endsWith(",") || existing === "" ? " " : ", ";
            wsEdit.insert(
              document.uri,
              document.positionAt(closeBraceIdx),
              `${prefix}generatedQuery `,
            );
          } else {
            wsEdit.insert(
              document.uri,
              new vscode.Position(0, 0),
              `import { generatedQuery } from "@bunest/orm";\n`,
            );
          }
        }
        const act = new vscode.CodeAction(
          "Bunest: Replace stub cast with return generatedQuery()",
          vscode.CodeActionKind.QuickFix,
        );
        act.edit = wsEdit;
        act.diagnostics = [vDiag];
        act.isPreferred = true;
        actions.push(act);
        continue;
      }

      const matched = snap.diagnostics.find(
        (d) =>
          d.code === code &&
          d.location.filePath === filePath &&
          d.location.line - 1 === vDiag.range.start.line,
      );
      if (!matched?.fixData) continue;

      const fixKind = matched.fixData.kind;

      if (fixKind === "addExportToModule") {
        const ownerModFile = String(matched.fixData.ownerModuleFile ?? matched.fixData.moduleFile ?? "");
        const ownerModName = String(matched.fixData.ownerModuleName ?? matched.fixData.moduleName ?? "");
        const providerName = String(matched.fixData.providerName ?? "");
        const ownerSf = ownerModFile ? ctx.analyzer.getSourceFile(ownerModFile) : undefined;
        if (ownerSf && ownerModName && providerName) {
          const openOwnerDoc = (vscode.workspace.textDocuments ?? []).find(
            (d) => d.uri?.scheme === "file" && d.uri.fsPath === ownerModFile,
          );
          const res = buildAddProviderToModuleEdit({
            sourceFile: ownerSf,
            moduleClassName: ownerModName,
            symbolName: providerName,
            arrayProperty: "exports",
          });
          const wsEdit = toWorkspaceEdit(res, openOwnerDoc);
          if (wsEdit) {
            const act = new vscode.CodeAction(
              `Bunest: Export ${providerName} from ${ownerModName}`,
              vscode.CodeActionKind.QuickFix,
            );
            act.edit = wsEdit;
            act.diagnostics = [vDiag];
            act.isPreferred = true;
            actions.push(act);
          }
        }
      } else if (fixKind === "addProviderToModule") {
        const providerName = String(matched.fixData.providerName);
        const consumerModName = String(matched.fixData.moduleName);
        let offeredDeterministicExport = false;

        // P0.2 deterministic single-owner rule for BUNEST001:
        // If the missing provider is owned by a single imported module and not exported
        // (and neither module uses autoDiscover or has unknown dynamic registrations),
        // offer `addExportToModule` as the preferred deterministic quick fix.
        if (code === "BUNEST001") {
          const consumerMod = snap.moduleGraph.moduleByName.get(consumerModName);
          const unknowns = snap.moduleGraph.unknownRegistrations ?? [];
          const consumerHasUnknowns =
            Boolean(consumerMod?.autoDiscover) ||
            unknowns.some((u) => u.moduleName === consumerModName);
          if (consumerMod && !consumerHasUnknowns) {
            const ownerModules = snap.moduleGraph.modules.filter(
              (m) =>
                m.name !== consumerMod.name &&
                m.providers.includes(providerName),
            );
            if (ownerModules.length === 1) {
              const ownerMod = ownerModules[0]!;
              const ownerHasUnknowns =
                Boolean(ownerMod.autoDiscover) ||
                unknowns.some((u) => u.moduleName === ownerMod.name);
              const importedByConsumer = consumerMod.imports.includes(ownerMod.name);
              const alreadyExported = ownerMod.exports.includes(providerName);
              if (importedByConsumer && !alreadyExported && !ownerHasUnknowns) {
                const ownerSf = ctx.analyzer.getSourceFile(ownerMod.sourceFile);
                if (ownerSf) {
                  const openOwnerDoc = (vscode.workspace.textDocuments ?? []).find(
                    (d) => d.uri?.scheme === "file" && d.uri.fsPath === ownerMod.sourceFile,
                  );
                  const exportRes = buildAddProviderToModuleEdit({
                    sourceFile: ownerSf,
                    moduleClassName: ownerMod.name,
                    symbolName: providerName,
                    arrayProperty: "exports",
                  });
                  const exportWsEdit = toWorkspaceEdit(exportRes, openOwnerDoc);
                  if (exportWsEdit) {
                    const exportAct = new vscode.CodeAction(
                      `Bunest: Export ${providerName} from ${ownerMod.name}`,
                      vscode.CodeActionKind.QuickFix,
                    );
                    exportAct.edit = exportWsEdit;
                    exportAct.diagnostics = [vDiag];
                    exportAct.isPreferred = true;
                    actions.push(exportAct);
                    offeredDeterministicExport = true;
                  }
                }
              }
            }
          }
        }

        const modFile = String(matched.fixData.moduleFile);
        const modSf = ctx.analyzer.getSourceFile(modFile);
        if (modSf) {
          const provFile = String(matched.fixData.providerFile);
          let rel = relative(dirname(modFile), provFile)
            .replace(/\\/g, "/")
            .replace(/\.ts$/, "");
          if (!rel.startsWith(".")) rel = `./${rel}`;
          const res = buildAddProviderToModuleEdit({
            sourceFile: modSf,
            moduleClassName: consumerModName,
            symbolName: providerName,
            arrayProperty: "providers",
            importSpecifier: modFile === provFile ? undefined : rel,
          });
          const wsEdit = toWorkspaceEdit(res);
          if (wsEdit) {
            const act = new vscode.CodeAction(
              `Bunest: Add ${providerName} to ${consumerModName}.providers`,
              vscode.CodeActionKind.QuickFix,
            );
            act.edit = wsEdit;
            act.diagnostics = [vDiag];
            act.isPreferred = !offeredDeterministicExport;
            actions.push(act);
          }
        }
      } else if (fixKind === "convertTypeImport" && sf) {
        const res = buildConvertTypeImportEdit({
          sourceFile: sf,
          symbolName: String(matched.fixData.symbolName),
        });
        const wsEdit = toWorkspaceEdit(res, document);
        if (wsEdit) {
          const act = new vscode.CodeAction(
            `Bunest: Convert \`import type\` of ${matched.fixData.symbolName} to value import`,
            vscode.CodeActionKind.QuickFix,
          );
          act.edit = wsEdit;
          act.diagnostics = [vDiag];
          act.isPreferred = true;
          actions.push(act);
        }
      } else if (fixKind === "wrapMongooseRef") {
        const res = buildWrapMongooseRefEdit({
          filePath,
          sourceText: document.getText(),
          decoratorStart: Number(matched.fixData.decoratorStart),
          decoratorEnd: Number(matched.fixData.decoratorEnd),
        });
        const wsEdit = toWorkspaceEdit(res, document);
        if (wsEdit) {
          const act = new vscode.CodeAction(
            "Bunest: Add explicit `type: Schema.Types.ObjectId`",
            vscode.CodeActionKind.QuickFix,
          );
          act.edit = wsEdit;
          act.diagnostics = [vDiag];
          act.isPreferred = true;
          actions.push(act);
        }
      } else if (
        fixKind === "renameDerivedProperty" ||
        fixKind === "fixReturnType" ||
        fixKind === "replaceFieldName"
      ) {
        const replacement = String(matched.fixData.replacement ?? "");
        if (replacement) {
          const wsEdit = new vscode.WorkspaceEdit();
          wsEdit.replace(
            document.uri,
            sourceLocationToVscodeRange(matched.location),
            replacement,
          );
          const act = new vscode.CodeAction(
            `Bunest: Replace with ${replacement}`,
            vscode.CodeActionKind.QuickFix,
          );
          act.edit = wsEdit;
          act.diagnostics = [vDiag];
          act.isPreferred = true;
          actions.push(act);
        }
      } else if (fixKind === "addModifyingDecorator") {
        const line = document.lineAt(matched.location.line - 1);
        const indent = /^\s*/.exec(line.text)?.[0] ?? "";
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.insert(
          document.uri,
          new vscode.Position(matched.location.line - 1, 0),
          `${indent}@Modifying()\n`,
        );
        const act = new vscode.CodeAction(
          "Bunest: Add @Modifying() decorator",
          vscode.CodeActionKind.QuickFix,
        );
        act.edit = wsEdit;
        act.diagnostics = [vDiag];
        act.isPreferred = true;
        actions.push(act);
      } else if (fixKind === "addRepositoryDecorator") {
        const decName = "Repository";
        const line = document.lineAt(matched.location.line - 1);
        const indent = /^\s*/.exec(line.text)?.[0] ?? "";
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.insert(
          document.uri,
          new vscode.Position(matched.location.line - 1, 0),
          `${indent}@${decName}(${matched.fixData.entityName})\n`,
        );
        const act = new vscode.CodeAction(
          `Bunest: Add @${decName}(${matched.fixData.entityName})`,
          vscode.CodeActionKind.QuickFix,
        );
        act.edit = wsEdit;
        act.diagnostics = [vDiag];
        act.isPreferred = true;
        actions.push(act);
      } else if (fixKind === "customRuleFix") {
        const start = Number(matched.fixData.start);
        const end = Number(matched.fixData.end);
        const newText = String(matched.fixData.newText ?? "");
        const desc = String(
          matched.fixData.description ?? `Apply fix for ${code}`,
        );
        const targetFile = matched.fixData.filePath
          ? String(matched.fixData.filePath)
          : filePath;
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          const wsEdit = new vscode.WorkspaceEdit();
          const targetUri =
            targetFile === filePath
              ? document.uri
              : vscode.Uri.file(targetFile);
          const editRange =
            targetFile === filePath
              ? new vscode.Range(
                  document.positionAt(start),
                  document.positionAt(end),
                )
              : sourceLocationToVscodeRange(matched.location);
          wsEdit.replace(targetUri, editRange, newText);
          const act = new vscode.CodeAction(
            `Bunest: ${desc}`,
            vscode.CodeActionKind.QuickFix,
          );
          act.edit = wsEdit;
          act.diagnostics = [vDiag];
          act.isPreferred = true;
          actions.push(act);
        }
      }
    }

    const cursorLine1 = range.start.line + 1;

    // 2. Refactor: Auto-Sync DI Constructor
    if (sf) {
      for (const cls of sf.getClasses()) {
        const startLine = sf.getLineAndColumnAtPos(cls.getStart()).line;
        const endLine = sf.getLineAndColumnAtPos(cls.getEnd()).line;
        if (cursorLine1 < startLine || cursorLine1 > endLine) continue;

        const isDiClass = cls
          .getDecorators()
          .some(
            (d) => d.getName() === "Injectable" || d.getName() === "Controller",
          );
        if (isDiClass) {
          const syncRes = buildSyncDiConstructorEdit({
            sourceFile: sf,
            classDecl: cls,
          });
          const syncEdit = toWorkspaceEdit(syncRes, document);
          if (syncEdit) {
            const act = new vscode.CodeAction(
              `Bunest: Auto-Sync DI constructor on ${cls.getName() ?? "class"}`,
              vscode.CodeActionKind.RefactorRewrite,
            );
            act.edit = syncEdit;
            actions.push(act);
          }
        }
      }
    }

    return actions;
  }
}
