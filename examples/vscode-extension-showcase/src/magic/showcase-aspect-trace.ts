import { Injectable } from "@bunest/core";

@Injectable()
export class ShowcaseAspectTrace {
  readonly events: string[] = [];

  record(entry: string): void {
    this.events.push(entry);
  }

  clear(): void {
    this.events.length = 0;
  }
}
