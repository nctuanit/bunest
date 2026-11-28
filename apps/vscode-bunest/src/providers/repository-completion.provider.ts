import * as vscode from "vscode";
import { getRepositoryDerivedCompletions } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

/**
 * Spring Data-style Chained Derived Query Autocomplete for Bunest declarative
 * repositories (`@Repository` + `CrudRepository` from `@bunest/orm`).
 */
export class BunestRepositoryCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly index: BunestWorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const ctx = this.index.getContextForFile(document.uri.fsPath);
    if (!ctx?.snapshot) return undefined;

    const reposInFile = ctx.snapshot.repositories.filter(
      (r) => r.sourceFile === document.uri.fsPath,
    );
    if (reposInFile.length === 0) return undefined;

    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.slice(0, position.character);

    // Match `abstract <prefix>` or bare method identifier inside a repository class
    const match = /^\s*(?:public\s+|protected\s+)?abstract\s+([A-Za-z0-9_]*)$/.exec(
      beforeCursor,
    );
    if (!match) return undefined;

    const typedPrefix = match[1] ?? "";
    const cursorLine1 = position.line + 1;

    // Find the enclosing repository class declaration
    const targetRepo = reposInFile
      .filter((r) => r.location.line <= cursorLine1)
      .sort((a, b) => b.location.line - a.location.line)[0];
    if (!targetRepo) return undefined;

    const suggestions = getRepositoryDerivedCompletions(
      targetRepo,
      typedPrefix,
      { bunestConfig: ctx.bunestConfig },
    );
    if (suggestions.length === 0) return undefined;

    const replaceStart = new vscode.Position(
      position.line,
      position.character - typedPrefix.length,
    );
    const replaceRange = new vscode.Range(replaceStart, position);

    const COMPLETION_KIND_MAP: Readonly<
      Record<string, vscode.CompletionItemKind>
    > = {
      fullMethod: vscode.CompletionItemKind.Method,
      property: vscode.CompletionItemKind.Field,
      operator: vscode.CompletionItemKind.Operator,
    };

    return suggestions.map((s) => {
      const kind =
        COMPLETION_KIND_MAP[s.kind] ?? vscode.CompletionItemKind.Keyword;

      const item = new vscode.CompletionItem(s.label, kind);
      item.detail = s.detail;
      item.sortText = s.sortText;
      item.insertText = s.insertText;
      item.range = replaceRange;
      item.filterText =
        s.kind === "property" || s.kind === "operator" || s.kind === "combinator"
          ? `${typedPrefix}${s.label}`
          : s.label;

      if (s.documentation) {
        item.documentation = new vscode.MarkdownString(s.documentation);
      }

      // Automatically re-trigger suggest after chaining `And` / `Or` / `OrderBy` / prefixes
      if (s.kind === "prefix" || s.kind === "combinator") {
        item.command = {
          command: "editor.action.triggerSuggest",
          title: "Continue derived query",
        };
      }

      return item;
    });
  }
}
