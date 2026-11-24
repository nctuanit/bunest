import * as vscode from "vscode";
import type { BunestWorkspaceSnapshot, SourceLocation } from "@bunest/cli";
import {
  sourceLocationToVscodeLocation,
  type BunestWorkspaceIndex,
} from "../workspace/workspace-index";

function isPosInLocation(
  line1: number,
  col1: number,
  loc: SourceLocation,
): boolean {
  if (line1 < loc.line || line1 > loc.endLine) return false;
  if (line1 === loc.line && col1 < loc.column) return false;
  if (line1 === loc.endLine && col1 > loc.endColumn) return false;
  return true;
}

/**
 * Bidirectional Cross-Jump Navigation (`Cmd+Click` Definition & Find All References) for:
 * - Derived Repository Method segments <-> Entity `@Column` properties
 * - `@Delegate()` properties -> target type declaration
 * - Events (`@OnEvent` / `@EmitEvent` / `eventEmitter.emit`)
 * - RPC (`@MessagePattern` / `@EventPattern` / `client.send` / `client.emit`)
 * - Mongoose Models & Connections (`@InjectModel` / `@InjectConnection`)
 * - Config keys (`configService.get` / `@ConfigValue` -> `registerAs` / `.env`)
 * - CQRS Commands & Queries (`commandBus.execute` / `queryBus.execute` -> `@CommandHandler` / `@QueryHandler`)
 * - DI String Tokens (`@Inject("TOKEN")` / `moduleRef.get("TOKEN")`)
 */
export class BunestDefinitionProvider
  implements vscode.DefinitionProvider, vscode.ReferenceProvider
{
  constructor(private readonly index: BunestWorkspaceIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] | undefined {
    const snap = this.index.getSnapshotForFile(document.uri.fsPath);
    if (!snap) return undefined;

    const filePath = document.uri.fsPath;
    const line1 = position.line + 1;
    const col1 = position.character + 1;

    // 1. Derived repository method segment -> Entity property/@Column
    const repoJump = this.findEntityFieldJump(snap, filePath, line1, col1);
    if (repoJump) return [repoJump];

    // 2. @Delegate() property -> target type declaration
    for (const macro of snap.scan.classMacros) {
      if (macro.sourceFile !== filePath) continue;
      for (const del of macro.delegates) {
        if (
          del.targetLocation &&
          isPosInLocation(line1, col1, del.location)
        ) {
          return [sourceLocationToVscodeLocation(del.targetLocation)];
        }
      }
    }

    // 3. Call-site string/symbol -> Registered definition
    const callSite = snap.scan.callSites.find(
      (cs) =>
        cs.location.filePath === filePath &&
        isPosInLocation(line1, col1, cs.location),
    );
    if (!callSite) return undefined;

    return this.resolveCallSiteTargets(snap, callSite.kind, callSite.key);
  }

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] | undefined {
    const snap = this.index.getSnapshotForFile(document.uri.fsPath);
    if (!snap) return undefined;

    const filePath = document.uri.fsPath;
    const line1 = position.line + 1;
    const col1 = position.character + 1;

    // Check if cursor is on any call site or definition key
    const cs = snap.scan.callSites.find(
      (c) =>
        c.location.filePath === filePath &&
        isPosInLocation(line1, col1, c.location),
    );
    if (cs) {
      return this.collectAllReferences(snap, cs.kind, cs.key);
    }

    // Check if cursor is on an event/RPC/model/token definition
    const ev = snap.scan.events.find(
      (e) =>
        e.location?.filePath === filePath &&
        isPosInLocation(line1, col1, e.location),
    );
    if (ev) return this.collectAllReferences(snap, "event", ev.eventName);

    const mp = snap.scan.messagePatterns.find(
      (m) =>
        m.location?.filePath === filePath &&
        isPosInLocation(line1, col1, m.location),
    );
    if (mp)
      return this.collectAllReferences(snap, "messagePattern", mp.patternKey);

    const ep = snap.scan.eventPatterns.find(
      (e) =>
        e.location?.filePath === filePath &&
        isPosInLocation(line1, col1, e.location),
    );
    if (ep)
      return this.collectAllReferences(snap, "eventPattern", ep.patternKey);

    const model = snap.scan.models.find(
      (m) =>
        m.location?.filePath === filePath &&
        isPosInLocation(line1, col1, m.location),
    );
    if (model) return this.collectAllReferences(snap, "model", model.name);

    return undefined;
  }

  private findEntityFieldJump(
    snap: BunestWorkspaceSnapshot,
    filePath: string,
    line1: number,
    col1: number,
  ): vscode.Location | undefined {
    for (const repo of snap.repositories) {
      if (repo.sourceFile !== filePath || !repo.entity) continue;
      for (const m of repo.methods) {
        if (!m.derived || !isPosInLocation(line1, col1, m.location)) continue;
        const offsetInName = col1 - m.location.column;
        for (const cond of m.derived.conditions) {
          if (
            cond.field &&
            offsetInName >= cond.segmentStart &&
            offsetInName <= cond.segmentEnd
          ) {
            return sourceLocationToVscodeLocation(cond.field.location);
          }
        }
        for (const ord of m.derived.orderBy) {
          if (
            ord.field &&
            offsetInName >= ord.segmentStart &&
            offsetInName <= ord.segmentEnd
          ) {
            return sourceLocationToVscodeLocation(ord.field.location);
          }
        }
        // Fallback: jump to Entity class itself
        return sourceLocationToVscodeLocation(repo.entity.location);
      }
    }
    return undefined;
  }

  private resolveCallSiteTargets(
    snap: BunestWorkspaceSnapshot,
    kind: string,
    key: string,
  ): vscode.Location[] | undefined {
    const results: vscode.Location[] = [];
    switch (kind) {
      case "event": {
        const ev = snap.scan.events.find((e) => e.eventName === key);
        if (ev?.locations) {
          for (const loc of ev.locations) {
            results.push(sourceLocationToVscodeLocation(loc));
          }
        } else if (ev?.location) {
          results.push(sourceLocationToVscodeLocation(ev.location));
        }
        break;
      }
      case "messagePattern": {
        const mp = snap.scan.messagePatterns.find((m) => m.patternKey === key);
        if (mp?.location) results.push(sourceLocationToVscodeLocation(mp.location));
        break;
      }
      case "eventPattern": {
        const ep = snap.scan.eventPatterns.find((e) => e.patternKey === key);
        if (ep?.location) results.push(sourceLocationToVscodeLocation(ep.location));
        break;
      }
      case "model": {
        const m = snap.scan.models.find((x) => x.name === key);
        if (m?.location) results.push(sourceLocationToVscodeLocation(m.location));
        break;
      }
      case "connection": {
        const c = snap.scan.connections.find((x) => x.name === key);
        if (c?.location) results.push(sourceLocationToVscodeLocation(c.location));
        break;
      }
      case "config": {
        const rootNs = key.split(".")[0]!;
        const ns = snap.scan.configNamespaces.find((c) => c.namespace === rootNs);
        if (ns?.location) results.push(sourceLocationToVscodeLocation(ns.location));
        const env = snap.scan.envKeys.find((e) => e.key === key);
        if (env?.location) results.push(sourceLocationToVscodeLocation(env.location));
        break;
      }
      case "command": {
        const cmd = snap.scan.commands.find((c) => c.key === key);
        if (cmd?.location) results.push(sourceLocationToVscodeLocation(cmd.location));
        break;
      }
      case "query": {
        const q = snap.scan.queries.find((x) => x.key === key);
        if (q?.location) results.push(sourceLocationToVscodeLocation(q.location));
        break;
      }
      case "token": {
        const t = snap.scan.tokens.find((x) => x.token === key);
        if (t?.location) results.push(sourceLocationToVscodeLocation(t.location));
        break;
      }
    }
    return results.length > 0 ? results : undefined;
  }

  private collectAllReferences(
    snap: BunestWorkspaceSnapshot,
    kind: string,
    key: string,
  ): vscode.Location[] {
    const locs = this.resolveCallSiteTargets(snap, kind, key) ?? [];
    for (const cs of snap.scan.callSites) {
      if (cs.kind === kind && cs.key === key) {
        locs.push(sourceLocationToVscodeLocation(cs.location));
      }
    }
    return locs;
  }
}
