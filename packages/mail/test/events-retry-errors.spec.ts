import { describe, expect, it } from "bun:test";
import { subscribe, unsubscribe } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  InMemoryMailTransport,
  MailConnectionError,
  MailError,
  Mailer,
  MailEvents,
  MailMessageError,
  MailModule,
  MailProviderError,
  MailRecipientsRejectedError,
  MailSmtpError,
  MailTemplateError,
  MailTimeoutError,
  type MailEvent,
} from "../src";
import { toMs } from "../src/utils/duration.util";
import { parseRetryAfter } from "../src/utils/retry-after.util";
import {
  backoffDelay,
  resolveRetry,
  retryDelay,
} from "../src/utils/retry.util";

describe("MailEvents (zero-RxJS Subscribable & AsyncIterable + diagnostics_channel)", () => {
  it("emits sent and failed events to subscribers, async iterators, and diagnostics_channel", async () => {
    const mailbox = new InMemoryMailTransport();
    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: mailbox,
          from: "a@example.com",
          retry: false,
        }),
      ],
    }).compile();

    const mailer = mod.get(Mailer);
    const mailEvents = mod.get(MailEvents);

    const subEvents: MailEvent[] = [];
    let subCompleted = false;
    const sub = mailEvents.events$.subscribe({
      next: (e) => subEvents.push(e),
      complete: () => {
        subCompleted = true;
      },
    });

    const fnEvents: MailEvent[] = [];
    const fnSub = mailEvents.events$.subscribe((e) => fnEvents.push(e));

    const diagSent: unknown[] = [];
    const diagFailed: unknown[] = [];
    const onSent = (msg: unknown) => diagSent.push(msg);
    const onFailed = (msg: unknown) => diagFailed.push(msg);
    subscribe("nestjs:mail:sent", onSent);
    subscribe("nestjs:mail:failed", onFailed);

    const iterEvents: MailEvent[] = [];
    const iterTask = (async () => {
      for await (const ev of mailEvents.events$) {
        iterEvents.push(ev);
      }
    })();

    try {
      await mailer.send({
        to: "ok@example.com",
        subject: "Success",
        text: "hi",
      });
      fnSub.unsubscribe();

      mailbox.failNext(
        new MailProviderError({
          provider: "resend",
          status: 422,
          detail: "bad",
        }),
      );
      await expect(
        mailer.send({ to: "bad@example.com", subject: "Fail", text: "hi" }),
      ).rejects.toThrow(MailProviderError);

      await mod.close();
      await iterTask;

      expect(subEvents.map((e) => e.type)).toEqual(["sent", "failed"]);
      expect(subCompleted).toBe(true);
      expect(fnEvents.map((e) => e.type)).toEqual(["sent"]);
      expect(iterEvents.map((e) => e.type)).toEqual(["sent", "failed"]);
      expect(diagSent).toHaveLength(1);
      expect(diagFailed).toHaveLength(1);
      expect(
        (subEvents[1] as Extract<MailEvent, { type: "failed" }>).permanent,
      ).toBe(true);

      // Subscribing after complete calls complete immediately
      let lateCompleted = false;
      mailEvents.events$.subscribe({ complete: () => (lateCompleted = true) });
      expect(lateCompleted).toBe(true);
    } finally {
      sub.unsubscribe();
      unsubscribe("nestjs:mail:sent", onSent);
      unsubscribe("nestjs:mail:failed", onFailed);
    }
  });
});

describe("Retry, backoff, Retry-After, AbortSignal & Duration", () => {
  it("retries transient errors and does not retry permanent errors", async () => {
    const mailbox = new InMemoryMailTransport();
    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: mailbox,
          from: "a@example.com",
          retry: {
            attempts: 3,
            backoff: { delay: 1, factor: 1, jitter: "none" },
          },
        }),
      ],
    }).compile();

    const mailer = mod.get(Mailer);

    // 2 transient failures -> succeeds on attempt 3
    mailbox.failNext(new MailConnectionError("reset", { permanent: false }));
    mailbox.failNext(
      new MailProviderError({
        provider: "resend",
        status: 429,
        retryAfterMs: 5,
      }),
    );
    const res = await mailer.send({
      to: "u@example.com",
      subject: "Retry",
      text: "ok",
    });
    expect(res.attempts).toBe(3);

    // Permanent error -> fails immediately on attempt 1
    mailbox.failNext(
      new MailProviderError({
        provider: "resend",
        status: 400,
        detail: "invalid",
      }),
    );
    mailbox.failNext(new Error("should not be reached"));
    await expect(
      mailer.send({ to: "u@example.com", subject: "Perm", text: "ok" }),
    ).rejects.toThrow(MailProviderError);

    // retryIf can stop retries early
    mailbox.clear();
    mailbox.failNext(new MailConnectionError("temp", { permanent: false }));
    await expect(
      mailer.send({
        to: "u@example.com",
        subject: "NoRetryIf",
        text: "ok",
        retry: { attempts: 3, retryIf: () => false },
      }),
    ).rejects.toThrow(MailConnectionError);

    // Pre-aborted signal fails with 0 transport attempts
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      mailer.send({
        to: "u@example.com",
        subject: "Aborted",
        text: "ok",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");

    await mod.close();
  });

  it("parses durations, Retry-After headers, and computes backoff with jitter and Retry-After cap", () => {
    expect(toMs(250)).toBe(250);
    expect(toMs("250ms")).toBe(250);
    expect(toMs("30s")).toBe(30_000);
    expect(toMs("2m")).toBe(120_000);
    expect(toMs("1h")).toBe(3_600_000);
    expect(toMs("1d")).toBe(86_400_000);
    expect(toMs("1w")).toBe(604_800_000);
    expect(() => toMs(-1)).toThrow(TypeError);
    expect(() => toMs("abc" as never)).toThrow(TypeError);

    const now = Date.UTC(2026, 8, 22, 12, 0, 0);
    expect(parseRetryAfter("12", now)).toBe(12_000);
    expect(parseRetryAfter("Tue, 22 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfter("1.5", now)).toBeUndefined();

    const rNone = resolveRetry(
      { backoff: { delay: 100, factor: 2, maxDelay: 500, jitter: "none" } },
      "test",
    );
    expect(backoffDelay(rNone, 1, undefined)).toBe(100);
    expect(backoffDelay(rNone, 2, undefined)).toBe(200);
    expect(backoffDelay(rNone, 4, undefined)).toBe(500);

    // Retry-After lengthens wait up to maxDelay
    expect(retryDelay(rNone, 1, { retryAfterMs: 350 })).toBe(350);
    expect(retryDelay(rNone, 1, { retryAfterMs: 10_000 })).toBe(500);

    const rEqual = resolveRetry(
      { backoff: { delay: 100, jitter: "equal" } },
      "test",
    );
    expect(backoffDelay(rEqual, 1, undefined, () => 0.5)).toBe(75);
    const rFull = resolveRetry(
      { backoff: { delay: 100, jitter: "full" } },
      "test",
    );
    expect(backoffDelay(rFull, 1, undefined, () => 0.5)).toBe(50);
  });
});

describe("All 8 MailError subclasses", () => {
  it("constructs all 8 error classes with exact fields and permanence semantics", () => {
    const base = new MailError("base", {
      permanent: false,
      code: 503,
      cause: new Error("root"),
    });
    expect(base.name).toBe("MailError");
    expect(base.permanent).toBe(false);
    expect(base.code).toBe(503);

    const conn = new MailConnectionError("conn", { permanent: false });
    expect(conn).toBeInstanceOf(MailError);
    expect(conn.name).toBe("MailConnectionError");

    const msgErr = new MailMessageError("to[0]", "is invalid");
    expect(msgErr.status).toBe(400);
    expect(msgErr.field).toBe("to[0]");
    expect(msgErr.permanent).toBe(true);

    const prov429 = new MailProviderError({
      provider: "resend",
      status: 429,
      providerCode: "rate_limit",
      retryAfterMs: 5000,
    });
    expect(prov429.permanent).toBe(false);
    expect(prov429.code).toBe(429);
    expect(prov429.provider).toBe("resend");
    expect(prov429.providerCode).toBe("rate_limit");
    expect(prov429.retryAfterMs).toBe(5000);

    const prov422 = new MailProviderError({
      provider: "postmark",
      status: 422,
      detail: "bad",
    });
    expect(prov422.permanent).toBe(true);

    const smtp450 = new MailSmtpError("MAIL FROM", {
      code: 450,
      enhancedCode: "4.7.1",
      text: "try later",
    });
    expect(smtp450.permanent).toBe(false);
    expect(smtp450.command).toBe("MAIL FROM");
    expect(smtp450.enhancedCode).toBe("4.7.1");
    expect(smtp450.response).toBe("try later");

    const rej = new MailRecipientsRejectedError([
      { address: "a@x.com", code: 450, response: "busy" },
      {
        address: "b@x.com",
        code: 550,
        enhancedCode: "5.1.1",
        response: "no such user",
      },
    ]);
    expect(rej).toBeInstanceOf(MailSmtpError);
    expect(rej.permanent).toBe(true);
    expect(rej.code).toBe(550);
    expect(rej.rejected).toHaveLength(2);

    const tpl = new MailTemplateError("bad", {
      template: "order",
      file: "/a/order.html",
      shownAs: "order.html",
      line: 3,
      column: 7,
    });
    expect(tpl.permanent).toBe(true);
    expect(tpl.template).toBe("order");
    expect(tpl.file).toBe("/a/order.html");
    expect(tpl.line).toBe(3);
    expect(tpl.column).toBe(7);
    expect(tpl.message).toBe("order.html:3:7: bad");

    const timeout = new MailTimeoutError("data", 5000, "smtp.example.com:587");
    expect(timeout.permanent).toBe(false);
    expect(timeout.phase).toBe("data");
    expect(timeout.timeoutMs).toBe(5000);
  });
});
