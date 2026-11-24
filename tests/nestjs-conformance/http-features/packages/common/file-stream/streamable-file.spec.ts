import { describe, expect, it } from "bun:test";
import {
  HttpStatus,
  StreamableFile,
} from "../../../../../../packages/core/src/common";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

describeConformance(
  "StreamableFile",
  {
    upstreamPath: "packages/common/test/file-stream/streamable-file.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-010"],
    notes:
      "Bunest StreamableFile uses Web ReadableStream<Uint8Array>, Blob/BunFile, and Uint8Array/Buffer (ADR-010) instead of Node.js Readable streams.",
  },
  () => {
    describe("when input is a readable stream", () => {
      itAdapted(
        "ADR-010",
        "should assign it to a stream class property",
        () => {
          const stream = new ReadableStream<Uint8Array>();
          const streamableFile = new StreamableFile(stream);
          expect(streamableFile.getStream()).toBe(stream);
          expect(streamableFile.stream).toBe(stream);
        },
        "Web ReadableStream<Uint8Array>",
      );

      itAdapted(
        "ADR-010",
        "should handle an errored Web ReadableStream without throwing during construction",
        async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("ENOENT"));
            },
          });
          const streamableFile = new StreamableFile(stream);
          expect(streamableFile.getStream()).toBe(stream);
          const reader = streamableFile.getStream().getReader();
          await expect(reader.read()).rejects.toThrow("ENOENT");
        },
        "Web ReadableStream error propagation",
      );
    });

    describe("when input is a Blob", () => {
      itAdapted(
        "ADR-010",
        "should wrap Blob source and infer type and length",
        async () => {
          const blob = new Blob(["hello blob"], { type: "text/plain" });
          const streamableFile = new StreamableFile(blob);
          expect(streamableFile.getSource()).toBe(blob);
          const headers = streamableFile.getHeaders();
          expect(headers.type).toContain("text/plain");
          expect(headers.length).toBe(blob.size);
          const bytes = await readAllBytes(streamableFile.getStream());
          expect(new TextDecoder().decode(bytes)).toBe("hello blob");
        },
        "Bunest native Blob/BunFile source",
      );
    });

    describe("when input is neither Uint8Array, ReadableStream, nor Blob", () => {
      itAdapted(
        "ADR-010",
        "should reject invalid non-stream input with TypeError",
        () => {
          const invalidInput = { notPipe: true };
          expect(() => new StreamableFile(invalidInput as any)).toThrow(
            TypeError,
          );
        },
        "Fail-fast TypeError on unsupported source",
      );
    });

    describe("when options is empty", () => {
      it("should return application/octet-stream for type and undefined for others", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        const headers = streamableFile.getHeaders();
        expect(headers.type).toBe("application/octet-stream");
        expect(headers.disposition).toBeUndefined();
        expect(headers.length).toBeUndefined();
      });
    });

    describe("when options is defined", () => {
      it("should pass provided headers", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream, {
          type: "application/pdf",
          disposition: "inline",
          length: 100,
        });
        expect(streamableFile.getHeaders()).toEqual({
          type: "application/pdf",
          disposition: "inline",
          length: 100,
        });
      });
    });

    describe("otherwise", () => {
      describe("when input is a Buffer instance", () => {
        it("should create a readable stream and push the input buffer", async () => {
          const buffer = Buffer.from("test");
          const streamableFile = new StreamableFile(buffer);
          const stream = streamableFile.getStream();
          const bytes = await readAllBytes(stream);
          expect(Buffer.from(bytes)).toEqual(buffer);
        });
      });

      describe("when input is a Uint8Array", () => {
        it("should create a readable stream and push the input buffer", async () => {
          const buffer = Uint8Array.from([0xab, 0xcd, 0xef, 0x00]);
          const streamableFile = new StreamableFile(buffer);
          const stream = streamableFile.getStream();
          const bytes = await readAllBytes(stream);
          expect(bytes).toEqual(buffer);
        });
      });
    });

    describe("errorHandler", () => {
      it("should return the default error handler", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        expect(typeof streamableFile.errorHandler).toBe("function");
      });

      describe("default error handler behavior", () => {
        it("should do nothing when response is destroyed", () => {
          const stream = new ReadableStream<Uint8Array>();
          const streamableFile = new StreamableFile(stream);
          const res = {
            destroyed: true,
            headersSent: false,
            statusCode: 200,
            end: createSpy(),
            send: createSpy(),
          };

          streamableFile.errorHandler(new Error("test error"), res);

          expect(res.end).not.toHaveBeenCalled();
          expect(res.send).not.toHaveBeenCalled();
        });

        it("should log the error and destroy the response when headers are already sent", () => {
          const stream = new ReadableStream<Uint8Array>();
          const errorLogger = createSpy();
          const streamableFile = new StreamableFile(stream).setErrorLogger(
            errorLogger,
          );
          const res = {
            destroyed: false,
            headersSent: true,
            statusCode: 200,
            end: createSpy(),
            send: createSpy(),
            destroy: createSpy(),
          };
          const error = new Error("EIO: i/o error, read");

          streamableFile.errorHandler(error, res);

          expect(errorLogger).toHaveBeenCalledWith(error);
          expect(res.destroy.callCount).toBe(1);
          expect(res.end).not.toHaveBeenCalled();
          expect(res.send).not.toHaveBeenCalled();
        });

        it("should not destroy the response when the stream fails after it ended", async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data"));
              controller.close();
            },
          });
          const errorLogger = createSpy();
          const streamableFile = new StreamableFile(stream).setErrorLogger(
            errorLogger,
          );
          await readAllBytes(stream);
          const res = {
            destroyed: false,
            headersSent: true,
            statusCode: 200,
            end: createSpy(),
            send: createSpy(),
            destroy: createSpy(),
          };
          const error = new Error("EIO: i/o error, close");

          streamableFile.errorHandler(error, res);

          expect(errorLogger).toHaveBeenCalledWith(error);
          expect(res.destroy).not.toHaveBeenCalled();
          expect(res.end.callCount).toBe(1);
        });

        it("should call res.end() when headers are already sent and the response has no destroy()", () => {
          const stream = new ReadableStream<Uint8Array>();
          const streamableFile = new StreamableFile(stream).setErrorLogger(
            createSpy(),
          );
          const res = {
            destroyed: false,
            headersSent: true,
            statusCode: 200,
            end: createSpy(),
            send: createSpy(),
          };

          streamableFile.errorHandler(new Error("test error"), res);

          expect(res.end.callCount).toBe(1);
          expect(res.send).not.toHaveBeenCalled();
        });

        it("should set status code to BAD_REQUEST and log the error instead of sending its message", () => {
          const stream = new ReadableStream<Uint8Array>();
          const errorLogger = createSpy();
          const streamableFile = new StreamableFile(stream).setErrorLogger(
            errorLogger,
          );
          const res = {
            destroyed: false,
            headersSent: false,
            statusCode: 200,
            end: createSpy(),
            send: createSpy(),
          };
          const error = new Error(
            "ENOENT: no such file or directory, open '/srv/reports/q3.csv'",
          );

          streamableFile.errorHandler(error, res);

          expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
          expect(res.send).toHaveBeenCalledWith("Bad Request");
          expect(errorLogger).toHaveBeenCalledWith(error);
        });
      });
    });

    describe("setErrorHandler", () => {
      it("should set a custom error handler", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        const customHandler = createSpy();

        streamableFile.setErrorHandler(customHandler);

        expect(streamableFile.errorHandler).toBe(customHandler);
      });

      it("should return the instance for chaining", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        const customHandler = createSpy();

        const result = streamableFile.setErrorHandler(customHandler);

        expect(result).toBe(streamableFile);
      });
    });

    describe("errorLogger", () => {
      it("should return the default error logger", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        expect(typeof streamableFile.errorLogger).toBe("function");
      });

      describe("default error logger behavior", () => {
        it("should call logger.error with the error", () => {
          const stream = new ReadableStream<Uint8Array>();
          const streamableFile = new StreamableFile(stream);
          const internalLogger = (
            streamableFile as unknown as {
              logger?: { error: (...args: unknown[]) => void };
            }
          ).logger;
          expect(internalLogger).toBeDefined();
          const loggerErrorSpy = createSpy();
          if (internalLogger) {
            internalLogger.error = loggerErrorSpy;
          }
          const error = new Error("test error");

          streamableFile.errorLogger(error);

          expect(loggerErrorSpy).toHaveBeenCalledWith(error);
        });
      });
    });

    describe("setErrorLogger", () => {
      it("should set a custom error logger", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        const customLogger = createSpy();

        streamableFile.setErrorLogger(customLogger);

        expect(streamableFile.errorLogger).toBe(customLogger);
      });

      it("should return the instance for chaining", () => {
        const stream = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(stream);
        const customLogger = createSpy();

        const result = streamableFile.setErrorLogger(customLogger);

        expect(result).toBe(streamableFile);
      });
    });

    describe("auto-length from Uint8Array", () => {
      it("should auto-populate length from Buffer when not provided", () => {
        const buffer = Buffer.from("hello world");
        const streamableFile = new StreamableFile(buffer);

        expect(streamableFile.getHeaders().length).toBe(buffer.length);
      });

      it("should auto-populate length from Uint8Array when not provided", () => {
        const uint8 = new Uint8Array([1, 2, 3, 4, 5]);
        const streamableFile = new StreamableFile(uint8);

        expect(streamableFile.getHeaders().length).toBe(5);
      });

      it("should not override explicitly provided length", () => {
        const buffer = Buffer.from("hello");
        const streamableFile = new StreamableFile(buffer, { length: 999 });

        expect(streamableFile.getHeaders().length).toBe(999);
      });

      it("should auto-populate length per instance when options object is reused", () => {
        const options = { type: "application/pdf" };
        const first = new StreamableFile(Buffer.alloc(10), options);
        const second = new StreamableFile(Buffer.alloc(20), options);

        expect(first.getHeaders().length).toBe(10);
        expect(second.getHeaders().length).toBe(20);
        expect(options).toEqual({ type: "application/pdf" });
      });
    });

    describe("getStream", () => {
      it("should return a ReadableStream from Uint8Array input", () => {
        const streamableFile = new StreamableFile(new Uint8Array([1, 2, 3]));
        const stream = streamableFile.getStream();
        expect(stream).toBeInstanceOf(ReadableStream);
      });

      it("should return the original ReadableStream when constructed from a stream", () => {
        const readable = new ReadableStream<Uint8Array>();
        const streamableFile = new StreamableFile(readable);
        expect(streamableFile.getStream()).toBe(readable);
      });
    });
  },
);
