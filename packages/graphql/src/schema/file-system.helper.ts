import { mkdir, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { Injectable } from "@bunest/common";

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
    await writeFile(filePath, content, "utf8");
  }

  async mkdirRecursive(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
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
