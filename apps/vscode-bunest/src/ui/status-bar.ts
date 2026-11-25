import * as vscode from "vscode";
import {
  detectSqlDialect,
  discoverWorkspaceDatabaseCandidates,
  maskDatabaseUrl,
} from "../sql/raw-query-runner";
import { probeLocalBunestApp } from "../webview/live-inspector.panel";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

/**
 * Manages Bunest's interactive Status Bar items:
 * 1. Workspace summary (`$(zap) Bunest: N routes · M repos`) -> Quick Menu
 * 2. Active SQL Runner connection (`$(database) postgres: ...`) -> Switch DB
 * 3. Local app liveness indicator (`$(pulse) Live`) -> Live App Inspector
 */
export class BunestStatusBarManager implements vscode.Disposable {
  private readonly summaryItem: vscode.StatusBarItem;
  private readonly dbItem: vscode.StatusBarItem;
  private readonly liveItem: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;
  private readonly configSub: vscode.Disposable;
  private readonly liveTimer: ReturnType<typeof setInterval>;

  constructor(private readonly index: BunestWorkspaceIndex) {
    this.summaryItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.summaryItem.command = "bunest.openQuickMenu";
    this.summaryItem.tooltip = "Bunest — Open Quick Actions Menu";

    this.dbItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    this.dbItem.command = "bunest.configureDatabaseConnection";
    this.dbItem.tooltip = "Bunest SQL Runner — Click to switch database connection";

    this.liveItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98,
    );
    this.liveItem.command = "bunest.openLiveInspector";
    this.liveItem.tooltip = "Bunest Local Server — Click to open Live App Inspector";

    this.sub = index.onDidUpdate(() => this.refresh());
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bunest")) {
        this.refresh();
      }
    });

    this.refresh();
    void this.probeLive();
    this.liveTimer = setInterval(() => {
      void this.probeLive();
    }, 15_000);
    if (typeof this.liveTimer === "object" && this.liveTimer && "unref" in this.liveTimer) {
      this.liveTimer.unref();
    }
  }

  refresh(): void {
    const snaps = this.index.getAllSnapshots();
    const routeCount = snaps.reduce((sum, s) => sum + s.scan.routes.length, 0);
    const repoCount = snaps.reduce((sum, s) => sum + s.repositories.length, 0);
    const errorCount = snaps.reduce(
      (sum, s) =>
        sum + s.diagnostics.filter((d) => d.severity === "error").length,
      0,
    );

    const errSuffix = errorCount > 0 ? ` · $(error) ${errorCount}` : "";
    this.summaryItem.text = `$(zap) Bunest: ${routeCount} route${routeCount === 1 ? "" : "s"} · ${repoCount} repo${repoCount === 1 ? "" : "s"}${errSuffix}`;
    this.summaryItem.show();

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const configuredUrl = vscode.workspace
      .getConfiguration("bunest")
      .get<string>("sql.databaseUrl")
      ?.trim();

    if (configuredUrl) {
      const dialect = detectSqlDialect(configuredUrl);
      const masked = maskDatabaseUrl(configuredUrl, cwd, dialect);
      this.dbItem.text = `$(database) ${dialect}: ${masked.length > 28 ? `${masked.slice(0, 25)}...` : masked}`;
      this.dbItem.backgroundColor = undefined;
    } else {
      const candidates = discoverWorkspaceDatabaseCandidates(cwd);
      if (candidates.length > 0) {
        const first = candidates[0]!;
        this.dbItem.text = `$(database) ${first.connection.dialect ?? "db"}: ${first.label.length > 26 ? `${first.label.slice(0, 23)}...` : first.label}`;
        this.dbItem.backgroundColor = undefined;
      } else {
        this.dbItem.text = "$(database) Bunest DB: Not configured";
        this.dbItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
      }
    }
    this.dbItem.show();
  }

  private async probeLive(): Promise<void> {
    const baseUrl =
      vscode.workspace
        .getConfiguration("bunest")
        .get<string>("http.baseUrl") ?? "http://localhost:3000";
    const snap = await probeLocalBunestApp(baseUrl);
    if (snap.reachable && snap.liveOk) {
      this.liveItem.text = snap.readyOk
        ? `$(pulse) Bunest Live`
        : `$(warning) Bunest Not Ready`;
      this.liveItem.backgroundColor = snap.readyOk
        ? undefined
        : new vscode.ThemeColor("statusBarItem.warningBackground");
      this.liveItem.show();
    } else {
      this.liveItem.hide();
    }
  }

  dispose(): void {
    clearInterval(this.liveTimer);
    this.sub.dispose();
    this.configSub.dispose();
    this.summaryItem.dispose();
    this.dbItem.dispose();
    this.liveItem.dispose();
  }
}
