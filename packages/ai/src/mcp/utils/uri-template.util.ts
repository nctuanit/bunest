/**
 * Compiles an RFC 6570 Level 1/2 URI template (e.g. `notes://{id}`, `files://{+path}`,
 * `repo://{owner}/{name}`) into a matcher extracting decoded variable values.
 */
export interface CompiledUriTemplate {
  readonly template: string;
  readonly variableNames: string[];
  match(uri: string): Record<string, string> | null;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileUriTemplate(template: string): CompiledUriTemplate {
  const variableNames: string[] = [];
  let pattern = "^";
  let cursor = 0;
  const exprRe = /\{([+#./;?&]?)([A-Za-z0-9_.,*]+)\}/g;

  for (const match of template.matchAll(exprRe)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      pattern += escapeRegex(template.slice(cursor, idx));
    }
    const operator = match[1] ?? "";
    const rawVars = (match[2] ?? "").split(",");
    if (rawVars.length === 1) {
      const varName = rawVars[0]!.replace(/\*$/, "");
      variableNames.push(varName);
      if (operator === "+") {
        pattern += "(.+)";
      } else if (operator === "/") {
        pattern += "(?:/([^/?#]+))";
      } else {
        pattern += "([^/?#]+)";
      }
    } else {
      for (const rv of rawVars) {
        const varName = rv.replace(/\*$/, "");
        variableNames.push(varName);
        pattern += "([^/?#,]*)";
      }
    }
    cursor = idx + match[0].length;
  }

  if (cursor < template.length) {
    pattern += escapeRegex(template.slice(cursor));
  }
  pattern += "$";
  const regex = new RegExp(pattern);

  return {
    template,
    variableNames,
    match(uri: string): Record<string, string> | null {
      const m = regex.exec(uri);
      if (!m) return null;
      const vars: Record<string, string> = {};
      for (let i = 0; i < variableNames.length; i++) {
        const raw = m[i + 1] ?? "";
        try {
          vars[variableNames[i]!] = decodeURIComponent(raw);
        } catch {
          vars[variableNames[i]!] = raw;
        }
      }
      return vars;
    },
  };
}
