import * as vscode from "vscode";
import type { ExtractedRouteEntry } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export class RouteTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: "controller" | "route",
    public readonly controllerName?: string,
    public readonly route?: ExtractedRouteEntry,
  ) {
    super(label, collapsibleState);
    if (kind === "controller") {
      this.iconPath = new vscode.ThemeIcon("symbol-class");
      this.contextValue = "bunestController";
    } else if (route) {
      this.description = `${route.handlerName}() -> ${route.responseTypeText}`;
      this.tooltip = `${route.method} ${route.path}\nController: ${route.controllerName}.${route.handlerName}()\nBody: ${route.bodyTypeText}\nResponse: ${route.responseTypeText}`;
      this.contextValue = "bunestRoute";
      this.iconPath = new vscode.ThemeIcon("globe");
      if (route.location) {
        this.command = {
          command: "bunest.revealLocation",
          title: "Open Route Handler",
          arguments: [route.location],
        };
      }
    }
  }
}

export class BunestRoutesTreeProvider
  implements vscode.TreeDataProvider<RouteTreeItem>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    RouteTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire(undefined));
  }

  getTreeItem(element: RouteTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RouteTreeItem): RouteTreeItem[] {
    const routes = this.index
      .getAllSnapshots()
      .flatMap((s) => s.scan.routes);

    if (!element) {
      const byController = new Map<string, ExtractedRouteEntry[]>();
      for (const r of routes) {
        const list = byController.get(r.controllerName) ?? [];
        list.push(r);
        byController.set(r.controllerName, list);
      }
      return [...byController.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ctrl, list]) => {
          const item = new RouteTreeItem(
            ctrl,
            vscode.TreeItemCollapsibleState.Expanded,
            "controller",
            ctrl,
          );
          item.description = `${list.length} route${list.length === 1 ? "" : "s"}`;
          return item;
        });
    }

    if (element.kind === "controller" && element.controllerName) {
      return routes
        .filter((r) => r.controllerName === element.controllerName)
        .map(
          (r) =>
            new RouteTreeItem(
              `${r.method} ${r.path}`,
              vscode.TreeItemCollapsibleState.None,
              "route",
              r.controllerName,
              r,
            ),
        );
    }

    return [];
  }
}
