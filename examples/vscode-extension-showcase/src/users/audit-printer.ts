export class AuditPrinter {
  formatAuditLine(action: string, subject: string): string {
    return `[AUDIT] ${action} -> ${subject}`;
  }
}
