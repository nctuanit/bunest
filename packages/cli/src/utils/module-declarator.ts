import {
  dirname,
  existsSyncPath,
  join,
  readDirEntries,
  readTextSync,
  relative,
  resolve,
  writeTextSync,
} from "@bunest/core";
import type { SchematicType } from "../types";
import type { ParsedSchematicName } from "./naming";

export interface ModuleDeclarationTarget {
  readonly metadataKey: "imports" | "controllers" | "providers";
  readonly symbolName: string;
  readonly fileSuffix: string;
}

export function getModuleDeclarationTarget(
  schematic: SchematicType,
  parsed: ParsedSchematicName,
): ModuleDeclarationTarget | undefined {
  switch (schematic) {
    case "controller":
      return {
        metadataKey: "controllers",
        symbolName: `${parsed.pascal}Controller`,
        fileSuffix: `${parsed.kebab}.controller.ts`,
      };
    case "service":
      return {
        metadataKey: "providers",
        symbolName: `${parsed.pascal}Service`,
        fileSuffix: `${parsed.kebab}.service.ts`,
      };
    case "provider":
      return {
        metadataKey: "providers",
        symbolName: parsed.pascal,
        fileSuffix: `${parsed.kebab}.ts`,
      };
    case "gateway":
      return {
        metadataKey: "providers",
        symbolName: `${parsed.pascal}Gateway`,
        fileSuffix: `${parsed.kebab}.gateway.ts`,
      };
    case "resolver":
      return {
        metadataKey: "providers",
        symbolName: `${parsed.pascal}Resolver`,
        fileSuffix: `${parsed.kebab}.resolver.ts`,
      };
    case "module":
    case "resource":
      return {
        metadataKey: "imports",
        symbolName: `${parsed.pascal}Module`,
        fileSuffix: `${parsed.kebab}.module.ts`,
      };
    default:
      return undefined;
  }
}

export async function findNearestModuleFile(
  generatedFilePath: string,
  rootBoundary: string,
  preferredKebabName: string,
  explicitModule?: string,
): Promise<string | undefined> {
  if (explicitModule) {
    const candidate = resolve(rootBoundary, explicitModule);
    if (existsSyncPath(candidate)) {
      return candidate;
    }
    const withExt = candidate.endsWith(".ts")
      ? candidate
      : `${candidate}.module.ts`;
    if (existsSyncPath(withExt)) {
      return withExt;
    }
    return undefined;
  }

  const normalizedRoot = resolve(rootBoundary);
  const normalizedGenerated = resolve(generatedFilePath);
  let currentDir = dirname(normalizedGenerated);

  while (true) {
    if (existsSyncPath(currentDir)) {
      try {
        const entries = await readDirEntries(currentDir);
        const moduleFiles = entries
          .filter((e) => e.isFile() && e.name.endsWith(".module.ts"))
          .map((e) => join(currentDir, e.name))
          .filter((p) => resolve(p) !== normalizedGenerated)
          .sort();

        if (moduleFiles.length > 0) {
          const exactMatch = moduleFiles.find(
            (p) =>
              p.endsWith(`/${preferredKebabName}.module.ts`) ||
              p.endsWith(`\\${preferredKebabName}.module.ts`),
          );
          if (exactMatch) return exactMatch;

          const appMatch = moduleFiles.find(
            (p) =>
              p.endsWith("/app.module.ts") || p.endsWith("\\app.module.ts"),
          );
          if (appMatch) return appMatch;

          return moduleFiles[0];
        }
      } catch {
        // ignore unreadable directories
      }
    }

    if (currentDir === normalizedRoot) {
      break;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    const relToRoot = relative(normalizedRoot, parent);
    if (relToRoot.startsWith("..")) {
      break;
    }
    currentDir = parent;
  }

  return undefined;
}

function toRelativeImportPath(fromModulePath: string, targetFilePath: string): string {
  let rel = relative(dirname(fromModulePath), targetFilePath).replace(
    /\\/g,
    "/",
  );
  rel = rel.replace(/\.tsx?$/i, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function insertImportStatement(
  source: string,
  symbolName: string,
  importPath: string,
): string {
  const importRegex = new RegExp(
    `import\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}\\s*from\\s*["'][^"']+["']`,
  );
  if (importRegex.test(source)) {
    return source;
  }

  const importLine = `import { ${symbolName} } from "${importPath}";`;
  const lines = source.split("\n");
  let lastImportEnd = -1;
  let inMultilineImport = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (inMultilineImport) {
      if (trimmed.includes("from ") || trimmed.endsWith(";")) {
        lastImportEnd = i;
        inMultilineImport = false;
      }
      continue;
    }
    if (trimmed.startsWith("import ")) {
      if (
        trimmed.includes("from ") ||
        /^import\s+["']/.test(trimmed) ||
        trimmed.endsWith(";")
      ) {
        lastImportEnd = i;
      } else {
        inMultilineImport = true;
      }
    }
  }

  if (lastImportEnd >= 0) {
    lines.splice(lastImportEnd + 1, 0, importLine);
    return lines.join("\n");
  }
  return `${importLine}\n${source}`;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (ch === "\\" && i + 1 < source.length) {
        i++;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function insertIntoModuleMetadata(
  source: string,
  metadataKey: "imports" | "controllers" | "providers",
  symbolName: string,
): string {
  const decoratorIdx = source.indexOf("@Module(");
  if (decoratorIdx === -1) return source;

  const openBraceIdx = source.indexOf("{", decoratorIdx);
  if (openBraceIdx === -1) return source;

  const closeBraceIdx = findMatchingBrace(source, openBraceIdx);
  if (closeBraceIdx === -1) return source;

  const inner = source.slice(openBraceIdx + 1, closeBraceIdx);
  const keyRegex = new RegExp(`(\\b${metadataKey}\\s*:\\s*\\[)([\\s\\S]*?)(\\])`);
  const match = keyRegex.exec(inner);

  if (match) {
    const existingItems = match[2]!;
    if (new RegExp(`\\b${symbolName}\\b`).test(existingItems)) {
      return source;
    }
    const trimmedItems = existingItems.trim();
    let replacement: string;
    if (trimmedItems.length === 0) {
      replacement = `${match[1]}${symbolName}${match[3]}`;
    } else if (!existingItems.includes("\n")) {
      const cleaned = existingItems.trimEnd().replace(/,\s*$/, "");
      replacement = `${match[1]}${cleaned}, ${symbolName}${match[3]}`;
    } else {
      const hasTrailingComma = /,\s*$/.test(trimmedItems);
      const updatedItems = hasTrailingComma
        ? `${existingItems.trimEnd()}\n    ${symbolName},\n  `
        : `${existingItems.trimEnd()},\n    ${symbolName},\n  `;
      replacement = `${match[1]}${updatedItems}${match[3]}`;
    }
    const updatedInner =
      inner.slice(0, match.index) +
      replacement +
      inner.slice(match.index + match[0].length);
    return (
      source.slice(0, openBraceIdx + 1) +
      updatedInner +
      source.slice(closeBraceIdx)
    );
  }

  // Metadata key does not exist in @Module({ ... })
  if (inner.trim().length === 0) {
    return (
      source.slice(0, openBraceIdx + 1) +
      `\n  ${metadataKey}: [${symbolName}],\n` +
      source.slice(closeBraceIdx)
    );
  }

  if (inner.startsWith("\n")) {
    return (
      source.slice(0, openBraceIdx + 1) +
      `\n  ${metadataKey}: [${symbolName}],` +
      inner +
      source.slice(closeBraceIdx)
    );
  }

  return (
    source.slice(0, openBraceIdx + 1) +
    ` ${metadataKey}: [${symbolName}],` +
    inner +
    source.slice(closeBraceIdx)
  );
}

/**
 * Finds the nearest parent `*.module.ts` and declares the generated symbol
 * in its `@Module({ imports / controllers / providers })` metadata.
 */
export async function declareInNearestModule(params: {
  readonly schematic: SchematicType;
  readonly parsedName: ParsedSchematicName;
  readonly generatedFilePath: string;
  readonly rootBoundary: string;
  readonly explicitModule?: string;
}): Promise<string | undefined> {
  const target = getModuleDeclarationTarget(params.schematic, params.parsedName);
  if (!target) return undefined;

  const modulePath = await findNearestModuleFile(
    params.generatedFilePath,
    params.rootBoundary,
    params.parsedName.kebab,
    params.explicitModule,
  );
  if (!modulePath) return undefined;

  const original = readTextSync(modulePath);
  const relImport = toRelativeImportPath(modulePath, params.generatedFilePath);
  let updated = insertImportStatement(original, target.symbolName, relImport);
  updated = insertIntoModuleMetadata(
    updated,
    target.metadataKey,
    target.symbolName,
  );

  if (updated !== original) {
    writeTextSync(modulePath, updated);
    return modulePath;
  }
  return undefined;
}
