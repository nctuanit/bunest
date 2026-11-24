import { SerializedGraph, type SerializedGraphJson } from "./serialized-graph";

/**
 * Stores the partial dependency graph snapshot captured when application bootstrap
 * fails with `snapshot: true`, matching NestJS `PartialGraphHost`.
 */
export class PartialGraphHost {
  private static partialGraph: SerializedGraph | undefined;

  static toJSON(): SerializedGraphJson | undefined {
    return PartialGraphHost.partialGraph?.toJSON();
  }

  static toString(): string | undefined {
    return PartialGraphHost.partialGraph?.toString();
  }

  static register(partialGraph: SerializedGraph): void {
    PartialGraphHost.partialGraph = partialGraph;
  }
}
