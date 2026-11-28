import { Injectable, type UploadedFileInfo } from "@bunest/core";
import { Storage, type StorageDisk } from "@bunest/storage";

export interface StoredFileMeta {
  readonly key: string;
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly label?: string;
}

@Injectable()
export class FilesService {
  constructor(private readonly storage: Storage) {}

  getDisk(): StorageDisk {
    return this.storage.disk();
  }

  async save(file: UploadedFileInfo, label?: string): Promise<StoredFileMeta> {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = safeName;
    const bytes = file.buffer ?? new Uint8Array();
    await this.getDisk().put(key, bytes, {
      contentType: file.mimetype || "application/octet-stream",
      metadata: label ? { label } : undefined,
    });
    return {
      key,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      ...(label ? { label } : {}),
    };
  }

  async listKeys(): Promise<string[]> {
    const page = await this.getDisk().list();
    return page.entries.map((entry) => entry.key);
  }
}
