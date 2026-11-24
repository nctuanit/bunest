import {
  BadRequestException,
  createParamDecorator,
  HttpStatus,
  isStandardSchema,
  type StandardSchemaV1,
} from "@bunest/core";
import { incoming } from "../utils/verified-webhook.util";

/** The verified payload: parsed from the bytes that were signed, never from the framework's parsed body. Takes pipes and a `schema`. */
export const WebhookPayload: (...dataOrPipes: unknown[]) => ParameterDecorator =
  createParamDecorator(async (data, context) => {
    const payload = incoming(context).payload;
    const schema = extractSchema(data);
    if (!schema) {
      return payload;
    }
    const result = await schema["~standard"].validate(payload);
    if (!result.issues) {
      return result.value;
    }
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: "Bad Request",
      message: "Validation failed",
      details: result.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
    });
  }) as (...dataOrPipes: unknown[]) => ParameterDecorator;

function extractSchema(data: unknown): StandardSchemaV1 | undefined {
  if (isStandardSchema(data)) {
    return data;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "schema" in data &&
    isStandardSchema((data as { schema?: unknown }).schema)
  ) {
    return (data as { schema: StandardSchemaV1 }).schema;
  }
  return undefined;
}
