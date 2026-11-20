import { afterEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Test } from "@bunest/testing";
import {
  MailConnectionError,
  Mailer,
  MailModule,
  MailRecipientsRejectedError,
  MailSmtpError,
  MailTimeoutError,
  SmtpTransport,
} from "../src";
import {
  createDkimSigner,
  parseHeaderFields,
  relaxedBody,
  relaxedHeader,
} from "../src/smtp/dkim.util";
import { toSmtpData } from "../src/smtp/smtp-connection";

interface RecordedSmtpTx {
  ehlo?: string;
  authCommands: string[];
  mailFrom?: string;
  rcptTo: string[];
  data?: string;
}

interface MockSmtpBehavior {
  capabilities?: string[];
  authOk?: boolean;
  rejectRcpt?: Record<string, string>;
  dropBeforeSecondMailFrom?: boolean;
  stallOnData?: boolean;
}

function startMockSmtpServer(behavior: MockSmtpBehavior = {}): Promise<{
  server: Server;
  port: number;
  connections: () => number;
  transactions: RecordedSmtpTx[];
}> {
  const transactions: RecordedSmtpTx[] = [];
  let connCount = 0;

  const server = createServer((socket: Socket) => {
    connCount++;
    let txCount = 0;
    let buf = "";
    let inData = false;
    let dataBuf = "";
    let loginStage = 0;
    let current: RecordedSmtpTx = { authCommands: [], rcptTo: [] };

    socket.write("220 mock.smtp.local ESMTP ready\r\n");

    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      while (true) {
        if (inData) {
          const endIdx = buf.indexOf("\r\n.\r\n");
          if (endIdx === -1) {
            return;
          }
          dataBuf += buf.slice(0, endIdx);
          buf = buf.slice(endIdx + 5);
          inData = false;
          // Unstuff leading dots
          current.data = dataBuf.replace(/(^|\r\n)\.\./g, "$1.");
          dataBuf = "";
          transactions.push(current);
          current = { authCommands: [], rcptTo: [] };
          txCount++;
          if (!behavior.stallOnData) {
            socket.write(`250 2.0.0 Ok: queued as MSG${txCount}\r\n`);
          }
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) {
          return;
        }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);

        if (loginStage === 1) {
          current.authCommands.push(line);
          loginStage = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (loginStage === 2) {
          current.authCommands.push(line);
          loginStage = 0;
          socket.write(
            behavior.authOk === false
              ? "535 5.7.8 Authentication credentials invalid\r\n"
              : "235 2.7.0 Authentication successful\r\n",
          );
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO ")) {
          current.ehlo = line;
          const caps = behavior.capabilities ?? [
            "AUTH PLAIN LOGIN XOAUTH2",
            "SIZE 1048576",
            "SMTPUTF8",
            "8BITMIME",
          ];
          if (caps.length === 0) {
            socket.write("250 mock.smtp.local\r\n");
          } else {
            socket.write("250-mock.smtp.local\r\n");
            caps.forEach((cap, idx) => {
              socket.write(`${idx === caps.length - 1 ? "250 " : "250-"}${cap}\r\n`);
            });
          }
        } else if (upper.startsWith("AUTH LOGIN")) {
          current.authCommands.push(line);
          loginStage = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("AUTH ")) {
          current.authCommands.push(line);
          socket.write(
            behavior.authOk === false
              ? "535 5.7.8 Authentication credentials invalid\r\n"
              : "235 2.7.0 Authentication successful\r\n",
          );
        } else if (upper.startsWith("MAIL FROM:")) {
          if (behavior.dropBeforeSecondMailFrom && txCount === 1) {
            socket.destroy();
            return;
          }
          current.mailFrom = line;
          socket.write("250 2.1.0 Ok\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          const addr = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
          current.rcptTo.push(addr);
          const rejectReply = behavior.rejectRcpt?.[addr];
          if (rejectReply) {
            socket.write(`${rejectReply}\r\n`);
          } else {
            socket.write("250 2.1.5 Ok\r\n");
          }
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "RSET") {
          current = { authCommands: [], rcptTo: [] };
          socket.write("250 2.0.0 Ok\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("502 Command not implemented\r\n");
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, connections: () => connCount, transactions });
    });
  });
}

function verifyDkimSignedMime(signedMime: Buffer, publicKey: KeyObject, algorithm: "rsa-sha256" | "ed25519-sha256") {
  const text = signedMime.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const head = text.slice(0, split + 2);
  const body = text.slice(split + 4);
  const fields = parseHeaderFields(head);
  const dkimField = fields.find((f) => f.name.toLowerCase() === "dkim-signature")!;
  expect(dkimField).toBeDefined();

  const unfolded = dkimField.raw.replace(/\r\n[ \t]+/g, " ");
  const tags = Object.fromEntries(
    unfolded
      .slice(unfolded.indexOf(":") + 1)
      .split(";")
      .map((part) => {
        const eq = part.indexOf("=");
        return [part.slice(0, eq).trim(), part.slice(eq + 1).trim()];
      }),
  );

  // Verify body hash (bh)
  const expectedBh = createHash("sha256").update(relaxedBody(body), "utf8").digest("base64");
  expect(tags.bh).toBe(expectedBh);

  // Reconstruct signed header payload (bottom-up per RFC 6376)
  const restFields = fields.filter((f) => f !== dkimField);
  const used = new Map<string, number>();
  let payload = "";
  for (const name of tags.h!.split(":")) {
    const matching = restFields.filter((f) => f.name.toLowerCase() === name);
    const idx = matching.length - 1 - (used.get(name) ?? 0);
    used.set(name, (used.get(name) ?? 0) + 1);
    if (idx >= 0) {
      payload += `${relaxedHeader(matching[idx]!.raw)}\r\n`;
    }
  }
  payload += relaxedHeader(dkimField.raw.replace(/(\bb=)[\s\S]*$/, "$1"));

  const sigBuf = Buffer.from(tags.b!.replace(/\s+/g, ""), "base64");
  const ok =
    algorithm === "ed25519-sha256"
      ? verify(null, createHash("sha256").update(payload, "utf8").digest(), publicKey, sigBuf)
      : verify("sha256", Buffer.from(payload, "utf8"), publicKey, sigBuf);
  expect(ok).toBe(true);
}

describe("SmtpTransport (real loopback TCP mock SMTP server) & DKIM", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  it("delivers mail via real TCP SMTP with AUTH PLAIN, URL config, dot-stuffing, and verify()", async () => {
    const mock = await startMockSmtpServer();
    servers.push(mock.server);

    const transport = new SmtpTransport({
      url: `smtp://alice%40example.com:s3cr%3At@127.0.0.1:${mock.port}`,
    });

    await transport.verify();

    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport,
          from: "Sender <sender@example.com>",
          retry: false,
        }),
      ],
    }).compile();

    const res = await mod.get(Mailer).send({
      to: "ada@example.com",
      bcc: "hidden@example.com",
      subject: "Real SMTP",
      text: "Hello\n.leading dot\nEnd",
    });

    expect(res.accepted).toEqual(["ada@example.com", "hidden@example.com"]);
    expect(res.response).toBe("250 2.0.0 Ok: queued as MSG1");
    expect(mock.transactions).toHaveLength(1);
    expect(mock.transactions[0]?.authCommands[0]).toStartWith("AUTH PLAIN ");
    expect(mock.transactions[0]?.mailFrom).toContain("MAIL FROM:<sender@example.com> SIZE=");
    expect(mock.transactions[0]?.rcptTo).toEqual(["ada@example.com", "hidden@example.com"]);
    expect(mock.transactions[0]?.data).toContain("Subject: Real SMTP");
    expect(mock.transactions[0]?.data).not.toContain("hidden@example.com");

    // Verify toSmtpData dot-stuffing directly
    const stuffed = toSmtpData(Buffer.from("a\n.b\r..c")).toString("utf8");
    expect(stuffed).toBe("a\r\n..b\r\n...c\r\n.\r\n");

    await mod.close();
  });

  it("supports AUTH LOGIN, AUTH XOAUTH2 (with async token), and rejects bad credentials (535 permanent)", async () => {
    const mock = await startMockSmtpServer();
    servers.push(mock.server);

    const loginTransport = new SmtpTransport({
      host: "127.0.0.1",
      port: mock.port,
      auth: { user: "bob", pass: "pw" },
      authMethod: "LOGIN",
    });
    await loginTransport.verify();

    const oauthTransport = new SmtpTransport({
      host: "127.0.0.1",
      port: mock.port,
      auth: { user: "bob", accessToken: async () => "ya29.fresh" },
    });
    await oauthTransport.verify();

    const failMock = await startMockSmtpServer({ authOk: false });
    servers.push(failMock.server);
    const badAuth = new SmtpTransport({
      host: "127.0.0.1",
      port: failMock.port,
      auth: { user: "bob", pass: "wrong" },
    });
    try {
      await badAuth.verify();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MailSmtpError);
      expect((err as MailSmtpError).code).toBe(535);
      expect((err as MailSmtpError).permanent).toBe(true);
    }
  });

  it("pools and reuses connections, recovers after stale drop, and resets on RCPT rejection", async () => {
    const mock = await startMockSmtpServer({
      rejectRcpt: { "bad@example.com": "550 5.1.1 User unknown" },
    });
    servers.push(mock.server);

    const transport = new SmtpTransport({
      host: "127.0.0.1",
      port: mock.port,
      pool: { maxConnections: 2, maxMessages: 10, idleTimeout: "5s" },
    });

    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport,
          from: "a@example.com",
          retry: false,
        }),
      ],
    }).compile();
    const mailer = mod.get(Mailer);

    await mailer.send({ to: "ok1@example.com", subject: "1", text: "one" });
    await mailer.send({ to: "ok2@example.com", subject: "2", text: "two" });
    // Pooled: reused the single connection
    expect(mock.connections()).toBe(1);

    // Partial recipient refusal resets transaction without DATA, then connection still works
    await expect(
      mailer.send({ to: ["ok3@example.com", "bad@example.com"], subject: "3", text: "three" }),
    ).rejects.toThrow(MailRecipientsRejectedError);
    expect(mock.transactions).toHaveLength(2);

    await mailer.send({ to: "ok4@example.com", subject: "4", text: "four" });
    expect(mock.connections()).toBe(1);
    expect(mock.transactions).toHaveLength(3);

    await mod.close();
    // Closed transport refuses further sends
    await expect(
      transport.send(await mailer.render({ to: "a@b.com", subject: "s", text: "t" }), {
        signal: new AbortController().signal,
        attempt: 1,
      }),
    ).rejects.toThrow(MailConnectionError);

    // Transparent stale pooled connection recovery
    const dropMock = await startMockSmtpServer({ dropBeforeSecondMailFrom: true });
    servers.push(dropMock.server);
    const poolTransport = new SmtpTransport({
      host: "127.0.0.1",
      port: dropMock.port,
      pool: true,
    });
    const mod2 = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({ transport: poolTransport, from: "a@example.com", retry: false }),
      ],
    }).compile();
    await mod2.get(Mailer).send({ to: "u@example.com", subject: "First", text: "1" });
    await mod2.get(Mailer).send({ to: "u@example.com", subject: "Second", text: "2" });
    expect(dropMock.connections()).toBe(2);
    expect(dropMock.transactions).toHaveLength(2);
    await mod2.close();
  });

  it("enforces SIZE limit, SMTPUTF8 capability, startTls: required, and data timeout", async () => {
    const smallMock = await startMockSmtpServer({ capabilities: ["SIZE 50"] });
    servers.push(smallMock.server);

    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: new SmtpTransport({ host: "127.0.0.1", port: smallMock.port }),
          from: "a@example.com",
          retry: false,
        }),
      ],
    }).compile();
    const mailer = mod.get(Mailer);

    await expect(
      mailer.send({ to: "u@example.com", subject: "Too big", text: "x".repeat(200) }),
    ).rejects.toThrow(MailSmtpError);

    // Server without SMTPUTF8 refuses internationalized address
    const noUtf8Mock = await startMockSmtpServer({ capabilities: ["SIZE 100000"] });
    servers.push(noUtf8Mock.server);
    const mod2 = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: new SmtpTransport({ host: "127.0.0.1", port: noUtf8Mock.port }),
          from: "a@example.com",
          retry: false,
        }),
      ],
    }).compile();
    await expect(
      mod2.get(Mailer).send({ to: "josé@example.com", subject: "UTF8", text: "hi" }),
    ).rejects.toThrow(MailConnectionError);

    // startTls: required fails permanently when server does not advertise STARTTLS
    const reqTls = new SmtpTransport({
      host: "127.0.0.1",
      port: noUtf8Mock.port,
      startTls: "required",
    });
    await expect(reqTls.verify()).rejects.toThrow(MailConnectionError);

    // Data timeout triggers MailTimeoutError
    const stallMock = await startMockSmtpServer({ stallOnData: true });
    servers.push(stallMock.server);
    const mod3 = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: new SmtpTransport({
            host: "127.0.0.1",
            port: stallMock.port,
            timeouts: { data: "40ms" },
          }),
          from: "a@example.com",
          retry: false,
        }),
      ],
    }).compile();
    await expect(
      mod3.get(Mailer).send({ to: "u@example.com", subject: "Stall", text: "hi" }),
    ).rejects.toThrow(MailTimeoutError);

    await Promise.all([mod.close(), mod2.close(), mod3.close()]);
  });

  it("signs MIME messages with cryptographically verifiable DKIM (RSA-SHA256 and Ed25519-SHA256) and sends over SMTP", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const ed = generateKeyPairSync("ed25519");

    const mock = await startMockSmtpServer();
    servers.push(mock.server);

    const transport = new SmtpTransport({
      host: "127.0.0.1",
      port: mock.port,
      dkim: {
        domainName: "example.com",
        keySelector: "mail2026",
        privateKey: rsa.privateKey,
      },
    });
    const mod = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({ transport, from: "a@example.com", retry: false }),
      ],
    }).compile();
    await mod.get(Mailer).send({
      to: "ada@example.com",
      subject: "Signed",
      text: "Verified body",
      headers: { "X-Custom": "value" },
    });

    const received = Buffer.from(mock.transactions[0]!.data!, "utf8");
    verifyDkimSignedMime(received, rsa.publicKey, "rsa-sha256");
    expect(mock.transactions[0]!.data).toContain("d=example.com;");
    expect(mock.transactions[0]!.data).toContain("s=mail2026;");
    expect(mock.transactions[0]!.data).toContain("h=from:to:subject:date:message-id:mime-version:content-type:content-transfer-encoding:x-custom:from");

    // Also test Ed25519-SHA256 DKIM signing directly
    const edSigner = createDkimSigner(
      {
        domainName: "example.com",
        keySelector: "ed2026",
        privateKey: ed.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      },
      "test",
    );
    const sampleMime = Buffer.from(
      "From: a@example.com\r\nTo: b@example.com\r\nSubject: Ed25519\r\n\r\nHello world\r\n",
      "utf8",
    );
    const edSigned = edSigner(sampleMime, Date.UTC(2026, 8, 22, 0, 0, 0));
    verifyDkimSignedMime(edSigned, ed.publicKey, "ed25519-sha256");

    await mod.close();
  });
});
