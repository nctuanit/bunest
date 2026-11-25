import * as vscode from "vscode";
import type { ExtractedRouteEntry } from "@bunest/cli";
import { bunestIcon, httpMethodIcon } from "../ui/icons";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export class RouteTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: "controller" | "method-group" | "route",
    public readonly groupKey?: string,
    public readonly route?: ExtractedRouteEntry,
  ) {
    super(label, collapsibleState);
    if (kind === "controller") {
      this.iconPath = bunestIcon("controller", "symbol-class");
      this.contextValue = "bunestController";
    } else if (kind === "method-group") {
      this.iconPath = httpMethodIcon(groupKey ?? "GET");
      this.contextValue = "bunestMethodGroup";
    } else if (route) {
      const guarded = /guard|auth|role|jwt/i.test(
        `${route.controllerName} ${route.handlerName}`,
      );
      this.description = `${guarded ? "🔒 " : ""}${route.handlerName}() → ${route.responseTypeText}`;
      this.tooltip = `${route.method} ${route.path}\nController: ${route.controllerName}.${route.handlerName}()\nBody: ${route.bodyTypeText}\nResponse: ${route.responseTypeText}`;
      this.contextValue = "bunestRoute";
      this.iconPath = httpMethodIcon(route.method);
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

  private filterQuery = "";
  private groupBy: "controller" | "method" = "controller";

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire(undefined));
  }

  setFilter(query: string): void {
    this.filterQuery = query.trim().toLowerCase();
    this.onDidChangeEmitter.fire(undefined);
  }

  getFilter(): string {
    return this.filterQuery;
  }

  toggleGroupBy(): "controller" | "method" {
    this.groupBy = this.groupBy === "controller" ? "method" : "controller";
    this.onDidChangeEmitter.fire(undefined);
    return this.groupBy;
  }

  getTreeItem(element: RouteTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RouteTreeItem): RouteTreeItem[] {
    let routes = this.index
      .getAllSnapshots()
      .flatMap((s) => s.scan.routes);

    if (this.filterQuery) {
      routes = routes.filter((r) =>
        `${r.method} ${r.path} ${r.controllerName} ${r.handlerName}`
          .toLowerCase()
          .includes(this.filterQuery),
      );
    }

    if (!element) {
      const grouped = new Map<string, ExtractedRouteEntry[]>();
      for (const r of routes) {
        const key = this.groupBy === "method" ? r.method : r.controllerName;
        const list = grouped.get(key) ?? [];
        list.push(r);
        grouped.set(key, list);
      }
      return [...grouped.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, list]) => {
          const item = new RouteTreeItem(
            key,
            vscode.TreeItemCollapsibleState.Expanded,
            this.groupBy === "method" ? "method-group" : "controller",
            key,
          );
          item.description = `${list.length} route${list.length === 1 ? "" : "s"}`;
          return item;
        });
    }

    if (
      (element.kind === "controller" || element.kind === "method-group") &&
      element.groupKey
    ) {
      return routes
        .filter((r) =>
          this.groupBy === "method"
            ? r.method === element.groupKey
            : r.controllerName === element.groupKey,
        )
        .map(
          (r) =>
            new RouteTreeItem(
              `${r.method} ${r.path}`,
              vscode.TreeItemCollapsibleState.None,
              "route",
              element.groupKey,
              r,
            ),
        );
    }

    return [];
  }
}
