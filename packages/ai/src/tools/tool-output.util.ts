import { Logger } from "@bunest/core";
import { AiToolError } from "../errors/ai.errors";

const logger = new Logger("AiModule");

function isCallToolResult(value: unknown): value is {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.every((key) =>
      ["content", "structuredContent", "isError", "_meta"].includes(key),
    ) &&
    content.every(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { type?: unknown }).type === "string",
    )
  );
}

/**
 * What the model reads of an agent function's return value: JSON (a `Date` becomes its ISO string; `undefined` is
 * `null`). An MCP `CallToolResult` becomes its `structuredContent`, else its text blocks joined; `isError: true` is a
 * tool error. Blocks other than text (images, audio, resources) are dropped.
 */
export function toToolOutput(
  value: unknown,
  toolName: string,
  where: string,
): unknown {
  if (isCallToolResult(value)) {
    const text = value.content
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text!)
      .join("\n");
    if (value.isError) {
      throw new AiToolError(text || "The tool failed", toolName);
    }
    if (value.content.some((block) => block.type !== "text")) {
      logger.warn(
        `${where} returned content other than text, which agents are not sent; only its text is.`,
      );
    }
    return value.structuredContent !== undefined
      ? toJson(value.structuredContent)
      : text;
  }
  return value === undefined ? null : toJson(value);
}

function toJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}
