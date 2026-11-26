import * as vscode from "vscode";
import {
  sourceLocationToVscodeRange,
  type BunestWorkspaceIndex,
} from "../workspace/workspace-index";

/**
 * Provides inline CodeLens actions across Bunest TypeScript files:
 * - HTTP Routes: `▶ Send Request` | `📋 Copy URL`
 * - Derived Repository methods: `🗄 SQL Preview` | `⚡ Convert to @Query`
 * - Events / RPC handlers: `🔗 N references`
 * - `*.spec.ts` / `*.test.ts`: `▶ Run bun test`
 */
export class BunestCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const enabled =
      vscode.workspace
        .getConfiguration("bunest")
        .get<boolean>("codelens.enabled") ?? true;
    if (!enabled) return [];

    const filePath = document.uri.fsPath;
    const lenses: vscode.CodeLens[] = [];

    // 1. Test files (`*.spec.ts` / `*.test.ts`) -> `▶ Run bun test`
    if (/\.(?:spec|test)\.tsx?$/i.test(filePath)) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: "▶ Run bun test",
          command: "bunest.runBunTest",
          arguments: [filePath],
        }),
      );
      return lenses;
    }

    const ctx = this.index.getContextForFile(filePath);
    const snap = ctx?.snapshot;
    if (!ctx || !snap) return lenses;

    // 2. HTTP Route handlers
    for (const route of snap.scan.routes) {
      if (route.location?.filePath !== filePath) continue;
      const range = sourceLocationToVscodeRange(route.location);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `▶ Send ${route.method} ${route.path}`,
          command: "bunest.sendRequest",
          arguments: [route],
        }),
        new vscode.CodeLens(range, {
          title: "📋 Copy URL",
          command: "bunest.copyRouteUrl",
          arguments: [route],
        }),
      );
    }

    // 3. Declarative Repository Queries (Derived & Explicit @Query)
    for (const repo of snap.repositories) {
      if (repo.sourceFile !== filePath) continue;
      for (const m of repo.methods) {
        if (m.customQuery && m.customQuery.sql.trim().length > 0) {
          const decRange = sourceLocationToVscodeRange(
            m.customQuery.decoratorLocation,
          );
          lenses.push(
            new vscode.CodeLens(decRange, {
              title: "▶ Run Query",
              command: "bunest.executeRawQuery",
              arguments: [
                {
                  sql: m.customQuery.sql,
                  title: `${repo.className}.${m.name}()`,
                  cwd: ctx.cwd,
                  repo,
                  method: m,
                },
              ],
              tooltip: `Execute @Query SQL directly against your database (${repo.dialect})`,
            }),
          );
          continue;
        }
        if (!m.derived) continue;
        const range = sourceLocationToVscodeRange(m.location);
        const compactSql =
          m.derived.sqlPreview.length > 72
            ? `${m.derived.sqlPreview.slice(0, 69)}...`
            : m.derived.sqlPreview;
        lenses.push(
          new vscode.CodeLens(range, {
            title: "▶ Run SQL",
            command: "bunest.executeRawQuery",
            arguments: [
              {
                sql: m.derived.sqlPreview,
                title: `${repo.className}.${m.name}()`,
                cwd: ctx.cwd,
                repo,
                method: m,
              },
            ],
            tooltip: "Execute compiled SQL directly against your database",
          }),
          new vscode.CodeLens(range, {
            title: `SQL: ${compactSql}`,
            command: "bunest.previewRepositorySql",
            arguments: [repo, m],
          }),
        );
      }
    }

    // 4. Events & RPC reference counts
    for (const ev of snap.scan.events) {
      if (ev.location?.filePath !== filePath) continue;
      const count = snap.scan.callSites.filter(
        (c) => c.kind === "event" && c.key === ev.eventName,
      ).length;
      lenses.push(
        new vscode.CodeLens(sourceLocationToVscodeRange(ev.location), {
          title: `${count} event ref${count === 1 ? "" : "s"} (${ev.eventName})`,
          command: "bunest.revealLocation",
          arguments: [ev.location],
        }),
      );
    }

    return lenses;
  }
}
