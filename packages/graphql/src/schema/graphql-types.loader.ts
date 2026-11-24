import { Injectable, isAbsolute, resolve } from "@bunest/core";

/**
 * Loads and merges `.graphql` / `.gql` SDL files matching glob patterns using
 * Bun's native `Bun.Glob` and `Bun.file` (0 external dependencies).
 */
@Injectable()
export class GraphQLTypesLoader {
  async mergeTypesByPaths(paths: string | string[]): Promise<string> {
    if (!paths || (Array.isArray(paths) && paths.length === 0)) {
      return "";
    }
    const list = Array.isArray(paths) ? paths : [paths];
    const files = await this.getTypesFromPaths(list);
    if (files.length === 0) {
      return "";
    }
    const contents = await Promise.all(
      files.map((filePath) => Bun.file(filePath).text()),
    );
    return contents.join("\n");
  }

  private async getTypesFromPaths(patterns: string[]): Promise<string[]> {
    const matched = new Set<string>();

    for (const rawPattern of patterns) {
      if (!rawPattern) continue;
      const normalized = rawPattern.replace(/\\/g, "/");
      const hasGlob = /[*?[\]{}]/.test(normalized);

      if (!hasGlob) {
        const abs = resolve(rawPattern);
        if (await Bun.file(abs).exists()) {
          matched.add(abs);
        }
        continue;
      }

      // Split absolute pattern prefix before first glob metacharacter so Bun.Glob works cross-platform
      let cwd = process.cwd();
      let globPattern = normalized;
      if (isAbsolute(rawPattern) || /^[a-zA-Z]:\//.test(normalized)) {
        const parts = normalized.split("/");
        const prefixParts: string[] = [];
        let idx = 0;
        while (idx < parts.length && !/[*?[\]{}]/.test(parts[idx]!)) {
          prefixParts.push(parts[idx]!);
          idx++;
        }
        if (prefixParts.length > 0) {
          cwd = prefixParts.join("/") || "/";
          if (/^[a-zA-Z]:$/.test(cwd)) {
            cwd += "/";
          }
          globPattern = parts.slice(idx).join("/");
        }
      }

      const glob = new Bun.Glob(globPattern);
      for await (const entry of glob.scan({ cwd, onlyFiles: true })) {
        const full = resolve(cwd, entry);
        if (
          !this.includeNodeModules(normalized) &&
          full.replace(/\\/g, "/").includes("/node_modules/")
        ) {
          continue;
        }
        matched.add(full);
      }
    }

    return [...matched].sort();
  }

  private includeNodeModules(pattern: string): boolean {
    return pattern.includes("node_modules");
  }
}
