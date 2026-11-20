import { HttpException } from "@bunest/common";
import type { CallToolResult } from "../interfaces/mcp-types";

export const INTERNAL_ERROR_MESSAGE = "Internal server error";

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RESOURCE_NOT_FOUND: -32002,
} as const;

export class ProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
}

export class InsufficientScopeError extends Error {
  readonly requiredScopes: string[];

  constructor(requiredScopes: string[]) {
    super(`Insufficient scope: requires ${requiredScopes.join(" ")}`);
    this.name = "InsufficientScopeError";
    this.requiredScopes = requiredScopes;
  }
}

export function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === "string" && response.length > 0) {
    return response;
  }
  if (response && typeof response === "object" && "message" in response) {
    const msg = (response as { message?: unknown }).message;
    if (Array.isArray(msg)) {
      return msg.map(String).join("; ");
    }
    if (typeof msg === "string" && msg.length > 0) {
      return msg;
    }
  }
  return exception.message || INTERNAL_ERROR_MESSAGE;
}

export function toolErrorResult(error: unknown): CallToolResult {
  let message = INTERNAL_ERROR_MESSAGE;
  if (error instanceof HttpException) {
    message = httpExceptionMessage(error);
  } else if (error instanceof ProtocolError) {
    message = error.message;
  }
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function toProtocolError(error: unknown, uri?: URL): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const message = httpExceptionMessage(error);
    if (status === 404) {
      if (uri) {
        return new ProtocolError(
          JSON_RPC_ERROR_CODES.RESOURCE_NOT_FOUND,
          message,
          { uri: uri.href },
        );
      }
      return new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, message);
    }
    if (status === 400 || status === 422) {
      return new ProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, message);
    }
    return new ProtocolError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message, {
      status,
    });
  }
  return new ProtocolError(
    JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
    INTERNAL_ERROR_MESSAGE,
  );
}
