import { ConfigurableModuleBuilder } from "@bunest/common";
import { STORAGE_MODULE_OPTIONS } from "./constants";
import type { StorageDisk } from "./disks/storage.disk";
import type {
  StorageModuleOptions,
  StorageModuleStructure,
} from "./interfaces/module-options.interface";

const DISK_TOKEN_PREFIX = "STORAGE_DISK:";
const requestedDiskNames = new Set<string>();

export const { ConfigurableModuleClass, OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<StorageModuleOptions>({
    optionsInjectionToken: STORAGE_MODULE_OPTIONS,
  })
    .setClassMethodName("forRoot")
    .setFactoryMethodName("createStorageOptions")
    .setExtras<StorageModuleStructure>(
      {
        disks: undefined,
        imports: undefined,
        isGlobal: true,
      },
      (definition, extras) => ({
        ...definition,
        global: extras.isGlobal ?? true,
      }),
    )
    .build();

/** The injection token of the disk called `name` (`@InjectDisk(name)` uses it). */
export function getDiskToken(name: string): string {
  if (!name || typeof name !== "string") {
    throw new TypeError("getDiskToken() requires a non-empty disk name");
  }
  return `${DISK_TOKEN_PREFIX}${name}`;
}

/** The disk name in a token from `getDiskToken()`, else `undefined`. */
export function diskNameOf(token: string): string | undefined {
  return typeof token === "string" && token.startsWith(DISK_TOKEN_PREFIX)
    ? token.slice(DISK_TOKEN_PREFIX.length)
    : undefined;
}

export function requestDiskName(name: string): void {
  requestedDiskNames.add(name);
}

export function getRequestedDiskNames(): string[] {
  return [...requestedDiskNames];
}

export function missingDiskError(
  name: string,
  configured: string[],
  consumer?: string,
): Error {
  const who = consumer ? ` (requested by ${consumer})` : "";
  const list = configured.length > 0 ? configured.join(", ") : "none";
  return new Error(
    `Storage disk "${name}" is not configured${who}. Configured disks: ${list}`,
  );
}

export interface ResolvedDisks {
  disks: Map<string, StorageDisk>;
  defaultName: string;
}
