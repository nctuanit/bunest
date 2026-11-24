import { dirname, ensureDir, Injectable, sep } from "@bunest/core";

/**
 * Filesystem helper used by `GraphQLSchemaFactory` / `GraphQLDefinitionsFactory`
 * to emit generated SDL schemas and TypeScript definitions.
 */
@Injectable()
export class FileSystemHelper {
  async writeFile(filePath: string, content: string): Promise<void> {
    const dir = dirname(filePath);
    if (dir && dir !== ".") {
      await this.mkdirRecursive(dir);
    }
    await Bun.write(filePath, content);
  }

  async mkdirRecursive(dirPath: string): Promise<void> {
    await ensureDir(dirPath);
  }

  getDirs(filePath: string): string[] {
    const normalized = dirname(filePath).replace(/\\/g, "/");
    if (!normalized || normalized === ".") {
      return [];
    }
    return normalized
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== sep);
  }
}
