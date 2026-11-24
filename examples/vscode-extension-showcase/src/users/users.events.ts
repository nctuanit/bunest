import {
  Delegate,
  Injectable,
  Locked,
  LogExecution,
  Memoize,
  Synchronized,
  WithLogger,
} from "@bunest/core";
import { OnEvent } from "@bunest/messaging/events";

export interface UserCreatedEvent {
  readonly id: number;
  readonly email: string;
  readonly name: string;
}

export class AuditPrinter {
  formatAuditLine(action: string, subject: string): string {
    return `[AUDIT] ${action} -> ${subject}`;
  }
}

/**
 * 👉 Test `@WithLogger()`: `this.logger` tự có type `Logger` từ `.bunest/types/bunest.d.ts`!
 * 👉 Test `@Delegate()`: Cmd+Click vào `printer` để nhảy sang `AuditPrinter`!
 * 👉 Test `@OnEvent("user.created")`: Cmd+Click hoặc Shift+F12 (Find References) để nhảy 2 chiều tới `users.service.ts`!
 */
@Injectable()
@WithLogger("UsersAudit")
export class UsersEventsListener {
  @Delegate({ target: AuditPrinter })
  private readonly printer = new AuditPrinter();

  private readonly history: string[] = [];

  @OnEvent("user.created")
  @Synchronized()
  @LogExecution({ level: "log", slowMs: 50 })
  async handleUserCreated(payload: UserCreatedEvent): Promise<void> {
    const line = this.formatAuditLine("USER_CREATED", payload.email);
    await this.recordAudit(line);
    this.logger.log(line);
  }

  @Locked.Write()
  async recordAudit(entry: string): Promise<void> {
    this.history.push(entry);
  }

  @Locked.Read()
  async getAuditHistory(): Promise<readonly string[]> {
    return [...this.history];
  }

  @Memoize()
  getAuditChannelName(): string {
    return "users.audit.channel";
  }
}
