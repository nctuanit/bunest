import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  InMemoryMailTransport,
  MailConnectionError,
  Mailer,
  MailMessageError,
  MailModule,
  MailProviderError,
  MailTimeoutError,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
} from "../src";
import { signV4 } from "../src/transports/sigv4.util";

async function makeMessage(overrides: Record<string, unknown> = {}) {
  const mod = await Test.createTestingModule({
    imports: [
      MailModule.forRoot({
        transport: new InMemoryMailTransport(),
        from: "Orders <orders@example.com>",
      }),
    ],
  }).compile();
  const msg = await mod.get(Mailer).render({
    to: ["Ada <ada@example.com>"],
    cc: ["cc@example.com"],
    bcc: ["bcc@example.com"],
    replyTo: "reply@example.com",
    subject: "Order #1",
    html: '<p>Hi <img src="cid:logo"></p>',
    text: "Hi",
    headers: { "X-Ref": "123" },
    attachments: [
      { cid: "logo", content: Buffer.from("png"), contentType: "image/png" },
      {
        filename: "inv.pdf",
        content: Buffer.from("pdf"),
        contentType: "application/pdf",
      },
    ],
    ...overrides,
  });
  await mod.close();
  return msg;
}

describe("HTTP Provider Transports (Resend, Postmark, SendGrid, SES)", () => {
  it("ResendTransport sends expected payload, idempotency key, and maps errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "re_msg_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transport = new ResendTransport({
      apiKey: "re_test_key",
      fetch: mockFetch,
    });
    const msg = await makeMessage();
    const res = await transport.send(msg, {
      signal: new AbortController().signal,
      attempt: 1,
      idempotencyKey: "k".repeat(300),
    });

    expect(res.providerMessageId).toBe("re_msg_123");
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    // > 256 chars hashed to 64 hex chars
    expect(headers["idempotency-key"]).toHaveLength(64);

    const payload = JSON.parse(String(calls[0]?.init.body));
    expect(payload.from).toBe("Orders <orders@example.com>");
    expect(payload.to).toEqual(["Ada <ada@example.com>"]);
    expect(payload.cc).toEqual(["cc@example.com"]);
    expect(payload.bcc).toEqual(["bcc@example.com"]);
    expect(payload.reply_to).toEqual(["reply@example.com"]);
    expect(payload.attachments[0].content_id).toBe("logo");

    // Concurrent idempotent request -> transient; invalid -> permanent
    const errTransport = new ResendTransport({
      apiKey: "re_k",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            name: "concurrent_idempotent_requests",
            message: "busy",
          }),
          { status: 409, headers: { "retry-after": "3" } },
        )) as unknown as typeof fetch,
    });
    try {
      await errTransport.send(msg, {
        signal: new AbortController().signal,
        attempt: 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MailProviderError);
      expect((err as MailProviderError).permanent).toBe(false);
      expect((err as MailProviderError).retryAfterMs).toBe(3000);
    }

    // Missing `to` fails with MailMessageError
    const noTo = await makeMessage({
      to: undefined,
      bcc: "only-bcc@example.com",
    });
    await expect(
      transport.send(noTo, {
        signal: new AbortController().signal,
        attempt: 1,
      }),
    ).rejects.toThrow(MailMessageError);

    // Non-HTTPS baseUrl rejected for non-localhost
    expect(
      () =>
        new ResendTransport({
          apiKey: "k",
          baseUrl: "http://evil.example.com",
        }),
    ).toThrow(TypeError);
  });

  it("PostmarkTransport sends expected payload and maps ErrorCode", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    const transport = new PostmarkTransport({
      serverToken: "pm-tok",
      messageStream: "broadcast",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ MessageID: "pm_id_1" }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    const msg = await makeMessage();
    const res = await transport.send(msg, {
      signal: new AbortController().signal,
      attempt: 1,
    });
    expect(res.providerMessageId).toBe("pm_id_1");
    expect(capturedHeaders["x-postmark-server-token"]).toBe("pm-tok");
    expect(capturedBody.MessageStream).toBe("broadcast");
    expect(
      (capturedBody.Attachments as Array<{ ContentID?: string }>)[0]?.ContentID,
    ).toBe("cid:logo");

    const failTransport = new PostmarkTransport({
      serverToken: "pm-tok",
      fetch: (async () =>
        new Response(JSON.stringify({ ErrorCode: 406, Message: "Inactive" }), {
          status: 422,
        })) as unknown as typeof fetch,
    });
    try {
      await failTransport.send(msg, {
        signal: new AbortController().signal,
        attempt: 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MailProviderError);
      expect((err as MailProviderError).provider).toBe("postmark");
      expect((err as MailProviderError).providerCode).toBe("406");
      expect((err as MailProviderError).permanent).toBe(true);
    }
  });

  it("SendGridTransport sends personalizations with text/plain before text/html and reads x-message-id", async () => {
    let capturedBody: Record<string, unknown> = {};
    const transport = new SendGridTransport({
      apiKey: "sg_key",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response("", {
          status: 202,
          headers: { "x-message-id": "sg_mid_42" },
        });
      }) as unknown as typeof fetch,
    });

    const msg = await makeMessage();
    const res = await transport.send(msg, {
      signal: new AbortController().signal,
      attempt: 1,
    });
    expect(res.providerMessageId).toBe("sg_mid_42");
    expect(
      (capturedBody.content as Array<{ type: string }>).map((c) => c.type),
    ).toEqual(["text/plain", "text/html"]);

    const errTransport = new SendGridTransport({
      apiKey: "sg_key",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            errors: [{ field: "from", message: "unverified" }],
          }),
          { status: 403 },
        )) as unknown as typeof fetch,
    });
    await expect(
      errTransport.send(msg, {
        signal: new AbortController().signal,
        attempt: 1,
      }),
    ).rejects.toThrow(/from: unverified/);
  });

  it("SesTransport signs requests with AWS SigV4 (including sessionToken) and handles SES throttling errors", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const transport = new SesTransport({
      region: "eu-west-1",
      credentials: async () => ({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "SESSION_TOK",
      }),
      configurationSetName: "prod-events",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ MessageId: "ses-mid-99" }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    const msg = await makeMessage();
    const res = await transport.send(msg, {
      signal: new AbortController().signal,
      attempt: 1,
    });
    expect(res.providerMessageId).toBe("ses-mid-99");
    expect(capturedUrl).toBe(
      "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
    );
    expect(capturedHeaders["x-amz-security-token"]).toBe("SESSION_TOK");
    expect(capturedHeaders["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(capturedHeaders.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(capturedBody.ConfigurationSetName).toBe("prod-events");
    const rawMime = Buffer.from(
      (capturedBody.Content as { Raw: { Data: string } }).Raw.Data,
      "base64",
    ).toString("utf8");
    expect(rawMime).toContain("Subject: Order #1");

    // Verify deterministic SigV4 signature vector
    const sig = signV4(
      {
        method: "GET",
        path: "/",
        query: "Action=ListUsers&Version=2010-05-08",
        headers: [
          ["Host", "iam.amazonaws.com"],
          ["Content-Type", "application/x-www-form-urlencoded; charset=utf-8"],
        ],
        body: "",
      },
      {
        credentials: {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
        region: "us-east-1",
        service: "iam",
        date: new Date("2015-08-30T12:36:00Z"),
      },
    );
    expect(sig.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );

    // Throttling error with 400 status is classified as transient
    const throttled = new SesTransport({
      region: "us-east-1",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      fetch: (async () =>
        new Response(JSON.stringify({ message: "Slow down" }), {
          status: 400,
          headers: { "x-amzn-errortype": "ThrottlingException:http://aws" },
        })) as unknown as typeof fetch,
    });
    try {
      await throttled.send(msg, {
        signal: new AbortController().signal,
        attempt: 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MailProviderError);
      expect((err as MailProviderError).providerCode).toBe(
        "ThrottlingException",
      );
      expect((err as MailProviderError).permanent).toBe(false);
    }
  });

  it("handles HTTP timeout and network failures cleanly", async () => {
    const msg = await makeMessage();

    const slow = new ResendTransport({
      apiKey: "k",
      timeout: "30ms",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        })) as unknown as typeof fetch,
    });
    await expect(
      slow.send(msg, { signal: new AbortController().signal, attempt: 1 }),
    ).rejects.toThrow(MailTimeoutError);

    const netErr = new ResendTransport({
      apiKey: "k",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(
      netErr.send(msg, { signal: new AbortController().signal, attempt: 1 }),
    ).rejects.toThrow(MailConnectionError);
  });
});
