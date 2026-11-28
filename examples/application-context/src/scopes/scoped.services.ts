import { Injectable, Scope } from "@bunest/core";

let transientCounter = 0;
let requestCounter = 0;

@Injectable({ scope: Scope.TRANSIENT })
export class TransientTokenService {
  public readonly instanceId = `tr_${++transientCounter}`;
}

@Injectable({ scope: Scope.REQUEST })
export class RequestScopedJobContext {
  public readonly contextSeq = ++requestCounter;
  private readonly steps: string[] = [];

  record(step: string): void {
    this.steps.push(step);
  }

  getSteps(): string[] {
    return [...this.steps];
  }
}
