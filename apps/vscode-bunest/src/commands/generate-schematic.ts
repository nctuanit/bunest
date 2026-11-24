import { dirname, relative } from "@bunest/core";
import * as vscode from "vscode";
import type { GenerateSchematicResult } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";
import { runBunestCliCommand } from "./run-cli";

const SCHEMATIC_ITEMS = [
  { label: "resource", description: "Full CRUD module + controller + service + DTOs" },
  { label: "module", description: "Bunest @Module()" },
  { label: "controller", description: "Bunest @Controller() (auto-wired via CLI codemod)" },
  { label: "service", description: "Bunest @Injectable() service (auto-wired via CLI codemod)" },
  { label: "repository", description: "Bunest declarative CrudRepository (from @Entity)" },
  { label: "guard", description: "Bunest CanActivate guard" },
  { label: "pipe", description: "Bunest PipeTransform pipe" },
  { label: "interceptor", description: "Bunest BunestInterceptor" },
  { label: "filter", description: "Bunest ExceptionFilter" },
  { label: "middleware", description: "Bunest BunestMiddleware" },
  { label: "gateway", description: "Bunest WebSocket gateway" },
] as const;

/**
 * Delegates component generation directly to `@bunest/cli`
 * (`bunest generate <schematic> <name>` + `bunest codemod add-provider`).
 */
export async function runGenerateSchematicCommand(
  index: BunestWorkspaceIndex,
  targetUri?: vscode.Uri,
): Promise<void> {
  const ctx = targetUri
    ? index.getContextForFile(targetUri.fsPath)
    : index.getAllContexts()[0];
  if (!ctx) {
    vscode.window.showWarningMessage("No Bunest workspace folder found.");
    return;
  }

  const picked = await vscode.window.showQuickPick(SCHEMATIC_ITEMS, {
    placeHolder: "Select Bunest component schematic to generate via CLI",
  });
  if (!picked) return;

  const rawName = await vscode.window.showInputBox({
    prompt: `Name for new ${picked.label} (e.g. users or billing/invoices)`,
    placeHolder: "users",
  });
  if (!rawName?.trim()) return;

  const cliRes = await runBunestCliCommand(
    ctx.cwd,
    ["generate", picked.label, rawName.trim(), "--sourceRoot", ctx.sourceRoot],
    index.outputChannel,
    { revealOutput: true },
  );
  if (cliRes.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `bunest generate ${picked.label} failed (see Bunest output channel).`,
    );
    return;
  }

  const result = cliRes.output as GenerateSchematicResult | undefined;
  const primaryFile = result?.files.find(
    (f) => !f.path.endsWith(".spec.ts") && f.path.endsWith(".ts"),
  );

  // Auto-wire controller/service into nearest @Module via CLI codemod
  const snap = ctx.snapshot ?? ctx.analyzer.analyze();
  if (
    primaryFile &&
    (picked.label === "controller" || picked.label === "service") &&
    snap.moduleGraph.modules.length > 0
  ) {
    const targetMod = snap.moduleGraph.modules[0]!;
    const pascal =
      rawName
        .trim()
        .split(/[/_-]+/)
        .pop()!
        .replace(/^[a-z]/, (c) => c.toUpperCase()) +
      (picked.label === "controller" ? "Controller" : "Service");
    let rel = relative(dirname(targetMod.sourceFile), primaryFile.path)
      .replace(/\\/g, "/")
      .replace(/\.ts$/, "");
    if (!rel.startsWith(".")) rel = `./${rel}`;

    await runBunestCliCommand(
      ctx.cwd,
      [
        "codemod",
        "add-provider",
        targetMod.sourceFile,
        "--module",
        targetMod.name,
        "--symbol",
        pascal,
        "--kind",
        picked.label === "controller" ? "controllers" : "providers",
        "--from",
        rel,
      ],
      index.outputChannel,
    );
  }

  await index.refreshFolder(ctx, undefined, true);

  if (primaryFile) {
    const doc = await vscode.workspace.openTextDocument(primaryFile.path);
    await vscode.window.showTextDocument(doc);
  }
  vscode.window.showInformationMessage(
    `Bunest CLI generated ${result?.files.length ?? 1} file(s) for ${picked.label} "${rawName}".`,
  );
}
