import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  Reflector,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from "@bunest/core";
import { getCurrentRequestContext, type RequestContext } from "@bunest/core/http";
import { WebhookVerificationError } from "../errors/webhook-verification.error";
import type { ReceivedWebhookRequest } from "../interfaces/received-webhook-request.interface";
import { WebhookVerifier } from "../services/webhook-verifier.service";
import {
  getVerifiedWebhook,
  setVerifiedWebhook,
} from "../utils/verified-webhook.util";
import { VERIFY_WEBHOOK_METADATA } from "../webhooks.constants";

const JSON_OR_FORM = /^application\/(json|x-www-form-urlencoded)\s*(;|$)/i;

/** Runs `WebhookVerifier.verify()` on the raw body and answers failures (see `@VerifyWebhook()`). */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly reflector: Reflector;
  private readonly verifier: WebhookVerifier;
  private readonly logger = new Logger("WebhooksModule");

  constructor(reflector: Reflector, verifier: WebhookVerifier) {
    this.reflector = reflector;
    this.verifier = verifier;
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (context.getType() !== "http") {
      throw new Error(
        `@VerifyWebhook() is for HTTP routes, and ${context.getClass().name}.${context.getHandler().name} runs over ${context.getType()}`,
      );
    }
    const receiver =
      this.reflector.getAllAndOverride<string>(VERIFY_WEBHOOK_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? "";
    const request = context
      .switchToHttp()
      .getRequest<ReceivedWebhookRequest | Request>();
    // On the controller and the method: verified once.
    if (getVerifiedWebhook(request)) {
      return true;
    }

    const maybeRawBody = this.rawBody(request, context);
    if (isPromise(maybeRawBody)) {
      return maybeRawBody.then((rawBody) =>
        this.verifyAndAttach(receiver, request, rawBody),
      );
    }
    return this.verifyAndAttach(receiver, request, maybeRawBody);
  }

  private verifyAndAttach(
    receiver: string,
    request: ReceivedWebhookRequest | Request,
    rawBody: Buffer,
  ): boolean {
    try {
      const verified = this.verifier.verify(receiver, {
        headers: request.headers,
        rawBody,
      });
      setVerifiedWebhook(request, verified);
    } catch (error) {
      throw toHttpException(error);
    }
    return true;
  }

  private rawBody(
    request: ReceivedWebhookRequest | Request,
    context: ExecutionContext,
  ): Buffer | Promise<Buffer> {
    // 1. Direct `rawBody` property on Express/Fastify/mock request or augmented Request
    const directRaw = (request as ReceivedWebhookRequest).rawBody;
    if (Buffer.isBuffer(directRaw)) {
      return directRaw;
    }
    if (directRaw instanceof Uint8Array) {
      return Buffer.from(
        directRaw.buffer,
        directRaw.byteOffset,
        directRaw.byteLength,
      );
    }

    // 2. Native Bunest RequestContext (`rawBody: true` on BunestFactory.create / adapter)
    const reqCtx =
      (context as { requestContext?: RequestContext }).requestContext ??
      getCurrentRequestContext();
    if (reqCtx && reqCtx.request === request) {
      if (reqCtx.rawBody !== undefined) {
        return Buffer.from(
          reqCtx.rawBody.buffer,
          reqCtx.rawBody.byteOffset,
          reqCtx.rawBody.byteLength,
        );
      }
      return reqCtx.getRawBody().then((bytes) => {
        if (bytes !== undefined) {
          return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
        return this.missingRawBodyFallback(request);
      });
    }

    return this.missingRawBodyFallback(request);
  }

  private missingRawBodyFallback(
    request: ReceivedWebhookRequest | Request,
  ): Buffer {
    const length = readHeader(request.headers, "content-length");
    const transferEncoding = readHeader(request.headers, "transfer-encoding");
    const type = readHeader(request.headers, "content-type");
    const hasNativeBody = request instanceof Request && request.body !== null;

    if (
      (length === undefined || length === "0") &&
      transferEncoding === undefined &&
      !hasNativeBody
    ) {
      return Buffer.alloc(0);
    }
    if (typeof type !== "string" || !JSON_OR_FORM.test(type)) {
      throw new UnsupportedMediaTypeException(
        "Webhooks are accepted as application/json",
      );
    }
    const error = new Error(
      "@VerifyWebhook(): the request has no raw body. Create the application with `BunestFactory.create(AppModule, { rawBody: true })` " +
        "(or `NestFactory.create(AppModule, { rawBody: true })`), so signatures are checked on the bytes that were signed.",
    );
    this.logger.error(error.message);
    throw error;
  }
}

function readHeader(
  headers: Record<string, string | string[] | undefined> | Headers,
  name: string,
): string | string[] | undefined {
  if (
    headers &&
    typeof (headers as Headers).get === "function" &&
    typeof (headers as Headers).forEach === "function"
  ) {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  if (rec[name] !== undefined) {
    return rec[name];
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Promise<T>).then === "function"
  );
}

/** Maps the verifier's error to HTTP exceptions, without the reason (kept for the event and the cause). */
function toHttpException(error: unknown): unknown {
  if (!(error instanceof WebhookVerificationError)) {
    return error;
  }
  return error.status === 400
    ? new BadRequestException("Webhook payload is not valid JSON", {
        cause: error,
      })
    : new UnauthorizedException("Webhook signature verification failed", {
        cause: error,
      });
}
