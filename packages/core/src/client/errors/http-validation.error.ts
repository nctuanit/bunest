import type { StandardSchemaV1Issue } from "../../common/interfaces/standard-schema.interface";
import { defineHidden } from "../utils/define-hidden.util";
import { redactUrl } from "../utils/url.util";
import { HttpClientError } from "./http-client.error";
import type { HttpResponseErrorInit } from "./http-response.error";

export interface HttpClientValidationErrorInit<TBody = unknown>
  extends HttpResponseErrorInit<TBody> {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

function formatValidationIssue(issue: StandardSchemaV1Issue): string {
  if (!issue.path || issue.path.length === 0) {
    return issue.message;
  }
  const path = issue.path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
  return `${path}: ${issue.message}`;
}

/**
 * The response body failed runtime validation against the request's
 * `responseSchema` (Standard Schema v1). `issues` lists the schema failures;
 * `data` / `body` hold the raw unvalidated payload (hidden from log serializers).
 */
export class HttpClientValidationError<TBody = unknown> extends HttpClientError {
  readonly status: number;
  readonly statusText: string;
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
  declare readonly headers: Headers;
  declare readonly body: TBody;
  declare readonly data: TBody;

  constructor(init: HttpClientValidationErrorInit<TBody>) {
    const { method, url, status, statusText = "", issues } = init;
    const summary =
      issues.length > 0
        ? issues.slice(0, 5).map(formatValidationIssue).join("; ") +
          (issues.length > 5 ? ` (+${issues.length - 5} more)` : "")
        : "validation failed";
    super(
      `${method} ${redactUrl(url)} response failed validation (${status}${statusText ? ` ${statusText}` : ""}): ${summary}`,
      { method, url },
    );
    this.status = status;
    this.statusText = statusText;
    this.issues = Object.freeze([...issues]);
    defineHidden(this, "headers", init.headers ?? new Headers());
    defineHidden(this, "body", init.body);
    defineHidden(this, "data", init.body);
  }
}
