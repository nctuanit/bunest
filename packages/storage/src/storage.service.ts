import { Injectable } from "@bunest/common";
import type { StorageDisk } from "./disks/storage.disk";

/**
 * The configured disks, by name. Inject it to pick a disk at runtime
 * (`storage.disk(tenant.disk)`); inject a disk itself with `@InjectDisk(name)`, or the
 * default one as `StorageDisk`.
 */
@Injectable()
export class Storage {
  private readonly disks: ReadonlyMap<string, StorageDisk>;
  readonly defaultDisk: string;

  constructor(disks: ReadonlyMap<string, StorageDisk>, defaultDisk: string) {
    this.disks = disks;
    this.defaultDisk = defaultDisk;
  }

  /** The disk called `name`, or the default one. Throws for a name that isn't configured. */
  disk(name?: string): StorageDisk {
    const target = name ?? this.defaultDisk;
    const found = this.disks.get(target);
    if (!found) {
      const configured = [...this.disks.keys()];
      throw new Error(
        `Storage disk "${target}" is not configured (configured disks: ${configured.length > 0 ? configured.join(", ") : "none"})`,
      );
    }
    return found;
  }

  names(): string[] {
    return [...this.disks.keys()];
  }
}
