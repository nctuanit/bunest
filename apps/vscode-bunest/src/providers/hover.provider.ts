import * as vscode from "vscode";
import { resolveClassMacroMembers, type SourceLocation } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

function isPosNearLocation(
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
 * Rich Hover Previews for:
 * - Declarative Repository Derived Queries (multi-dialect Compiled SQL: SQLite / Postgres / MySQL)
 * - Custom `@Query()` methods (placeholders + `@Modifying` status)
 * - Class Macros (`@Data`, `@Value`, `@Builder`, `@SuperBuilder`, `@WithLogger`, `@Delegate`, `@FieldNameConstants` -> Generated Members table)
 * - Config / `.env` keys (with automatic redaction for sensitive keys!)
 * - HTTP Route handlers (full path + params/query/body/response contract)
 * - Events & RPC patterns
 */
export class BunestHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: BunestWorkspaceIndex) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const ctx = this.index.getContextForFile(document.uri.fsPath);
    const snap = ctx?.snapshot;
    if (!ctx || !snap) return undefined;

    const filePath = document.uri.fsPath;
    const line1 = position.line + 1;
    const col1 = position.character + 1;

    // 1. Declarative Repository Methods (Compiled SQL Preview)
    for (const repo of snap.repositories) {
      if (repo.sourceFile !== filePath) continue;
      for (const m of repo.methods) {
        const onCustomDecorator =
          m.customQuery !== undefined &&
          isPosNearLocation(line1, col1, m.customQuery.decoratorLocation);
        if (!onCustomDecorator && !isPosNearLocation(line1, col1, m.location)) {
          continue;
        }

        if (m.derived) {
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(
            `### Bunest Declarative Query — \`${repo.className}.${m.name}\`\n\n`,
          );
          md.appendMarkdown(
            `**Compiled SQL (${repo.dialect}):**\n\`\`\`sql\n${m.derived.sqlPreview}\n\`\`\`\n`,
          );
          if (repo.dialect !== "postgres") {
            md.appendMarkdown(
              `**Postgres dialect:** \`${m.derived.sqlByDialect.postgres}\`\n\n`,
            );
          }
          if (m.derived.kind === "findPage") {
            md.appendMarkdown(`- **Pagination:** Offset \`Page<T>\` (\`Pageable\`)\n`);
          } else if (m.derived.kind === "findCursor") {
            md.appendMarkdown(`- **Pagination:** Keyset \`CursorPage<T>\` (\`CursorPageable\`)\n`);
          }
          if (m.projectedFields && m.projectedFields.length > 0) {
            md.appendMarkdown(
              `- **@Projection:** ${m.projectedFields.map((f) => `\`${f}\``).join(", ")}\n`,
            );
          }
          if (m.derived.activeScopes && m.derived.activeScopes.length > 0) {
            md.appendMarkdown(
              `- **Active scopes:** ${m.derived.activeScopes.map((s) => `\`${s}\``).join(", ")}\n`,
            );
          }
          if (m.ignoreAllScopes) {
            md.appendMarkdown(`- **@IgnoreScope:** all repository scopes disabled\n`);
          } else if (m.ignoredScopes && m.ignoredScopes.length > 0) {
            md.appendMarkdown(
              `- **@IgnoreScope:** ${m.ignoredScopes.map((s) => `\`${s}\``).join(", ")}\n`,
            );
          }
          md.appendMarkdown(
            `**Expected Signature:** \`(${m.derived.expectedParams.map((p) => `${p.name}: ${p.tsType}`).join(", ")}): ${m.derived.expectedReturnType}\``,
          );
          return new vscode.Hover(md);
        }

        if (m.customQuery) {
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(
            `### Bunest \`@Query\` — \`${repo.className}.${m.name}\`\n\n`,
          );
          md.appendMarkdown(`\`\`\`sql\n${m.customQuery.sql}\n\`\`\`\n`);
          md.appendMarkdown(
            `- **Write query:** ${m.customQuery.isWriteSql ? "Yes" : "No"} (\`@Modifying\`: ${m.customQuery.isModifying ? "Yes" : "Missing"})\n`,
          );
          if (m.customQuery.namedPlaceholders.length > 0) {
            md.appendMarkdown(
              `- **Named placeholders:** ${m.customQuery.namedPlaceholders.map((p) => `\`:${p}\``).join(", ")}\n`,
            );
          }
          if (m.customQuery.sql.trim().length > 0) {
            const cmdArgs = encodeURIComponent(
              JSON.stringify([
                {
                  sql: m.customQuery.sql,
                  title: `${repo.className}.${m.name}()`,
                  cwd: ctx.cwd,
                },
              ]),
            );
            md.appendMarkdown(
              `\n[▶ Run Query Directly](command:bunest.executeRawQuery?${cmdArgs})\n`,
            );
          }
          return new vscode.Hover(md);
        }
      }
    }

    // 2. Class Macros Hover (IntelliJ Lombok-style Generated Members Preview)
    for (const macro of snap.scan.classMacros) {
      if (macro.sourceFile !== filePath) continue;
      const lineDiff = macro.location.line - line1;
      // Trigger on the class name OR on any decorator lines directly above the class
      const onClassOrDecorators =
        isPosNearLocation(line1, col1, macro.location) ||
        (lineDiff >= 0 &&
          lineDiff <= macro.decorators.length + 2 &&
          document.lineAt(position.line).text.trim().startsWith("@"));
      if (!onClassOrDecorators) continue;

      const members = resolveClassMacroMembers(macro, {
        bunestConfig: ctx.bunestConfig,
      });
      if (members.length === 0) continue;

      const md = new vscode.MarkdownString();
      md.appendMarkdown(
        `### Bunest Class Macros — \`${macro.className}\`\n\n`,
      );
      md.appendMarkdown(
        `**Active decorators:** ${macro.decorators.map((d) => `\`@${d}\``).join(", ")}\n\n`,
      );
      if (macro.expandedPresets && macro.expandedPresets.length > 0) {
        md.appendMarkdown(
          `**Expanded presets:** ${macro.expandedPresets.map((p) => `\`@${p}\``).join(", ")}\n\n`,
        );
      }
      md.appendMarkdown(`| Kind | Signature | Source |\n|---|---|---|\n`);
      for (const mem of members.slice(0, 25)) {
        md.appendMarkdown(
          `| \`${mem.kind}\` | \`${mem.signature.replace(/\|/g, "\\|")}\` | ${mem.sourceDecorator} |\n`,
        );
      }
      if (members.length > 25) {
        md.appendMarkdown(`\n_…and ${members.length - 25} more generated members._\n`);
      }
      return new vscode.Hover(md);
    }

    // 3. HTTP Route Handler Hover
    for (const route of snap.scan.routes) {
      if (route.location?.filePath !== filePath) continue;
      if (!isPosNearLocation(line1, col1, route.location)) continue;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(
        `### Bunest HTTP Route — \`${route.method} ${route.path}\`\n\n`,
      );
      md.appendMarkdown(`- **Controller:** \`${route.controllerName}.${route.handlerName}()\`\n`);
      md.appendMarkdown(`- **Params:** \`${route.paramsTypeText}\`\n`);
      md.appendMarkdown(`- **Query:** \`${route.queryTypeText}\`\n`);
      md.appendMarkdown(`- **Body:** \`${route.bodyTypeText}\`\n`);
      md.appendMarkdown(`- **Response:** \`${route.responseTypeText}\`\n`);
      return new vscode.Hover(md);
    }

    // 4. Call-site Hovers (Config / .env with redaction, Events, RPC, Tokens)
    const cs = snap.scan.callSites.find(
      (c) =>
        c.location.filePath === filePath &&
        isPosNearLocation(line1, col1, c.location),
    );
    if (cs) {
      const md = new vscode.MarkdownString();
      if (cs.kind === "config") {
        const envInfo = this.index.readEnvPreview(ctx.cwd, cs.key);
        const ns = snap.scan.configNamespaces.find(
          (n) => n.namespace === cs.key.split(".")[0],
        );
        md.appendMarkdown(`### Bunest Config — \`${cs.key}\`\n\n`);
        if (envInfo) {
          md.appendMarkdown(
            `- **Source:** \`${envInfo.file}\`\n- **Value:** \`${envInfo.value}\`${envInfo.redacted ? " *(redacted by default)*" : ""}\n`,
          );
        }
        if (ns) {
          md.appendMarkdown(`- **Namespace Type:** \`${ns.typeText}\`\n`);
        }
        return new vscode.Hover(md);
      }
      if (cs.kind === "event") {
        const ev = snap.scan.events.find((e) => e.eventName === cs.key);
        const refCount = snap.scan.callSites.filter(
          (x) => x.kind === "event" && x.key === cs.key,
        ).length;
        md.appendMarkdown(`### Bunest Event — \`${cs.key}\`\n\n`);
        md.appendMarkdown(`- **Payload:** \`${ev?.payloadTypeText ?? "unknown"}\`\n`);
        md.appendMarkdown(`- **Workspace references:** ${refCount}\n`);
        return new vscode.Hover(md);
      }
      if (cs.kind === "messagePattern" || cs.kind === "eventPattern") {
        const mp = snap.scan.messagePatterns.find((m) => m.patternKey === cs.key);
        const ep = snap.scan.eventPatterns.find((e) => e.patternKey === cs.key);
        md.appendMarkdown(`### Bunest RPC Pattern — \`${cs.key}\`\n\n`);
        if (mp) {
          md.appendMarkdown(
            `- **Request:** \`${mp.requestTypeText}\`\n- **Response:** \`${mp.responseTypeText}\`\n`,
          );
        } else if (ep) {
          md.appendMarkdown(`- **Payload:** \`${ep.payloadTypeText}\`\n`);
        }
        return new vscode.Hover(md);
      }
      if (cs.kind === "token") {
        const tok = snap.scan.tokens.find((t) => t.token === cs.key);
        if (tok) {
          md.appendMarkdown(`### Bunest DI Token — \`${tok.token}\`\n\n`);
          md.appendMarkdown(`- **Resolved Type:** \`${tok.valueTypeText}\`\n`);
          return new vscode.Hover(md);
        }
      }
    }

    return undefined;
  }
}
