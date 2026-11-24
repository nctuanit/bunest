import { describe, expect, it } from "bun:test";
import {
  ensureDir,
  Inject,
  Injectable,
  join,
  Module,
  readDirNames,
  removePath,
  type LoggerService,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  FileMailTransport,
  html,
  InMemoryMailTransport,
  LogMailTransport,
  MAIL_MODULE_OPTIONS,
  Mailer,
  MailEvents,
  MailModule,
  MailTemplateError,
  MailTransport,
  type Mailable,
  type MailModuleOptions,
  type MailOptionsFactory,
  type MailRenderContext,
  type MailTransportResult,
  type MailMessage,
} from "../src";

@Injectable()
class GreetingService {
  prefix() {
    return "Hello";
  }
}

@Injectable()
class WelcomeMail implements Mailable<{ name: string; token: string }> {
  constructor(private readonly greeting: GreetingService) {}

  render(data: { name: string; token: string }, ctx: MailRenderContext) {
    return {
      subject: `${this.greeting.prefix()}, ${data.name}! (${ctx.locale ?? "default"})`,
      html: html`<p>Welcome ${data.name}!</p>
        <a href="https://app.example.com/verify?token=${data.token}"
          >Verify</a
        >`,
      headers: { "X-Mail-Kind": "welcome" },
    };
  }
}

class UnregisteredMail implements Mailable {
  render(_data: void, ctx: MailRenderContext) {
    return {
      subject: `Ping ${ctx.to.map((a) => a.address).join(",")}`,
      text: "Pong",
    };
  }
}

describe("MailModule, Mailer, InMemoryMailTransport, LogMailTransport & FileMailTransport", () => {
  it("supports MailModule.forRoot(), Mailable classes (DI provider & ad-hoc), and SentMail helpers", async () => {
    const mailbox = new InMemoryMailTransport();
    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: mailbox,
          from: "App <noreply@example.com>",
        }),
      ],
      providers: [GreetingService, WelcomeMail],
    }).compile();

    const mailer = mod.get(Mailer);
    expect(mod.get(MAIL_MODULE_OPTIONS)).toEqual({
      from: "App <noreply@example.com>",
    });

    await mailer.send(WelcomeMail, {
      to: "ada@example.com",
      data: { name: "Ada", token: "secret-123" },
      locale: "fr",
      attachments: [{ filename: "guide.txt", content: "hello" }],
    });

    const sent = mailbox.assertSent({
      to: "ADA@example.com",
      mail: WelcomeMail,
      subject: /Hello, Ada!/,
    });
    expect(sent.subject).toBe("Hello, Ada! (fr)");
    expect(sent.locale).toBe("fr");
    expect(sent.headers["X-Mail-Kind"]).toBe("welcome");
    expect(sent.link("/verify").searchParams.get("token")).toBe("secret-123");
    expect(sent.attachment("guide.txt").content.toString("utf8")).toBe("hello");
    expect(sent.raw).toContain("Subject: Hello, Ada! (fr)");
    expect(() => sent.link("/missing")).toThrow(/No link matching/);
    expect(() => sent.attachment("nope.pdf")).toThrow(/No attachment/);

    // Unregistered Mailable resolved via ModuleRef.create()
    await mailer.send(UnregisteredMail, { to: "bob@example.com" });
    mailbox.assertSent({ mail: UnregisteredMail, to: "bob@example.com" });
    mailbox.assertNotSent({ to: "nobody@example.com" });

    expect(mailbox.mails).toHaveLength(2);
    expect(
      mailbox.filter((m) => m.to[0]?.address === "bob@example.com"),
    ).toHaveLength(1);
    expect(() => mailbox.assertNotSent({ to: "bob@example.com" })).toThrow(
      /Expected no mail/,
    );

    mailbox.clear();
    expect(mailbox.mails).toHaveLength(0);
    expect(() => mailbox.assertSent()).toThrow(/No mail was sent/);

    await mod.close();
  });

  it("supports MailModule.forRootAsync() with useFactory and useClass", async () => {
    const CONFIG = Symbol("MAIL_CFG");

    @Module({
      providers: [{ provide: CONFIG, useValue: { from: "async@example.com" } }],
      exports: [CONFIG],
    })
    class ConfigModule {}

    const mailbox = new InMemoryMailTransport();
    const mod1 = await Test.createTestingModule({
      imports: [
        MailModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: (cfg: { from: string }) => ({
            transport: mailbox,
            from: cfg.from,
          }),
        }),
      ],
    }).compile();

    const mailer1 = mod1.get(Mailer);
    await mailer1.send({ to: "u@example.com", subject: "Async", text: "ok" });
    expect(mailbox.assertSent().from.address).toBe("async@example.com");
    await mod1.close();

    // useClass with MailOptionsFactory
    const mailbox2 = new InMemoryMailTransport();
    @Injectable()
    class MyMailOptionsFactory implements MailOptionsFactory {
      createMailOptions(): MailModuleOptions {
        return { transport: mailbox2, from: "factory@example.com" };
      }
    }

    const mod2 = await Test.createTestingModule({
      imports: [
        MailModule.forRootAsync({
          useClass: MyMailOptionsFactory,
        }),
      ],
    }).compile();

    const mailer2 = mod2.get(Mailer);
    await mailer2.send({ to: "u@example.com", subject: "Factory", text: "ok" });
    expect(mailbox2.assertSent().from.address).toBe("factory@example.com");
    await mod2.close();

    // useExisting + class transport with injected dependency
    const TAG = Symbol("TRANSPORT_TAG");
    const recorded: string[] = [];

    @Injectable()
    class InjectedTransport extends MailTransport {
      constructor(@Inject(TAG) private readonly tag: string) {
        super();
      }
      override async send(message: MailMessage): Promise<MailTransportResult> {
        recorded.push(`${this.tag}:${message.subject}`);
        return { accepted: message.envelope.to };
      }
    }

    @Injectable()
    class ExistingMailOptionsFactory implements MailOptionsFactory {
      createMailOptions(): MailModuleOptions {
        return { from: "existing@example.com" };
      }
    }

    @Module({
      providers: [
        { provide: TAG, useValue: "di-ok" },
        ExistingMailOptionsFactory,
      ],
      exports: [TAG, ExistingMailOptionsFactory],
    })
    class SharedModule {}

    const mod3 = await Test.createTestingModule({
      imports: [
        MailModule.forRootAsync({
          imports: [SharedModule],
          transport: InjectedTransport,
          useExisting: ExistingMailOptionsFactory,
        }),
      ],
    }).compile();

    await mod3
      .get(Mailer)
      .send({ to: "u@example.com", subject: "ClassTransport", text: "hi" });
    expect(recorded).toEqual(["di-ok:ClassTransport"]);
    await mod3.close();
  });

  it("validates MailModule transport/template placement and missing template engine", async () => {
    expect(() => MailModule.forRoot({} as never)).toThrow(
      /MailModule needs a `transport`/,
    );

    const t1 = new InMemoryMailTransport();
    const t2 = new InMemoryMailTransport();
    await expect(
      Test.createTestingModule({
        imports: [
          MailModule.forRootAsync({
            transport: t1,
            useFactory: () => ({ transport: t2 }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/set both at the top level/);

    // Missing template engine when sending template
    const mod = await Test.createTestingModule({
      imports: [MailModule.forRoot({ transport: t1, from: "a@b.com" })],
    }).compile();
    const mailer = mod.get(Mailer);
    await expect(
      mailer.send({ to: "u@b.com", subject: "T", template: "welcome" }),
    ).rejects.toThrow(MailTemplateError);
    await mod.close();
  });

  it("drains in-flight sends, closes transport, and completes events$ on shutdown", async () => {
    let closed = false;
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const startedPromise = new Promise<void>((r) => (sendStarted = r));

    class SlowTransport extends MailTransport {
      override async send(message: MailMessage): Promise<MailTransportResult> {
        sendStarted();
        await new Promise<void>((r) => (releaseSend = r));
        return { accepted: message.envelope.to };
      }
      override async close() {
        closed = true;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: new SlowTransport(),
          from: "a@example.com",
        }),
      ],
    }).compile();

    const mailer = mod.get(Mailer);
    const events = mod.get(MailEvents);
    let completed = false;
    const seen: string[] = [];
    events.events$.subscribe({
      next: (e) => seen.push(e.type),
      complete: () => {
        completed = true;
      },
    });

    const pending = mailer.send({
      to: "u@example.com",
      subject: "Slow",
      text: "hi",
    });
    await startedPromise;

    const closing = mod.close();
    // Should still be waiting for the in-flight send before closing transport / completing events$
    await Bun.sleep(15);
    expect(closed).toBe(false);
    expect(completed).toBe(false);

    releaseSend();
    await pending;
    await closing;

    expect(seen).toEqual(["sent"]);
    expect(closed).toBe(true);
    expect(completed).toBe(true);
  });

  it("supports LogMailTransport and FileMailTransport", async () => {
    const logs: string[] = [];
    const debugs: string[] = [];
    const customLogger: LoggerService = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      warn: () => {},
      debug: (msg: string) => debugs.push(msg),
    };

    const logMod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: new LogMailTransport({ logger: customLogger, body: true }),
          from: "a@example.com",
        }),
      ],
    }).compile();
    await logMod.get(Mailer).send({
      to: "user@example.com",
      subject: "Logged",
      text: "Sign-in link here",
      attachments: [{ filename: "a.txt", content: "x" }],
    });
    expect(logs[0]).toContain(
      '"Logged" to user@example.com with 1 attachment(s): a.txt',
    );
    expect(debugs[0]).toBe("Sign-in link here");
    await logMod.close();

    const outDir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-mail-eml-${crypto.randomUUID()}`,
    );
    await ensureDir(outDir);
    try {
      const fileMod = await Test.createTestingModule({
        imports: [
          MailModule.forRoot({
            transport: new FileMailTransport({ directory: outDir, log: false }),
            from: "a@example.com",
          }),
        ],
      }).compile();
      const res = await fileMod.get(Mailer).send({
        to: "user@example.com",
        subject: "Saved to disk",
        text: "Hello EML",
      });
      const files = await readDirNames(outDir);
      expect(files).toHaveLength(1);
      expect(files[0]?.endsWith(".eml")).toBe(true);
      expect(res.response).toBe(join(outDir, files[0]!));
      const content = await Bun.file(res.response!).text();
      expect(content).toContain("Subject: Saved to disk");
      expect(content).toContain("Hello EML");
      await fileMod.close();
    } finally {
      await removePath(outDir, { recursive: true, force: true });
    }
  });
});
