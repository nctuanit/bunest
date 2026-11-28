/**
 * GraphQL October 2021 Spec Errors & Formatting.
 * Zero external dependencies.
 */

import {
  type ASTNode,
  getLocation,
  type Source,
  type SourceLocation,
} from "./ast";

export interface GraphQLErrorExtensions {
  [attributeName: string]: unknown;
}

export interface GraphQLFormattedError {
  readonly message: string;
  readonly locations?: readonly SourceLocation[];
  readonly path?: readonly (string | number)[];
  readonly extensions?: GraphQLErrorExtensions;
}

export interface GraphQLErrorOptions {
  readonly nodes?: readonly ASTNode[] | ASTNode | null;
  readonly source?: Source | null;
  readonly positions?: readonly number[] | null;
  readonly path?: readonly (string | number)[] | null;
  readonly originalError?: Error | null;
  readonly extensions?: GraphQLErrorExtensions | null;
}

function isGraphQLErrorOptions(val: unknown): val is GraphQLErrorOptions {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    return false;
  }
  // AST nodes always have a string `kind` property; GraphQLErrorOptions does not.
  return !("kind" in val && typeof (val as { kind?: unknown }).kind === "string");
}

function normalizeNodes(
  nodes: readonly ASTNode[] | ASTNode | null | undefined,
): readonly ASTNode[] | undefined {
  if (!nodes) return undefined;
  const arr = Array.isArray(nodes) ? nodes : [nodes];
  return arr.length > 0 ? arr : undefined;
}

export class GraphQLError extends Error {
  readonly locations: readonly SourceLocation[] | undefined;
  readonly path: readonly (string | number)[] | undefined;
  readonly nodes: readonly ASTNode[] | undefined;
  readonly source: Source | undefined;
  readonly positions: readonly number[] | undefined;
  readonly originalError: Error | undefined;
  readonly extensions: GraphQLErrorExtensions;

  constructor(message: string, options?: GraphQLErrorOptions);
  constructor(
    message: string,
    nodes?: readonly ASTNode[] | ASTNode | null,
    source?: Source | null,
    positions?: readonly number[] | null,
    path?: readonly (string | number)[] | null,
    originalError?: Error | null,
    extensions?: GraphQLErrorExtensions | null,
  );
  constructor(
    message: string,
    nodesOrOptions?:
      | GraphQLErrorOptions
      | readonly ASTNode[]
      | ASTNode
      | null,
    sourceArg?: Source | null,
    positionsArg?: readonly number[] | null,
    pathArg?: readonly (string | number)[] | null,
    originalErrorArg?: Error | null,
    extensionsArg?: GraphQLErrorExtensions | null,
  ) {
    super(message);
    this.name = "GraphQLError";

    let nodesInput: readonly ASTNode[] | ASTNode | null | undefined;
    let sourceInput: Source | null | undefined;
    let positionsInput: readonly number[] | null | undefined;
    let pathInput: readonly (string | number)[] | null | undefined;
    let originalErrorInput: Error | null | undefined;
    let extensionsInput: GraphQLErrorExtensions | null | undefined;

    if (
      arguments.length <= 2 &&
      isGraphQLErrorOptions(nodesOrOptions)
    ) {
      nodesInput = nodesOrOptions.nodes;
      sourceInput = nodesOrOptions.source;
      positionsInput = nodesOrOptions.positions;
      pathInput = nodesOrOptions.path;
      originalErrorInput = nodesOrOptions.originalError;
      extensionsInput = nodesOrOptions.extensions;
    } else {
      nodesInput = nodesOrOptions as readonly ASTNode[] | ASTNode | null | undefined;
      sourceInput = sourceArg;
      positionsInput = positionsArg;
      pathInput = pathArg;
      originalErrorInput = originalErrorArg;
      extensionsInput = extensionsArg;
    }

    const nodes = normalizeNodes(nodesInput);
    const locationsFromNodes = nodes
      ?.map((n) => n.loc)
      .filter((loc): loc is NonNullable<typeof loc> => loc != null);

    const source =
      sourceInput ?? locationsFromNodes?.[0]?.source ?? undefined;
    const positions =
      positionsInput ??
      (locationsFromNodes && locationsFromNodes.length > 0
        ? locationsFromNodes.map((l) => l.start)
        : undefined);
    const locations =
      positions && source
        ? positions.map((pos) => getLocation(source, pos))
        : undefined;

    const origExtensions =
      originalErrorInput &&
      typeof originalErrorInput === "object" &&
      "extensions" in originalErrorInput &&
      originalErrorInput.extensions &&
      typeof originalErrorInput.extensions === "object"
        ? (originalErrorInput.extensions as GraphQLErrorExtensions)
        : undefined;

    const baseExtensions = extensionsInput ?? origExtensions;
    const extensions: GraphQLErrorExtensions =
      baseExtensions != null ? { ...baseExtensions } : Object.create(null);

    this.nodes = nodes;
    this.source = source;
    this.positions = positions;
    this.locations = locations;
    this.path = pathInput ?? undefined;
    this.originalError = originalErrorInput ?? undefined;
    this.extensions = extensions;

    if (originalErrorInput?.stack && !this.stack) {
      this.stack = originalErrorInput.stack;
    }
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLError";
  }

  toJSON(): GraphQLFormattedError {
    const formatted: {
      message: string;
      locations?: readonly SourceLocation[];
      path?: readonly (string | number)[];
      extensions?: GraphQLErrorExtensions;
    } = {
      message: this.message,
    };

    if (this.locations != null && this.locations.length > 0) {
      formatted.locations = this.locations;
    }
    if (this.path != null) {
      formatted.path = this.path;
    }
    if (
      this.extensions != null &&
      Object.keys(this.extensions).length > 0
    ) {
      formatted.extensions = this.extensions;
    }
    return formatted;
  }

  override toString(): string {
    return this.message;
  }
}

export function isGraphQLError(value: unknown): value is GraphQLError {
  if (value instanceof GraphQLError) return true;
  return (
    value instanceof Error &&
    (value.name === "GraphQLError" ||
      (value as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] ===
        "GraphQLError")
  );
}

/**
 * Wraps any thrown error into a located GraphQLError attached to AST nodes & response path.
 */
export function locatedError(
  rawOriginalError: unknown,
  nodes: ASTNode | readonly ASTNode[] | null | undefined,
  path?: readonly (string | number)[],
): GraphQLError {
  if (isGraphQLError(rawOriginalError) && rawOriginalError.path != null) {
    return rawOriginalError;
  }

  let originalError: Error;
  if (rawOriginalError instanceof Error) {
    originalError = rawOriginalError;
  } else {
    originalError = new Error(
      typeof rawOriginalError === "string"
        ? rawOriginalError
        : String(rawOriginalError),
    );
  }

  const isAlreadyGql = isGraphQLError(rawOriginalError);
  return new GraphQLError(originalError.message, {
    nodes: isAlreadyGql ? (rawOriginalError.nodes ?? nodes) : nodes,
    source: isAlreadyGql ? rawOriginalError.source : undefined,
    positions: isAlreadyGql ? rawOriginalError.positions : undefined,
    path,
    originalError: isAlreadyGql
      ? (rawOriginalError.originalError ?? rawOriginalError)
      : originalError,
    extensions: isAlreadyGql ? rawOriginalError.extensions : undefined,
  });
}

export function formatError(error: GraphQLError): GraphQLFormattedError {
  return error.toJSON();
}

export function syntaxError(
  source: Source,
  position: number,
  description: string,
): GraphQLError {
  return new GraphQLError(`Syntax Error: ${description}`, {
    source,
    positions: [position],
  });
}
