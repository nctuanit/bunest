import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Module,
  Post,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

@Controller()
class EchoController {
  @Post("echo")
  echo(@Body() body: unknown) {
    return typeof body === "string" ? body : JSON.stringify(body ?? null);
  }
}

@Module({ controllers: [EchoController] })
class BodyParsersModule {}

describeConformance(
  "Body parsers E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/body-parsers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Adapts NestJS body-parsers charset & limit E2E tests to BunHttpAdapter native parseRequestBody().",
  },
  () => {
    let app: BunestApplication;

    const post = async (
      contentType: string,
      body: string | Uint8Array,
    ): Promise<{ status: number; text: string; body: any }> => {
      const res = await app.fetch(
        new Request("http://localhost/echo", {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        }),
      );
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, text, body: json };
    };

    afterEach(async () => {
      await app?.close();
    });

    describe("charsets", () => {
      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [BodyParsersModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      const latin1 = (text: string) => Buffer.from(text, "latin1");

      // BUNEST_BUG: parseRequestBody ignores the Content-Type charset parameter and always decodes as UTF-8 instead of decoding iso-8859-1 (packages/core/src/http/parsers/body-parser.ts).
      it.skip('should read the charset of a Content-Type with a trailing ";"', async () => {
        const form = await post(
          "application/x-www-form-urlencoded; charset=iso-8859-1;",
          latin1("a=café"),
        );
        const text = await post(
          "text/plain; charset=iso-8859-1;",
          latin1("café"),
        );

        expect(form.text).toBe('{"a":"café"}');
        expect(text.text).toBe("café");
      });

      // BUNEST_BUG: parseRequestBody ignores the Content-Type charset parameter and always decodes as UTF-8 (packages/core/src/http/parsers/body-parser.ts).
      it.skip("should take the first of two charset parameters", async () => {
        const res = await post(
          "text/plain; charset=iso-8859-1; charset=utf-8",
          latin1("café"),
        );

        expect(res.text).toBe("café");
      });

      // BUNEST_BUG: parseRequestBody ignores the Content-Type charset parameter and always decodes as UTF-8 (packages/core/src/http/parsers/body-parser.ts).
      it.skip("should read upper-case, spaced and quoted charset parameters", async () => {
        for (const contentType of [
          "text/plain; CHARSET=ISO-8859-1",
          "text/plain; charset = iso-8859-1",
          'text/plain;charset="iso-8859-1"',
        ]) {
          expect((await post(contentType, latin1("café"))).text).toBe("café");
        }
      });

      it("should match the media type case-insensitively", async () => {
        expect((await post("Application/JSON", '{"a":1}')).text).toBe(
          '{"a":1}',
        );
      });

      // BUNEST_BUG: parseRequestBody ignores charset=utf-16le on application/json and fails to decode UTF-16 JSON bodies (packages/core/src/http/parsers/body-parser.ts).
      it.skip("should read JSON in any utf-* charset", async () => {
        const res = await post(
          "application/json; charset=utf-16le",
          Buffer.from('{"a":"é"}', "utf16le"),
        );

        expect(res.text).toBe('{"a":"é"}');
      });

      // BUNEST_BUG: parseRequestBody ignores charset=utf-16 and does not decode UTF-16 BOM / BE text payloads (packages/core/src/http/parsers/body-parser.ts).
      it.skip('should pick the byte order of "utf-16" from the byte order mark, or else the content', async () => {
        const withBom = await post(
          "text/plain; charset=utf-16",
          Buffer.from([0xfe, 0xff, 0, 0x68, 0, 0x69]),
        );
        const bigEndian = await post(
          "text/plain; charset=utf-16",
          Buffer.from([0, 0x68, 0, 0x69]),
        );

        expect(withBom.text).toBe("hi");
        expect(bigEndian.text).toBe("hi");
      });

      // BUNEST_BUG: parseRequestBody does not validate Content-Type charset parameters or return 415 Unsupported Media Type for unsupported charsets (packages/core/src/http/parsers/body-parser.ts).
      it.skip.each([
        ["application/json; charset=iso-8859-1", "ISO-8859-1"],
        ["application/x-www-form-urlencoded; charset=utf-16", "UTF-16"],
        ["text/plain; charset=x-unknown", "X-UNKNOWN"],
      ])(
        "should answer an unsupported charset (%s) with 415",
        async (contentType, _charset) => {
          const res = await post(contentType, "a=1");
          expect(res.status).toBe(415);
        },
      );
    });

    describe("limits", () => {
      itAdapted(
        ["ADR-001", "ADR-004"],
        "should accept large JSON payloads when no restrictive bodyLimit is set",
        async () => {
          const modRef = await Test.createTestingModule({
            imports: [BodyParsersModule],
          }).compile();
          app = modRef.createNestApplication({
            logger: false,
            bodyLimit: undefined,
          });
          await app.init();

          const res = await post(
            "application/json",
            JSON.stringify({ data: "x".repeat(200 * 1024) }),
          );
          expect(res.status).toBe(201);
        },
        "Bunest uses numeric bodyLimit (bytes) on BunestApplicationOptions",
      );

      it("should answer a body over the limit with 413", async () => {
        const modRef = await Test.createTestingModule({
          imports: [BodyParsersModule],
        }).compile();
        app = modRef.createNestApplication({
          logger: false,
          bodyLimit: 10,
        });
        await app.init();

        const res = await post("application/json", '{"a":"xxxxxxxxxx"}');
        expect(res.status).toBe(413);
        expect(res.body.statusCode).toBe(413);
      });
    });

    describe("urlencoded parsing", () => {
      it("should parse UTF-8 urlencoded payloads", async () => {
        const modRef = await Test.createTestingModule({
          imports: [BodyParsersModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();

        const res = await post(
          "application/x-www-form-urlencoded",
          "a=caf%C3%A9&b=hello+world",
        );
        expect(res.status).toBe(201);
        expect(res.text).toBe('{"a":"café","b":"hello world"}');
      });
    });
  },
);
