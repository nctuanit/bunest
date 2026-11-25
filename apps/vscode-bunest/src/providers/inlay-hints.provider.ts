import * as vscode from "vscode";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

/**
 * Displays subtle inline SQL previews next to declarative repository derived
 * query methods (toggleable via `bunest.inlayHints.enabled`).
 */
export class BunestInlayHintsProvider implements vscode.InlayHintsProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire());
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.InlayHint[] {
    const enabled =
      vscode.workspace
        .getConfiguration("bunest")
        .get<boolean>("inlayHints.enabled") ?? true;
    if (!enabled) return [];

    const ctx = this.index.getContextForFile(document.uri.fsPath);
    const snap = ctx?.snapshot;
    if (!snap) return [];

    const hints: vscode.InlayHint[] = [];
    const filePath = document.uri.fsPath;

    for (const repo of snap.repositories) {
      if (repo.location.filePath !== filePath) continue;
      for (const method of repo.methods) {
        if (!method.derived) continue;
        const line = Math.max(0, method.location.line - 1);
        if (line < range.start.line || line > range.end.line) continue;
        if (line >= document.lineCount) continue;

        const lineText = document.lineAt(line).text;
        const sql = method.derived.sqlByDialect.postgres;
        const compact = sql.length > 72 ? `${sql.slice(0, 69)}...` : sql;
        const hint = new vscode.InlayHint(
          new vscode.Position(line, lineText.length),
          ` → ${compact}`,
          vscode.InlayHintKind.Type,
        );
        hint.paddingLeft = true;
        hint.tooltip = new vscode.MarkdownString(
          `**Compiled SQL (${repo.className}.${method.name})**\n\n\`\`\`sql\n${sql}\n\`\`\``,
        );
        hints.push(hint);
      }
    }

    return hints;
  }
}
