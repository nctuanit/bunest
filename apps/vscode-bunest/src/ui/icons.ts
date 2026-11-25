import { join } from "@bunest/core";
import * as vscode from "vscode";

export type BunestIconName =
  | "method-get"
  | "method-post"
  | "method-put"
  | "method-patch"
  | "method-delete"
  | "controller"
  | "module"
  | "module-global"
  | "service"
  | "repository"
  | "entity"
  | "migration"
  | "drift"
  | "event"
  | "rpc"
  | "cqrs"
  | "config";

let extensionRootPath: string | undefined;

export function setBunestExtensionPath(rootPath: string): void {
  extensionRootPath = rootPath;
}

/**
 * Returns a crisp custom SVG icon URI from `media/icons/<name>.svg`, falling
 * back cleanly to a VS Code `ThemeIcon` when running in headless unit tests.
 */
export function bunestIcon(
  name: BunestIconName,
  fallbackCodicon = "symbol-misc",
): vscode.Uri | vscode.ThemeIcon {
  if (extensionRootPath && typeof vscode.Uri?.file === "function") {
    return vscode.Uri.file(
      join(extensionRootPath, "media", "icons", `${name}.svg`),
    );
  }
  return new vscode.ThemeIcon(fallbackCodicon);
}

export function httpMethodIcon(method: string): vscode.Uri | vscode.ThemeIcon {
  switch (method.toUpperCase()) {
    case "GET":
      return bunestIcon("method-get", "globe");
    case "POST":
      return bunestIcon("method-post", "add");
    case "PUT":
      return bunestIcon("method-put", "edit");
    case "PATCH":
      return bunestIcon("method-patch", "edit");
    case "DELETE":
      return bunestIcon("method-delete", "trash");
    default:
      return bunestIcon("controller", "symbol-method");
  }
}
