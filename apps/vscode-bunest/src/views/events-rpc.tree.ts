import * as vscode from "vscode";
import type { SourceLocation } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

type EventsSectionId = "events" | "rpc" | "cqrs" | "config";

export class EventsRpcTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly sectionId?: EventsSectionId,
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

export class BunestEventsRpcTreeProvider
  implements vscode.TreeDataProvider<EventsRpcTreeItem>
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    EventsRpcTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly index: BunestWorkspaceIndex) {
    index.onDidUpdate(() => this.onDidChangeEmitter.fire(undefined));
  }

  getTreeItem(element: EventsRpcTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: EventsRpcTreeItem): EventsRpcTreeItem[] {
    const snaps = this.index.getAllSnapshots();
    const events = snaps.flatMap((s) => s.scan.events);
    const msgPatterns = snaps.flatMap((s) => s.scan.messagePatterns);
    const evtPatterns = snaps.flatMap((s) => s.scan.eventPatterns);
    const commands = snaps.flatMap((s) => s.scan.commands);
    const queries = snaps.flatMap((s) => s.scan.queries);
    const configNs = snaps.flatMap((s) => s.scan.configNamespaces);
    const envKeys = snaps.flatMap((s) => s.scan.envKeys);

    if (!element) {
      const mk = (
        label: string,
        count: number,
        id: EventsSectionId,
        icon: string,
      ) => {
        const item = new EventsRpcTreeItem(
          label,
          count > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
          id,
        );
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
      };
      return [
        mk("Events", events.length, "events", "bell"),
        mk("RPC Patterns", msgPatterns.length + evtPatterns.length, "rpc", "radio-tower"),
        mk("CQRS Handlers", commands.length + queries.length, "cqrs", "layers"),
        mk("Config & .env", configNs.length + envKeys.length, "config", "settings-gear"),
      ];
    }

    switch (element.sectionId) {
      case "events":
        return events.map((e) => {
          const item = new EventsRpcTreeItem(
            e.eventName,
            vscode.TreeItemCollapsibleState.None,
            undefined,
            e.location,
          );
          item.description = e.payloadTypeText;
          item.iconPath = new vscode.ThemeIcon("broadcast");
          return item;
        });
      case "rpc":
        return [
          ...msgPatterns.map((m) => {
            const item = new EventsRpcTreeItem(
              m.patternKey,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              m.location,
            );
            item.description = `@MessagePattern (${m.requestTypeText} -> ${m.responseTypeText})`;
            item.iconPath = new vscode.ThemeIcon("arrow-swap");
            return item;
          }),
          ...evtPatterns.map((e) => {
            const item = new EventsRpcTreeItem(
              e.patternKey,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              e.location,
            );
            item.description = `@EventPattern (${e.payloadTypeText})`;
            item.iconPath = new vscode.ThemeIcon("arrow-right");
            return item;
          }),
        ];
      case "cqrs":
        return [
          ...commands.map((c) => {
            const item = new EventsRpcTreeItem(
              c.key,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              c.location,
            );
            item.description = `Command -> ${c.resultTypeText}`;
            item.iconPath = new vscode.ThemeIcon("symbol-event");
            return item;
          }),
          ...queries.map((q) => {
            const item = new EventsRpcTreeItem(
              q.key,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              q.location,
            );
            item.description = `Query -> ${q.resultTypeText}`;
            item.iconPath = new vscode.ThemeIcon("search");
            return item;
          }),
        ];
      case "config":
        return [
          ...configNs.map((c) => {
            const item = new EventsRpcTreeItem(
              c.namespace,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              c.location,
            );
            item.description = `registerAs (${c.typeText})`;
            item.iconPath = new vscode.ThemeIcon("symbol-namespace");
            return item;
          }),
          ...envKeys.map((e) => {
            const item = new EventsRpcTreeItem(
              e.key,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              e.location,
            );
            item.description = ".env";
            item.iconPath = new vscode.ThemeIcon("key");
            return item;
          }),
        ];
      default:
        return [];
    }
  }
}
