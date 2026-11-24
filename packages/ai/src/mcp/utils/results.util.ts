import type {
  CallToolResult,
  GetPromptResult,
  InputRequiredResult,
  PromptMessage,
  ReadResourceResult,
} from "../interfaces/mcp-types";

export function isInputRequiredResult(
  value: unknown,
): value is InputRequiredResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { inputRequired?: unknown }).inputRequired === true
  );
}

export function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function toCallToolResult(
  value: unknown,
  structured: boolean,
): CallToolResult | InputRequiredResult {
  if (isInputRequiredResult(value)) {
    return value;
  }
  if (
    isCallToolResult(value) &&
    (!structured ||
      value.isError === true ||
      value.structuredContent !== undefined)
  ) {
    return value;
  }
  if (value === undefined || (value === null && !structured)) {
    return { content: [] };
  }
  if (typeof value === "string") {
    return {
      content: [{ type: "text", text: value }],
      ...(structured ? { structuredContent: value } : {}),
    };
  }
  const text = JSON.stringify(value);
  return {
    content: [{ type: "text", text: text ?? "" }],
    ...(structured && text !== undefined
      ? { structuredContent: JSON.parse(text) }
      : {}),
  };
}

export function toReadResourceResult(
  value: unknown,
  uri: URL,
  mimeType: string | undefined,
): ReadResourceResult | InputRequiredResult {
  if (isInputRequiredResult(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { contents?: unknown }).contents)
  ) {
    return value as ReadResourceResult;
  }
  if (value === undefined || value === null) {
    return { contents: [] };
  }
  if (typeof value === "string") {
    return {
      contents: [
        { uri: uri.href, ...(mimeType ? { mimeType } : {}), text: value },
      ],
    };
  }
  if (value instanceof Uint8Array) {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: mimeType ?? "application/octet-stream",
          blob: Buffer.from(value).toString("base64"),
        },
      ],
    };
  }
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: mimeType ?? "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

export function toGetPromptResult(
  value: unknown,
  description: string | undefined,
): GetPromptResult | InputRequiredResult {
  if (isInputRequiredResult(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { messages?: unknown }).messages)
  ) {
    return value as GetPromptResult;
  }
  if (Array.isArray(value)) {
    return {
      ...(description ? { description } : {}),
      messages: value as PromptMessage[],
    };
  }
  if (typeof value === "string") {
    return {
      ...(description ? { description } : {}),
      messages: [{ role: "user", content: { type: "text", text: value } }],
    };
  }
  throw new TypeError(
    `A prompt returns a string, an array of prompt messages or a GetPromptResult; got ${value === null ? "null" : typeof value}.`,
  );
}
