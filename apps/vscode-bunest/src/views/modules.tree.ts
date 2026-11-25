import * as vscode from "vscode";
import type { StaticModuleNode, SourceLocation } from "@bunest/cli";
import { bunestIcon } from "../ui/icons";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export class ModuleTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: "module" | "group" | "leaf",
    public readonly mod?: StaticModuleNode,
    public readonly groupKey?: "imports" | "controllers" | "providers" | "exports",
    location?: SourceLocation,
  ) {
    super(label, collapsibleState);
    if (location) {
      this.command = {
        command: "bunest.revealLocation",
        title: "Open Definition",
        arguments: [location],
      };
    }
  }
}

export class BunestModulesTreeProvider
  implements vscode.TreeDataProvider<ModuleTreeItem>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    ModuleTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire(undefined));
  }

  getTreeItem(element: ModuleTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ModuleTreeItem): ModuleTreeItem[] {
    const snaps = this.index.getAllSnapshots();
    const modules = snaps.flatMap((s) => s.moduleGraph.modules);
    const providerMap = new Map(
      snaps.flatMap((s) => [...s.moduleGraph.providerByName.entries()]),
    );
    const moduleMap = new Map(
      snaps.flatMap((s) => [...s.moduleGraph.moduleByName.entries()]),
    );

    if (!element) {
      return modules.map((m) => {
        const badges = [
          m.isGlobal ? "@Global" : "",
          m.autoDiscover ? "@AutoModule" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const item = new ModuleTreeItem(
          m.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          "module",
          m,
          undefined,
          m.location,
        );
        item.description = badges || `${m.providers.length} providers · ${m.controllers.length} ctrls`;
        item.iconPath = m.isGlobal
          ? bunestIcon("module-global", "globe")
          : bunestIcon("module", "package");
        return item;
      });
    }

    if (element.kind === "module" && element.mod) {
      const m = element.mod;
      const groups: ModuleTreeItem[] = [];
      const addGroup = (
        label: string,
        key: "imports" | "controllers" | "providers" | "exports",
        items: readonly string[],
      ) => {
        if (items.length === 0) return;
        const g = new ModuleTreeItem(
          label,
          vscode.TreeItemCollapsibleState.Expanded,
          "group",
          m,
          key,
        );
        g.description = String(items.length);
        groups.push(g);
      };
      addGroup("Imports", "imports", m.imports);
      addGroup("Controllers", "controllers", m.controllers);
      addGroup("Providers", "providers", m.providers);
      addGroup("Exports", "exports", m.exports);
      return groups;
    }

    if (element.kind === "group" && element.mod && element.groupKey) {
      const list = element.mod[element.groupKey];
      return list.map((name) => {
        const prov = providerMap.get(name);
        const mod = moduleMap.get(name);
        const loc = prov?.location ?? mod?.location;
        const item = new ModuleTreeItem(
          name,
          vscode.TreeItemCollapsibleState.None,
          "leaf",
          undefined,
          undefined,
          loc,
        );
        if (prov) {
          item.description = prov.scope !== "SINGLETON" ? prov.scope : prov.kind;
          item.iconPath =
            prov.kind === "controller"
              ? bunestIcon("controller", "globe")
              : prov.kind === "repository"
                ? bunestIcon("repository", "database")
                : bunestIcon("service", "symbol-class");
        } else if (mod) {
          item.description = "module";
          item.iconPath = new vscode.ThemeIcon("package");
        }
        return item;
      });
    }

    return [];
  }
}
