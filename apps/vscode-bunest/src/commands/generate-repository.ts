import * as vscode from "vscode";
import type { AnalyzedEntity, GenerateRepositoryResult } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";
import { runBunestCliCommand } from "./run-cli";

/**
 * Delegates `Generate Declarative Repository` directly to `@bunest/cli`
 * (`bunest generate repository <EntityName>`), generating a dialect-agnostic
 * `@bunest/orm` `CrudRepository` decorated with `@OrmRepository(...)`.
 */
export async function runGenerateRepositoryCommand(
  index: BunestWorkspaceIndex,
  entityArg?: AnalyzedEntity,
): Promise<void> {
  let entity = entityArg;
  if (!entity) {
    const allEntities = index.getAllSnapshots().flatMap((s) => s.entities);
    if (allEntities.length === 0) {
      vscode.window.showWarningMessage(
        "No @Entity() classes discovered in this workspace.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      allEntities.map((e) => ({
        label: e.className,
        description: `table "${e.tableName}" (${e.fields.length} columns)`,
        entity: e,
      })),
      { placeHolder: "Select @Entity() to generate a @bunest/orm CrudRepository" },
    );
    if (!picked) return;
    entity = picked.entity;
  }

  const ctx = index.getContextForFile(entity.sourceFile);
  if (!ctx) return;

  const cliRes = await runBunestCliCommand(
    ctx.cwd,
    ["generate", "repository", entity.className],
    index.outputChannel,
    { revealOutput: true },
  );
  if (cliRes.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `bunest generate repository failed (see Bunest output channel).`,
    );
    return;
  }

  const out = cliRes.output as GenerateRepositoryResult | undefined;
  const generatedPath = out?.files[0]?.path;
  await index.refreshFolder(ctx, generatedPath, true);

  if (generatedPath) {
    const doc = await vscode.workspace.openTextDocument(generatedPath);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
      `Generated @bunest/orm declarative repository via Bunest CLI: ${out?.files[0]?.relativePath}`,
    );
  }
}
