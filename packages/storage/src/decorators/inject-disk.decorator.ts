import { Inject, type InjectionToken } from "@bunest/core";
import { StorageDisk } from "../disks/storage.disk";
import { getDiskToken, requestDiskName } from "../storage.module-definition";

/**
 * Injects the disk called `name`: `@InjectDisk('photos') private readonly photos: StorageDisk`.
 * Without a name, the default disk (the same as typing the parameter as `StorageDisk`).
 */
export function InjectDisk(
  name?: string,
): PropertyDecorator & ParameterDecorator {
  if (name === undefined) {
    return Inject(StorageDisk as unknown as InjectionToken<StorageDisk>);
  }
  requestDiskName(name);
  return Inject(getDiskToken(name));
}
