import * as vscode from "vscode";
import type { BunestWorkspaceSnapshot } from "@bunest/cli";
import {
  sourceLocationToVscodeRange,
  type BunestWorkspaceIndex,
} from "../workspace/workspace-index";

/**
 * Publishes all Bunest static diagnostics (`BUNEST001..007`,
 * `BUNEST_REPO001..007`, `BUNEST_MACRO001..005`, `BUNEST_DEC001..005`,
 * `BUNEST_ARCH001..002`, and custom rules configured in `bunest.config.ts`)
 * into the VS Code Problems panel.
 */
export class BunestDiagnosticsProvider implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly subscription: vscode.Disposable;

  constructor(index: BunestWorkspaceIndex) {
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

    for (const [filePath, diags] of byFile) {
      this.collection.set(vscode.Uri.file(filePath), diags);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }
}
