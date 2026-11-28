import { Injectable, Logger } from "@bunest/core";
import { OnEvent } from "@bunest/messaging/events";
import { AuditPrinter } from "./audit-printer";

export interface UserCreatedEvent {
  readonly id: number;
  readonly email: string;
  readonly name: string;
}

@Injectable()
export class UsersEventsListener {
  private readonly logger = new Logger("UsersAudit");
  private readonly printer = new AuditPrinter();
  private readonly history: string[] = [];

  @OnEvent("user.created")
  async handleUserCreated(payload: UserCreatedEvent): Promise<void> {
    const line = this.printer.formatAuditLine("USER_CREATED", payload.email);
    this.history.push(line);
    this.logger.log(line);
  }

  getAuditHistory(): readonly string[] {
    return [...this.history];
  }

  getAuditChannelName(): string {
    return "users.audit.channel";
  }
}
