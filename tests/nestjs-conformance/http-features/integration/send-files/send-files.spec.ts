import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "bun:test";
import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  StreamableFile,
} from "../../../../../packages/core/src/common";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

class NonFile {
  constructor(public readonly value: string) {}

  pipe() {
    return this.value;
  }
}

let tempDir: string;
let fixturePath: string;
const fixtureContent =
  "# Bunest Conformance Send-Files Fixture\n\nHello streaming world!\n";
const fixtureBytes = Buffer.from(fixtureContent, "utf8");

@Injectable()
class AppService {
  getReadStream(): StreamableFile {
    return new StreamableFile(Bun.file(fixturePath).stream());
  }

  getBuffer(): StreamableFile {
    return new StreamableFile(fixtureBytes);
  }

  getNonFile(): NonFile {
    return new NonFile("Hello world");
  }

  async getAsyncFile(): Promise<StreamableFile> {
    return this.getReadStream();
  }

  getFileWithHeaders(): StreamableFile {
    return new StreamableFile(Bun.file(fixturePath).stream(), {
      type: "text/markdown",
      disposition: 'attachment; filename="Readme.md"',
      length: fixtureBytes.byteLength,
    });
  }

  async getFileThatDoesNotExist(): Promise<StreamableFile> {
    const file = Bun.file(join(tempDir, "does-not-exist.txt"));
    if (!(await file.exists())) {
      throw new BadRequestException("Bad Request");
    }
    return new StreamableFile(file);
  }

  getFileThatDoesNotExistStream(): StreamableFile {
    return new StreamableFile(Bun.file(join(tempDir, "does-not-exist.txt")));
  }

  getFileThatFailsMidway(): StreamableFile {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(new TextEncoder().encode("first chunk"));
        } else {
          controller.error(new Error("EIO: i/o error, read"));
        }
      },
    });
    return new StreamableFile(stream);
  }

  getSlowStream(): StreamableFile {
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (count++ >= 50) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    return new StreamableFile(stream);
  }
}

@Controller()
class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("file/stream")
  getFile(): StreamableFile {
    return this.appService.getReadStream();
  }

  @Get("file/buffer")
  getBuffer(): StreamableFile {
    return this.appService.getBuffer();
  }

  @Get("non-file/pipe-method")
  getNonFile(): NonFile {
    return this.appService.getNonFile();
  }

  @Get("file/async/stream")
  getAsyncFile(): Promise<StreamableFile> {
    return this.appService.getAsyncFile();
  }

  @Get("file/with/headers")
  getFileWithHeaders(): StreamableFile {
    return this.appService.getFileWithHeaders();
  }

  @Get("file/not/exist")
  getNonExistentFile(): Promise<StreamableFile> {
    return this.appService.getFileThatDoesNotExist();
  }

  @Get("file/not/exist/stream")
  getNonExistentStream(): StreamableFile {
    return this.appService.getFileThatDoesNotExistStream();
  }

  @Get("file/fails/midway")
  getFileThatFailsMidway(): StreamableFile {
    return this.appService.getFileThatFailsMidway();
  }

  @Get("file/slow")
  getSlowFile(): StreamableFile {
    return this.appService.getSlowStream();
  }
}

@Module({
  controllers: [AppController],
  providers: [AppService],
})
class AppModule {}

describeConformance(
  "Send-Files / StreamableFile E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/send-files/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts NestJS StreamableFile delivery E2E suite to Bunest native Web ReadableStream / Bun.file() / Promise return values.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(() => {
      tempDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-send-files-${crypto.randomUUID()}`,
      );
      mkdirSyncPath(tempDir, { recursive: true });
      fixturePath = join(tempDir, "Readme.md");
      writeTextSync(fixturePath, fixtureBytes);
    });

    afterAll(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      const modRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should return a file from a stream", async () => {
      const res = await request(app).get("/file/stream").expect(200);
      expect(res.text).toBe(fixtureContent);
    });

    it("should return a file from a buffer", async () => {
      const res = await request(app).get("/file/buffer").expect(200);
      expect(res.text).toBe(fixtureContent);
    });

    it("should not stream a non-file", async () => {
      await request(app)
        .get("/non-file/pipe-method")
        .expect(200, { value: "Hello world" });
    });

    itAdapted(
      "ADR-008",
      "should return a file from an async Promise handler",
      async () => {
        const res = await request(app).get("/file/async/stream").expect(200);
        expect(res.text).toBe(fixtureContent);
      },
      "Promise<StreamableFile> replaces RxJS Observable<StreamableFile>",
    );

    it("should return a file with correct headers", async () => {
      const res = await request(app)
        .get("/file/with/headers")
        .expect(200)
        .expect("Content-Type", "text/markdown")
        .expect("Content-Disposition", 'attachment; filename="Readme.md"')
        .expect("Content-Length", fixtureBytes.byteLength.toString());
      expect(res.text).toBe(fixtureContent);
    });

    it("should return an error if the file does not exist (validated handler)", async () => {
      await request(app).get("/file/not/exist").expect(400);
    });

    it("should return an error status when StreamableFile wraps a non-existent BunFile", async () => {
      await app.listen(0, "127.0.0.1");
      const res = await fetch(`${app.getUrl()}file/not/exist/stream`);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("should answer a HEAD request with the headers of a file", async () => {
      const res = await request(app)
        .head("/file/with/headers")
        .expect(200)
        .expect("Content-Type", "text/markdown")
        .expect("Content-Disposition", 'attachment; filename="Readme.md"')
        .expect("Content-Length", fixtureBytes.byteLength.toString());
      expect(res.text).toBe("");
    });

    it("should answer a HEAD request with an error if the file does not exist", async () => {
      await request(app).head("/file/not/exist").expect(400);
    });

    it("should not complete the response when the stream fails after sending data", async () => {
      await app.listen(0, "127.0.0.1");
      const url = app.getUrl()!;
      let complete = false;
      try {
        const res = await fetch(new URL("/file/fails/midway", url));
        await res.text();
        complete = true;
      } catch {
        complete = false;
      }
      expect(complete).toBe(false);
    });

    it("should allow the client to cancel a slow stream and still serve subsequent requests", async () => {
      await app.listen(0, "127.0.0.1");
      const url = app.getUrl()!;
      const ac = new AbortController();
      const slowPromise = fetch(new URL("/file/slow", url), {
        signal: ac.signal,
      }).catch(() => undefined);
      setTimeout(() => ac.abort(), 30);
      await slowPromise;

      const res = await fetch(new URL("/file/stream", url));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(fixtureContent);
    });
  },
);
