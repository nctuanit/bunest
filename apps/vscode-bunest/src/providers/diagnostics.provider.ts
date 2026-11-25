import * as vscode from "vscode";
import type { BunestWorkspaceSnapshot } from "@bunest/cli";
import {
  sourceLocationToVscodeRange,
  type BunestWorkspaceIndex,
} from "../workspace/workspace-index";
import { findInlineSqlDiagnostics } from "./sql-intellisense.provider";

/**
 * Publishes all Bunest static diagnostics (`BUNEST001..007`,
 * `BUNEST_REPO001..007`, `BUNEST_MACRO001..005`, `BUNEST_DEC001..005`,
 * `BUNEST_ARCH001..002`, `BUNEST_SQL001..002`, and custom rules configured
 * in `bunest.config.ts`) into the VS Code Problems panel.
 */
export class BunestDiagnosticsProvider implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly index: BunestWorkspaceIndex) {
    this.collection = vscode.languages.createDiagnosticCollection("bunest");
    this.subscription = index.onDidUpdate((snapshots) => {
      this.publish(snapshots);
    });
  }

  publish(snapshots: readonly BunestWorkspaceSnapshot[]): void {
    const enabled =
      vscode.workspace
        .getConfiguration("bunest")
        .get<boolean>("diagnostics.enabled") ?? true;

    this.collection.clear();
    if (!enabled) return;

    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const snap of snapshots) {
      for (const diag of snap.diagnostics) {
        const severity =
          diag.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : diag.severity === "warning"
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;

        const vDiag = new vscode.Diagnostic(
          sourceLocationToVscodeRange(diag.location),
          diag.message,
          severity,
        );
        vDiag.code = diag.code;
        vDiag.source = "bunest";

        const list = byFile.get(diag.location.filePath) ?? [];
        list.push(vDiag);
        byFile.set(diag.location.filePath, list);
      }
    }

    // Inline SQL diagnostics for open TypeScript documents (BUNEST_SQL001..002)
    for (const doc of vscode.workspace.textDocuments) {
      if (
        doc.uri.scheme !== "file" ||
        (doc.languageId !== "typescript" && doc.languageId !== "typescriptreact")
      ) {
        continue;
      }
      const sqlDiags = findInlineSqlDiagnostics(doc.getText());
      if (sqlDiags.length === 0) continue;

      const list = byFile.get(doc.uri.fsPath) ?? [];
      for (const d of sqlDiags) {
        const severity =
          d.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : d.severity === "warning"
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;
        const range = new vscode.Range(
          doc.positionAt(d.startOffset),
          doc.positionAt(d.endOffset),
        );
        const vDiag = new vscode.Diagnostic(range, d.message, severity);
        vDiag.code = d.code;
        vDiag.source = "bunest";
        list.push(vDiag);
      }
      byFile.set(doc.uri.fsPath, list);
    }

    for (const [filePath, diags] of byFile) {
      this.collection.set(vscode.Uri.file(filePath), diags);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }
}
