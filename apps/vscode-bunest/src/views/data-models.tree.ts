import * as vscode from "vscode";
import type {
  AnalyzedEntity,
  AnalyzedRepository,
  SourceLocation,
} from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export class DataModelTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly nodeKind:
      | "section"
      | "repository"
      | "entity"
      | "leaf",
    public readonly sectionId?:
      | "repositories"
      | "entities"
      | "models"
      | "macros",
    public readonly repo?: AnalyzedRepository,
    public readonly entity?: AnalyzedEntity,
    location?: SourceLocation,
  ) {
    super(label, collapsibleState);
    if (location) {
      this.command = {
        command: "bunest.revealLocation",
        title: "Reveal in Source",
        arguments: [location],
      };
    }
  }
}

export class BunestDataModelsTreeProvider
  implements vscode.TreeDataProvider<DataModelTreeItem>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    DataModelTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire(undefined));
  }

  getTreeItem(element: DataModelTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DataModelTreeItem): DataModelTreeItem[] {
    const snaps = this.index.getAllSnapshots();
    const repos = snaps.flatMap((s) => s.repositories);
    const entities = snaps.flatMap((s) => s.entities);
    const models = snaps.flatMap((s) => s.scan.models);
    const macros = snaps.flatMap((s) => s.scan.classMacros);

    if (!element) {
      const sections: DataModelTreeItem[] = [];
      const mkSection = (
        label: string,
        count: number,
        id: "repositories" | "entities" | "models" | "macros",
        icon: string,
      ) => {
        const item = new DataModelTreeItem(
          label,
          count > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
          "section",
          id,
        );
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon(icon);
        sections.push(item);
      };

      mkSection("Declarative Repositories", repos.length, "repositories", "database");
      mkSection("SQL Entities", entities.length, "entities", "table");
      mkSection("Mongoose Models", models.length, "models", "symbol-struct");
      mkSection("Class Macros", macros.length, "macros", "sparkle");
      return sections;
    }

    if (element.nodeKind === "section") {
      if (element.sectionId === "repositories") {
        return repos.map((r) => {
          const item = new DataModelTreeItem(
            r.className,
            vscode.TreeItemCollapsibleState.Collapsed,
            "repository",
            undefined,
            r,
            undefined,
            r.location,
          );
          item.description = `${r.dialect} · ${r.tableName} (${r.methods.length})`;
          item.iconPath = new vscode.ThemeIcon("repo");
          return item;
        });
      }
      if (element.sectionId === "entities") {
        return entities.map((e) => {
          const item = new DataModelTreeItem(
            e.className,
            vscode.TreeItemCollapsibleState.Collapsed,
            "entity",
            undefined,
            undefined,
            e,
            e.location,
          );
          item.description = `table "${e.tableName}" (${e.fields.length} cols)`;
          item.iconPath = new vscode.ThemeIcon("table");
          return item;
        });
      }
      if (element.sectionId === "models") {
        return models.map((m) => {
          const item = new DataModelTreeItem(
            m.name,
            vscode.TreeItemCollapsibleState.None,
            "leaf",
            undefined,
            undefined,
            undefined,
            m.location,
          );
          item.description = m.typeText;
          item.iconPath = new vscode.ThemeIcon("symbol-interface");
          return item;
        });
      }
      if (element.sectionId === "macros") {
        return macros.map((m) => {
          const item = new DataModelTreeItem(
            m.className,
            vscode.TreeItemCollapsibleState.None,
            "leaf",
            undefined,
            undefined,
            undefined,
            m.location,
          );
          item.description = m.decorators.map((d) => `@${d}`).join(" ");
          item.iconPath = new vscode.ThemeIcon("sparkle");
          return item;
        });
      }
    }

    if (element.nodeKind === "repository" && element.repo) {
      return element.repo.methods.map((m) => {
        const item = new DataModelTreeItem(
          `${m.name}(${m.params.map((p) => p.name).join(", ")})`,
          vscode.TreeItemCollapsibleState.None,
          "leaf",
          undefined,
          undefined,
          undefined,
          m.location,
        );
        item.description = m.derived
          ? "derived"
          : m.customQuery
            ? "@Query"
            : m.kind;
        item.tooltip = m.derived?.sqlPreview ?? m.customQuery?.sql ?? m.name;
        item.iconPath = new vscode.ThemeIcon(
          m.derived ? "search" : m.customQuery ? "code" : "symbol-method",
        );
        return item;
      });
    }

    if (element.nodeKind === "entity" && element.entity) {
      return element.entity.fields.map((f) => {
        const badges = [
          f.primary ? "PK" : "",
          f.unique ? "UNIQUE" : "",
          f.indexed ? "IDX" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const item = new DataModelTreeItem(
          f.propertyName,
          vscode.TreeItemCollapsibleState.None,
          "leaf",
          undefined,
          undefined,
          undefined,
          f.location,
        );
        item.description = `${f.tsType} -> ${f.columnName}${badges ? ` [${badges}]` : ""}`;
        item.iconPath = new vscode.ThemeIcon(
          f.primary ? "key" : "symbol-field",
        );
        return item;
      });
    }

    return [];
  }
}
