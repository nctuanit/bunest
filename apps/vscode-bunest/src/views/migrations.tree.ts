import { basename, join, readDirSyncNames, readTextSync, statSyncPath } from "@bunest/core";
import * as vscode from "vscode";
import { bunestIcon } from "../ui/icons";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export interface DiscoveredMigration {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  readonly sqlPreview: string;
}

export interface SchemaDriftWarning {
  readonly entityName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly filePath: string;
  readonly line: number;
}

/**
 * Scans workspace source directories for Bunest `OrmMigration` definitions
 * (`id: "001_..."`, `CREATE TABLE`, `ALTER TABLE`) and detects potential
 * `@Entity()` columns not referenced in any migration file.
 */
export function scanWorkspaceMigrations(
  cwd: string,
): { migrations: DiscoveredMigration[]; migrationSqlCorpus: string } {
  const migrations: DiscoveredMigration[] = [];
  let corpus = "";

  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let names: string[];
    try {
      names = readDirSyncNames(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === ".git" ||
        name === ".bunest"
      ) {
        continue;
      }
      const full = join(dir, name);
      try {
        const st = statSyncPath(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          name.endsWith(".ts") &&
          !name.endsWith(".d.ts") &&
          !name.endsWith(".spec.ts") &&
          (/migration/i.test(name) || /migrations\//i.test(full.replace(/\\/g, "/")))
        ) {
          const text = readTextSync(full);
          corpus += "\n" + text;
          const idRe = /id\s*:\s*["'`]([A-Za-z0-9_.-]+)["'`]/g;
          let m: RegExpExecArray | null;
          let foundAny = false;
          while ((m = idRe.exec(text)) !== null) {
            foundAny = true;
            const line = text.slice(0, m.index).split(/\r?\n/).length;
            const snippet = text
              .slice(m.index, m.index + 320)
              .replace(/\s+/g, " ")
              .trim();
            migrations.push({
              id: m[1]!,
              name: basename(full),
              filePath: full,
              line,
              sqlPreview: snippet.slice(0, 120),
            });
          }
          if (!foundAny && /CREATE\s+TABLE|ALTER\s+TABLE/i.test(text)) {
            migrations.push({
              id: basename(full, ".ts"),
              name: basename(full),
              filePath: full,
              line: 1,
              sqlPreview: "SQL migration module",
            });
          }
        }
      } catch {
        // ignore
      }
    }
  };

  walk(cwd, 0);
  migrations.sort((a, b) => a.id.localeCompare(b.id));
  return { migrations, migrationSqlCorpus: corpus };
}

export function detectSchemaDrift(
  index: BunestWorkspaceIndex,
  migrationSqlCorpus: string,
): SchemaDriftWarning[] {
  if (!migrationSqlCorpus.trim()) return [];
  const lowerCorpus = migrationSqlCorpus.toLowerCase();
  const warnings: SchemaDriftWarning[] = [];

  for (const snap of index.getAllSnapshots()) {
    for (const ent of snap.entities) {
      const tableName = (ent.tableName || ent.className.toLowerCase()).toLowerCase();
      if (!lowerCorpus.includes(tableName)) {
        warnings.push({
          entityName: ent.className,
          tableName,
          columnName: "*",
          filePath: ent.location.filePath,
          line: ent.location.line,
        });
        continue;
      }
      for (const field of ent.fields) {
        const colName = (
          field.columnName ||
          field.propertyName
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .toLowerCase()
        ).toLowerCase();
        if (!lowerCorpus.includes(colName)) {
          warnings.push({
            entityName: ent.className,
            tableName,
            columnName: colName,
            filePath: ent.location.filePath,
            line: ent.location.line,
          });
        }
      }
    }
  }
  return warnings;
}

export class MigrationTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: "group" | "migration" | "drift",
    public readonly filePath?: string,
    public readonly line?: number,
  ) {
    super(label, collapsibleState);
    if (kind === "group") {
      this.iconPath = bunestIcon("migration", "folder-library");
    } else if (kind === "migration") {
      this.iconPath = bunestIcon("migration", "git-commit");
      this.contextValue = "bunestMigration";
    } else {
      this.iconPath = bunestIcon("drift", "warning");
      this.contextValue = "bunestSchemaDrift";
    }
    if (filePath && line) {
      this.command = {
        command: "bunest.revealLocation",
        title: "Open Source",
        arguments: [{ filePath, line, column: 1, endLine: line, endColumn: 1 }],
      };
    }
  }
}

export class BunestMigrationsTreeProvider
  implements vscode.TreeDataProvider<MigrationTreeItem>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    MigrationTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire(undefined));
  }

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: MigrationTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: MigrationTreeItem): MigrationTreeItem[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return [];

    const allMigrations: DiscoveredMigration[] = [];
    let fullCorpus = "";
    for (const f of folders) {
      const scanned = scanWorkspaceMigrations(f.uri.fsPath);
      allMigrations.push(...scanned.migrations);
      fullCorpus += "\n" + scanned.migrationSqlCorpus;
    }
    const drift = detectSchemaDrift(this.index, fullCorpus);

    if (!element) {
      if (allMigrations.length === 0 && drift.length === 0) {
        return [];
      }
      const roots: MigrationTreeItem[] = [];
      const migGroup = new MigrationTreeItem(
        `Migrations (${allMigrations.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
        "group",
      );
      migGroup.id = "bunest.migGroup";
      roots.push(migGroup);

      if (drift.length > 0) {
        const driftGroup = new MigrationTreeItem(
          `Potential Schema Drift (${drift.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          "group",
        );
        driftGroup.id = "bunest.driftGroup";
        driftGroup.iconPath = new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("charts.yellow"),
        );
        roots.push(driftGroup);
      }
      return roots;
    }

    if (element.id === "bunest.migGroup") {
      return allMigrations.map((m) => {
        const item = new MigrationTreeItem(
          m.id,
          vscode.TreeItemCollapsibleState.None,
          "migration",
          m.filePath,
          m.line,
        );
        item.description = m.name;
        item.tooltip = `${m.id}\nFile: ${m.filePath}:${m.line}\n${m.sqlPreview}`;
        return item;
      });
    }

    if (element.id === "bunest.driftGroup") {
      return drift.map((d) => {
        const label =
          d.columnName === "*"
            ? `Missing table "${d.tableName}"`
            : `Missing column "${d.tableName}.${d.columnName}"`;
        const item = new MigrationTreeItem(
          label,
          vscode.TreeItemCollapsibleState.None,
          "drift",
          d.filePath,
          d.line,
        );
        item.description = d.entityName;
        item.tooltip = `@Entity "${d.entityName}" references "${d.tableName}.${d.columnName}" which was not found in scanned migration files.`;
        return item;
      });
    }

    return [];
  }
}
