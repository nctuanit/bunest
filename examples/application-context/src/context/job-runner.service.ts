import { ClsService, Injectable, type ClsStore } from "@bunest/core";

export interface JobClsStore extends ClsStore {
  tenantId?: string;
  jobName?: string;
}

export interface AuditEntry {
  readonly tenantId: string;
  readonly jobName: string;
  readonly message: string;
}

@Injectable()
export class JobRunnerService {
  private readonly auditLog: AuditEntry[] = [];

  constructor(private readonly cls: ClsService<JobClsStore>) {}

  async runBatch(tenantId: string, jobName: string, items: string[]): Promise<AuditEntry[]> {
    return this.cls.run(async () => {
      this.cls.set("tenantId", tenantId);
      this.cls.set("jobName", jobName);

      const entries: AuditEntry[] = [];
      for (const item of items) {
        await Bun.sleep(1);
        entries.push(this.recordStep(`processed:${item}`));
      }
      return entries;
    });
  }

  private recordStep(message: string): AuditEntry {
    const entry: AuditEntry = {
      tenantId: this.cls.get("tenantId") ?? "unknown",
      jobName: this.cls.get("jobName") ?? "unnamed",
      message,
    };
    this.auditLog.push(entry);
    return entry;
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }
}
