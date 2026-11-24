import * as vscode from "vscode";
import {
  buildCollapseLoggerBoilerplateEdit,
  buildConvertDerivedToQueryEdit,
  buildDelombokEdit,
  buildSyncDiConstructorEdit,
  formatTypegenSummary,
  type AnalyzedQueryMethod,
  type AnalyzedRepository,
  type CheckCommandResult,
  type ExtractedRouteEntry,
  type SourceLocation,
  type TypegenCommandResult,
} from "@bunest/cli";
import { runGenerateRepositoryCommand } from "./commands/generate-repository";
import { runGenerateSchematicCommand } from "./commands/generate-schematic";
import { runBunestCliCommand } from "./commands/run-cli";
import { runSendRequestCommand } from "./commands/send-request";
import { BunestCodeActionsProvider } from "./providers/code-actions.provider";
import { BunestCodeLensProvider } from "./providers/codelens.provider";
import { BunestDefinitionProvider } from "./providers/definition.provider";
import { BunestDiagnosticsProvider } from "./providers/diagnostics.provider";
import { BunestHoverProvider } from "./providers/hover.provider";
import { BunestRepositoryCompletionProvider } from "./providers/repository-completion.provider";
import { BunestDataModelsTreeProvider } from "./views/data-models.tree";
import { BunestEventsRpcTreeProvider } from "./views/events-rpc.tree";
import { BunestModulesTreeProvider } from "./views/modules.tree";
import { BunestRoutesTreeProvider } from "./views/routes.tree";
import { BunestDiGraphPanel } from "./webview/di-graph.panel";
import {
  BunestWorkspaceIndex,
  sourceLocationToVscodeLocation,
} from "./workspace/workspace-index";

const TS_SELECTOR: vscode.DocumentSelector = [
  { language: "typescript", scheme: "file" },
  { language: "typescriptreact", scheme: "file" },
];

const TRIGGER_CHARS = [
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  " ",
];

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const index = new BunestWorkspaceIndex();
  const diagnostics = new BunestDiagnosticsProvider(index);
  const defProvider = new BunestDefinitionProvider(index);
  const hoverProvider = new BunestHoverProvider(index);
  const completionProvider = new BunestRepositoryCompletionProvider(index);
  const codeActionProvider = new BunestCodeActionsProvider(index);
  const codeLensProvider = new BunestCodeLensProvider(index);

  const routesTree = new BunestRoutesTreeProvider(index);
  const dataModelsTree = new BunestDataModelsTreeProvider(index);
  const eventsRpcTree = new BunestEventsRpcTreeProvider(index);
  const modulesTree = new BunestModulesTreeProvider(index);

  context.subscriptions.push(
    index,
    diagnostics,
    vscode.languages.registerCompletionItemProvider(
      TS_SELECTOR,
      completionProvider,
      ...TRIGGER_CHARS,
    ),
    vscode.languages.registerDefinitionProvider(TS_SELECTOR, defProvider),
    vscode.languages.registerReferenceProvider(TS_SELECTOR, defProvider),
    vscode.languages.registerHoverProvider(TS_SELECTOR, hoverProvider),
    vscode.languages.registerCodeActionsProvider(
      TS_SELECTOR,
      codeActionProvider,
      { providedCodeActionKinds: BunestCodeActionsProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerCodeLensProvider(TS_SELECTOR, codeLensProvider),
    vscode.window.registerTreeDataProvider("bunest.routesView", routesTree),
    vscode.window.registerTreeDataProvider("bunest.dataModelsView", dataModelsTree),
    vscode.window.registerTreeDataProvider("bunest.eventsRpcView", eventsRpcTree),
    vscode.window.registerTreeDataProvider("bunest.modulesView", modulesTree),
  );

  // Register Bunest commands (all disk-writing codegen delegates to @bunest/cli)
  context.subscriptions.push(
    vscode.commands.registerCommand("bunest.regenerateTypes", async () => {
      const contexts = index.getAllContexts();
      if (contexts.length === 0) {
        vscode.window.showInformationMessage("No Bunest workspace folders found.");
        return;
      }
      let lastSummary = "";
      for (const ctx of contexts) {
        const res = await runBunestCliCommand(
          ctx.cwd,
          ["typegen"],
          index.outputChannel,
          { revealOutput: true },
        );
        const out = res.output as TypegenCommandResult | undefined;
        if (out?.result) {
          lastSummary = `${out.result.relativePath} (${formatTypegenSummary(out.result.summary)})`;
        }
      }
      await index.refreshAll();
      if (lastSummary) {
        vscode.window.showInformationMessage(`Bunest CLI Typegen: ${lastSummary}`);
      }
    }),

    vscode.commands.registerCommand("bunest.runCheck", async () => {
      const contexts = index.getAllContexts();
      if (contexts.length === 0) {
        vscode.window.showInformationMessage("No Bunest workspace folders found.");
        return;
      }
      let totalErrors = 0;
      let totalWarnings = 0;
      for (const ctx of contexts) {
        const res = await runBunestCliCommand(
          ctx.cwd,
          ["check"],
          index.outputChannel,
          { revealOutput: true },
        );
        const out = res.output as CheckCommandResult | undefined;
        if (out) {
          totalErrors += out.errors;
          totalWarnings += out.warnings;
        }
      }
      vscode.window.showInformationMessage(
        `Bunest CLI Check: ${totalErrors} error(s), ${totalWarnings} warning(s).`,
      );
    }),

    vscode.commands.registerCommand("bunest.refreshWorkspace", async () => {
      await index.refreshAll();
    }),

    vscode.commands.registerCommand("bunest.openDiGraph", () => {
      BunestDiGraphPanel.show(index);
    }),

    vscode.commands.registerCommand(
      "bunest.sendRequest",
      async (routeOrItem?: ExtractedRouteEntry | { route?: ExtractedRouteEntry }) => {
        const route =
          routeOrItem && "path" in routeOrItem
            ? routeOrItem
            : routeOrItem?.route;
        await runSendRequestCommand(route);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.copyRouteUrl",
      async (routeOrItem?: ExtractedRouteEntry | { route?: ExtractedRouteEntry }) => {
        const route =
          routeOrItem && "path" in routeOrItem
            ? routeOrItem
            : routeOrItem?.route;
        if (!route) return;
        const base =
          (vscode.workspace
            .getConfiguration("bunest")
            .get<string>("http.baseUrl") ?? "http://localhost:3000"
          ).replace(/\/+$/, "");
        const url = `${base}${route.path}`;
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage(`Copied URL: ${url}`);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.generateSchematic",
      async (uri?: vscode.Uri) => {
        await runGenerateSchematicCommand(index, uri);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.generateRepository",
      async (entity) => {
        await runGenerateRepositoryCommand(index, entity);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.previewRepositorySql",
      (repo?: AnalyzedRepository, method?: AnalyzedQueryMethod) => {
        if (!repo || !method?.derived) return;
        index.outputChannel.show(true);
        index.outputChannel.appendLine(
          `\n=== ${repo.className}.${method.name}() ===`,
        );
        index.outputChannel.appendLine(`SQLite:   ${method.derived.sqlByDialect.sqlite}`);
        index.outputChannel.appendLine(`Postgres: ${method.derived.sqlByDialect.postgres}`);
        index.outputChannel.appendLine(`MySQL:    ${method.derived.sqlByDialect.mysql}`);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.convertDerivedToQuery",
      async (
        filePath?: string,
        repo?: AnalyzedRepository,
        method?: AnalyzedQueryMethod,
      ) => {
        if (!filePath || !repo || !method) return;
        const doc = await vscode.workspace.openTextDocument(filePath);
        const editRes = buildConvertDerivedToQueryEdit({
          filePath,
          sourceText: doc.getText(),
          method,
          repo,
        });
        if (!editRes.changed) return;
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(
          doc.uri,
          new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(editRes.original.length),
          ),
          editRes.updated,
        );
        await vscode.workspace.applyEdit(wsEdit);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.delombokClass",
      async (filePath?: string, className?: string) => {
        const editor = vscode.window.activeTextEditor;
        const targetPath = filePath ?? editor?.document.uri.fsPath;
        if (!targetPath) return;
        const ctx = index.getContextForFile(targetPath);
        const snap = ctx?.snapshot;
        if (!ctx || !snap) return;

        const macro = className
          ? snap.scan.classMacros.find(
              (m) => m.sourceFile === targetPath && m.className === className,
            )
          : snap.scan.classMacros.find((m) => m.sourceFile === targetPath);
        if (!macro) return;

        const sf = ctx.analyzer.getSourceFile(targetPath);
        const cls = sf?.getClass(macro.className);
        if (!sf || !cls) return;

        const res = buildDelombokEdit({
          sourceFile: sf,
          classDecl: cls,
          macro,
          bunestConfig: ctx.bunestConfig,
        });
        if (!res.changed) return;
        const doc = await vscode.workspace.openTextDocument(targetPath);
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(
          doc.uri,
          new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(res.original.length),
          ),
          res.updated,
        );
        await vscode.workspace.applyEdit(wsEdit);
      },
    ),

    vscode.commands.registerCommand("bunest.collapseLogger", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const ctx = index.getContextForFile(editor.document.uri.fsPath);
      const sf = ctx?.analyzer.getSourceFile(editor.document.uri.fsPath);
      const cls = sf?.getClasses()[0];
      if (!sf || !cls) return;
      const res = buildCollapseLoggerBoilerplateEdit({
        sourceFile: sf,
        classDecl: cls,
      });
      if (!res.changed) return;
      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.replace(
        editor.document.uri,
        new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(res.original.length),
        ),
        res.updated,
      );
      await vscode.workspace.applyEdit(wsEdit);
    }),

    vscode.commands.registerCommand("bunest.syncDiConstructor", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const ctx = index.getContextForFile(editor.document.uri.fsPath);
      const sf = ctx?.analyzer.getSourceFile(editor.document.uri.fsPath);
      const cls = sf?.getClasses()[0];
      if (!sf || !cls) return;
      const res = buildSyncDiConstructorEdit({
        sourceFile: sf,
        classDecl: cls,
      });
      if (!res.changed) return;
      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.replace(
        editor.document.uri,
        new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(res.original.length),
        ),
        res.updated,
      );
      await vscode.workspace.applyEdit(wsEdit);
    }),

    vscode.commands.registerCommand(
      "bunest.runBunTest",
      (testFilePath?: string) => {
        const target =
          testFilePath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!target) return;
        const term = vscode.window.createTerminal("Bunest Test");
        term.show(true);
        term.sendText(`bun test ${JSON.stringify(target)}`);
      },
    ),

    vscode.commands.registerCommand(
      "bunest.revealLocation",
      async (loc?: SourceLocation) => {
        if (!loc) return;
        const vLoc = sourceLocationToVscodeLocation(loc);
        const doc = await vscode.workspace.openTextDocument(vLoc.uri);
        await vscode.window.showTextDocument(doc, { selection: vLoc.range });
      },
    ),
  );

  await index.initialize();
}

export function deactivate(): void {
  // All disposables are automatically cleaned up by VS Code via context.subscriptions
}
