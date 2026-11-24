import { afterEach, describe, expect, it } from "bun:test";
import {
  AssertionError,
  ContextStorage,
  DIAGNOSTICS_CHANNELS_SYMBOL,
  DiagnosticChannel,
  Injectable,
  Module,
  basename,
  channel,
  diagnosticsChannel,
  dirname,
  ensureDir,
  existsSyncPath,
  extname,
  getArch,
  getCpuCount,
  getHostname,
  getPlatform,
  hasSubscribers,
  isAbsolute,
  isIp,
  isIpv4,
  isIpv6,
  join,
  lstatPath,
  mkdirSyncPath,
  normalize,
  openFileHandle,
  posixPath,
  publish,
  randomInt,
  randomIntRange,
  readDirEntries,
  readDirNames,
  readDirSyncEntries,
  readDirSyncNames,
  readTextSync,
  realpathOf,
  realpathSyncOf,
  relative,
  removeEmptyDir,
  removePath,
  renamePath,
  repl,
  resolve,
  sep,
  statFs,
  statPath,
  statSyncPath,
  strictAssert,
  subscribe,
  timingSafeEqualBytes,
  timingSafeEqualStr,
  unsubscribe,
  watchPath,
  win32Path,
  writeExclusiveFile,
  writeTextSync,
  type HttpIncomingHeaders,
  type HttpIncomingMessageLike,
  type HttpServerResponseLike,
} from "../../src/index";

describe("Bun-Native Core Runtime Primitives", () => {
  describe("path.util (POSIX + Win32)", () => {
    it("matches POSIX path semantics across all helpers", () => {
      expect(posixPath.sep).toBe("/");
      expect(posixPath.isAbsolute("/usr/local")).toBe(true);
      expect(posixPath.isAbsolute("usr/local")).toBe(false);
      expect(posixPath.isAbsolute("")).toBe(false);

      expect(posixPath.normalize("")).toBe(".");
      expect(posixPath.normalize("//a//b/..//c/")).toBe("/a/c/");
      expect(posixPath.normalize("/../a/./b")).toBe("/a/b");
      expect(posixPath.normalize("a/b/../../..")).toBe("..");

      expect(posixPath.join()).toBe(".");
      expect(posixPath.join("/a", "b", "..", "c/d")).toBe("/a/c/d");
      expect(posixPath.join("foo", "", "bar")).toBe("foo/bar");

      expect(posixPath.resolve("/a/b", "../c", "d")).toBe("/a/c/d");
      expect(posixPath.resolve("/a", "/b", "c")).toBe("/b/c");
      expect(posixPath.relative("/a/b/c", "/a/d/e")).toBe("../../d/e");
      expect(posixPath.relative("/a/b", "/a/b")).toBe("");

      expect(posixPath.dirname("/a/b/c.txt")).toBe("/a/b");
      expect(posixPath.dirname("/a/b/")).toBe("/a");
      expect(posixPath.dirname("/a")).toBe("/");
      expect(posixPath.dirname("///")).toBe("/");
      expect(posixPath.dirname("file.txt")).toBe(".");

      expect(posixPath.basename("/a/b/file.ts")).toBe("file.ts");
      expect(posixPath.basename("/a/b/file.ts", ".ts")).toBe("file");
      expect(posixPath.basename("/a/b/dir/")).toBe("dir");
      expect(posixPath.basename(".txt", ".txt")).toBe("");

      expect(posixPath.extname("index.spec.ts")).toBe(".ts");
      expect(posixPath.extname(".bashrc")).toBe("");
      expect(posixPath.extname("a.")).toBe(".");
      expect(posixPath.extname("a/b.txt/")).toBe(".txt");
      expect(posixPath.extname("..")).toBe("");
    });

    it("matches Win32 path semantics for drives, UNC roots, and mixed slashes", () => {
      expect(win32Path.sep).toBe("\\");
      expect(win32Path.isAbsolute("C:\\Users\\demo")).toBe(true);
      expect(win32Path.isAbsolute("C:/Users/demo")).toBe(true);
      expect(win32Path.isAbsolute("\\\\server\\share\\file")).toBe(true);
      expect(win32Path.isAbsolute("C:relative\\path")).toBe(false);
      expect(win32Path.isAbsolute("relative/path")).toBe(false);

      expect(win32Path.normalize("C:/a//b/../c\\d")).toBe("C:\\a\\c\\d");
      expect(win32Path.join("C:\\app", "src", "..", "dist\\index.js")).toBe(
        "C:\\app\\dist\\index.js",
      );
      expect(win32Path.resolve("C:\\app\\src", "..\\dist")).toBe(
        "C:\\app\\dist",
      );
      expect(win32Path.relative("C:\\app\\src", "C:\\app\\dist\\a.js")).toBe(
        "..\\dist\\a.js",
      );
      expect(win32Path.relative("C:\\app", "D:\\other")).toBe("D:\\other");
      expect(win32Path.dirname("C:\\a\\b\\c.txt")).toBe("C:\\a\\b");
      expect(win32Path.basename("C:\\a\\b\\file.json", ".json")).toBe("file");
      expect(win32Path.extname("C:\\a\\b\\file.json")).toBe(".json");
    });

    it("exports platform-bound top-level path helpers", () => {
      expect(sep === "/" || sep === "\\").toBe(true);
      expect(basename(join("foo", "bar.ts"), ".ts")).toBe("bar");
      expect(extname("hello.tar.gz")).toBe(".gz");
      expect(dirname(normalize("a/b/c"))).toBe(join("a", "b"));
      expect(isAbsolute(resolve("."))).toBe(true);
      expect(relative(resolve("."), resolve(".", "sub"))).toBe("sub");
    });
  });

  describe("assert.util (strictAssert)", () => {
    it("supports equal, notEqual, deepEqual, notDeepEqual, ok, match, fail, throws, doesNotThrow, rejects", async () => {
      strictAssert(true);
      strictAssert.ok(1);
      strictAssert.equal(Number.NaN, Number.NaN);
      strictAssert.strictEqual("a", "a");
      strictAssert.notEqual(1, "1");
      strictAssert.notEqual(+0, -0);
      strictAssert.deepEqual({ a: [1, 2], b: new Map([["k", 3]]) }, { a: [1, 2], b: new Map([["k", 3]]) });
      strictAssert.deepStrictEqual([1, 2], [1, 2]);
      strictAssert.notDeepEqual({ a: 1 }, { a: "1" });
      strictAssert.match("hello bunest", /bunest$/);
      strictAssert.doesNotMatch("hello bunest", /express/);

      expect(() => strictAssert.equal(1, 2)).toThrow(AssertionError);
      expect(() => strictAssert.notEqual("x", "x")).toThrow(AssertionError);
      expect(() => strictAssert.deepEqual({ a: 1 }, { a: 2 })).toThrow(
        AssertionError,
      );
      expect(() => strictAssert.notDeepEqual({ a: 1 }, { a: 1 })).toThrow(
        AssertionError,
      );
      expect(() => strictAssert.ok(false, "custom ok msg")).toThrow(
        "custom ok msg",
      );
      expect(() => strictAssert.match("abc", /xyz/)).toThrow(AssertionError);
      expect(() => strictAssert.fail("boom")).toThrow("boom");

      strictAssert.throws(() => {
        throw new RangeError("out of bounds");
      }, RangeError);
      strictAssert.throws(() => {
        throw new TypeError("bad input");
      }, /bad input/);
      strictAssert.throws(
        () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
        { code: "EACCES", message: /denied/ },
      );
      strictAssert.throws(
        () => {
          throw new Error("pred");
        },
        (err) => err instanceof Error && err.message === "pred",
      );
      expect(() => strictAssert.throws(() => "no throw")).toThrow(
        AssertionError,
      );
      strictAssert.doesNotThrow(() => 42);
      expect(() =>
        strictAssert.doesNotThrow(() => {
          throw new Error("unexpected");
        }),
      ).toThrow(AssertionError);

      await strictAssert.rejects(async () => {
        throw new RangeError("async boom");
      }, RangeError);
      await strictAssert.rejects(
        Promise.reject(new Error("rejected-value")),
        /rejected-value/,
      );
      await strictAssert.doesNotReject(Promise.resolve("ok"));
      let failedRejects = false;
      try {
        await strictAssert.rejects(Promise.resolve("did-not-reject"));
      } catch (err) {
        failedRejects = err instanceof AssertionError;
      }
      expect(failedRejects).toBe(true);
    });
  });

  describe("net.util (isIp, isIpv4, isIpv6)", () => {
    it("validates IPv4 and IPv6 addresses per RFC 3986/4291", () => {
      // Valid IPv4
      for (const addr of [
        "0.0.0.0",
        "127.0.0.1",
        "192.168.1.255",
        "255.255.255.255",
      ]) {
        expect(isIpv4(addr)).toBe(true);
        expect(isIpv6(addr)).toBe(false);
        expect(isIp(addr)).toBe(4);
      }

      // Invalid IPv4
      for (const addr of [
        "",
        "01.2.3.4",
        "256.0.0.1",
        "1.2.3",
        "1.2.3.4.5",
        "1.2.3.-1",
        "1.2.3.a",
        " 127.0.0.1",
      ]) {
        expect(isIpv4(addr)).toBe(false);
        expect(isIp(addr)).toBe(0);
      }

      // Valid IPv6
      for (const addr of [
        "::",
        "::1",
        "fe80::1",
        "fe80::1%eth0",
        "2001:db8:85a3::8a2e:370:7334",
        "2001:0db8:0000:0000:0000:ff00:0042:8329",
        "::ffff:192.0.2.128",
        "2001:db8::192.0.2.1",
      ]) {
        expect(isIpv6(addr)).toBe(true);
        expect(isIpv4(addr)).toBe(false);
        expect(isIp(addr)).toBe(6);
      }

      // Invalid IPv6
      for (const addr of [
        "",
        ":",
        ":::",
        "2001:db8:::1",
        "2001::db8::1",
        "2001:db8:85a3:0:0:8a2e:370:7334:extra",
        "2001:db8:85a3:0:0:8a2e:370",
        "gggg::1",
        "fe80::1%",
        "::ffff:999.0.2.128",
      ]) {
        expect(isIpv6(addr)).toBe(false);
        expect(isIp(addr)).toBe(0);
      }
    });
  });

  describe("runtime-info.util & crypto.util extensions", () => {
    it("exposes hostname, CPU count, platform, and arch", () => {
      expect(getHostname().length).toBeGreaterThan(0);
      expect(getHostname()).toBe(getHostname());
      expect(getCpuCount()).toBeGreaterThanOrEqual(1);
      expect(getPlatform()).toBe(process.platform);
      expect(getArch()).toBe(process.arch);
    });

    it("performs constant-time byte/string comparison and unbiased randomInt/randomIntRange", () => {
      const enc = new TextEncoder();
      expect(timingSafeEqualBytes(enc.encode("secret"), enc.encode("secret"))).toBe(
        true,
      );
      expect(timingSafeEqualBytes(enc.encode("secret"), enc.encode("secreT"))).toBe(
        false,
      );
      expect(timingSafeEqualBytes(enc.encode("short"), enc.encode("longer"))).toBe(
        false,
      );
      expect(timingSafeEqualStr("token-123", "token-123")).toBe(true);
      expect(timingSafeEqualStr("token-123", "token-124")).toBe(false);
      expect(timingSafeEqualStr("short", "very-long")).toBe(false);

      for (let i = 0; i < 200; i++) {
        const v1 = randomInt(10);
        expect(Number.isInteger(v1)).toBe(true);
        expect(v1).toBeGreaterThanOrEqual(0);
        expect(v1).toBeLessThan(10);

        const v2 = randomIntRange(-5, 5);
        expect(Number.isInteger(v2)).toBe(true);
        expect(v2).toBeGreaterThanOrEqual(-5);
        expect(v2).toBeLessThan(5);
      }
      expect(randomInt(7, 8)).toBe(7);
      expect(() => randomInt(0)).toThrow(RangeError);
      expect(() => randomIntRange(10, 5)).toThrow(RangeError);
    });
  });

  describe("diagnostics-channel (Bunest Native Channel Bus)", () => {
    it("publishes, subscribes, unsubscribes, and shares channels on globalThis symbol", () => {
      const chName = `bunest:test:channel:${crypto.randomUUID()}`;
      const ch = diagnosticsChannel(chName);
      expect(ch).toBeInstanceOf(DiagnosticChannel);
      expect(channel(chName)).toBe(ch);
      expect(
        (
          (globalThis as Record<PropertyKey, unknown>)[
            DIAGNOSTICS_CHANNELS_SYMBOL
          ] as Map<string | symbol, DiagnosticChannel>
        ).get(chName),
      ).toBe(ch);

      expect(ch.hasSubscribers).toBe(false);
      expect(hasSubscribers(chName)).toBe(false);

      const received: Array<{ msg: unknown; name: string | symbol }> = [];
      const handler = (msg: unknown, name: string | symbol) => {
        received.push({ msg, name });
      };
      subscribe(chName, handler);
      expect(ch.hasSubscribers).toBe(true);
      expect(hasSubscribers(chName)).toBe(true);

      publish(chName, { event: "ping" });
      ch.publish({ event: "pong" });
      expect(received).toEqual([
        { msg: { event: "ping" }, name: chName },
        { msg: { event: "pong" }, name: chName },
      ]);

      expect(unsubscribe(chName, handler)).toBe(true);
      expect(unsubscribe(chName, handler)).toBe(false);
      expect(hasSubscribers(chName)).toBe(false);
      publish(chName, { event: "ignored" });
      expect(received).toHaveLength(2);
    });
  });

  describe("Quarantined ContextStorage & fs-runtime adapters + http-compat types", () => {
    const tmpDirs: string[] = [];

    afterEach(async () => {
      while (tmpDirs.length > 0) {
        const dir = tmpDirs.pop()!;
        await removePath(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("isolates concurrent async operations in ContextStorage<T>", async () => {
      const storage = new ContextStorage<{ id: string }>();
      expect(storage.getStore()).toBeUndefined();

      const results = await Promise.all([
        storage.run({ id: "req-a" }, async () => {
          await Bun.sleep(10);
          return storage.getStore()?.id;
        }),
        storage.run({ id: "req-b" }, async () => {
          await Bun.sleep(5);
          return storage.getStore()?.id;
        }),
      ]);

      expect(results).toEqual(["req-a", "req-b"]);
      expect(storage.getStore()).toBeUndefined();

      storage.run({ id: "outer" }, () => {
        expect(storage.getStore()?.id).toBe("outer");
        storage.exit(() => {
          expect(storage.getStore()).toBeUndefined();
        });
        expect(storage.getStore()?.id).toBe("outer");
      });
    });

    it("supports all quarantined POSIX FS operations and structural types", async () => {
      const base = join(
        "/tmp",
        `bunest-fs-runtime-${crypto.randomUUID()}`,
      );
      tmpDirs.push(base);

      await ensureDir(join(base, "sub"));
      expect(existsSyncPath(join(base, "sub"))).toBe(true);
      mkdirSyncPath(join(base, "sync-dir"));
      expect(statSyncPath(join(base, "sync-dir")).isDirectory()).toBe(true);

      const fileA = join(base, "a.txt");
      await writeExclusiveFile(fileA, "hello-exclusive");
      // Second exclusive write must fail with EEXIST
      let failedExist = false;
      try {
        await writeExclusiveFile(fileA, "overwrite");
      } catch {
        failedExist = true;
      }
      expect(failedExist).toBe(true);

      expect(readTextSync(fileA)).toBe("hello-exclusive");
      writeTextSync(join(base, "b.txt"), "sync-write");
      expect(readTextSync(join(base, "b.txt"))).toBe("sync-write");

      const fh = await openFileHandle(join(base, "handle.txt"), "wx");
      try {
        await fh.write("from-handle");
      } finally {
        await fh.close();
      }
      expect(readTextSync(join(base, "handle.txt"))).toBe("from-handle");

      const renamed = join(base, "b-renamed.txt");
      await renamePath(join(base, "b.txt"), renamed);
      expect(existsSyncPath(renamed)).toBe(true);

      const st = await statPath(renamed);
      const lst = await lstatPath(renamed);
      expect(st.isFile()).toBe(true);
      expect(lst.isFile()).toBe(true);
      expect(await realpathOf(base)).toBe(realpathSyncOf(base));

      const names = await readDirNames(base);
      expect(names).toContain("a.txt");
      expect(names).toContain("b-renamed.txt");
      const entries = await readDirEntries(base);
      expect(entries.some((e) => e.name === "sub" && e.isDirectory())).toBe(
        true,
      );
      expect(readDirSyncNames(base)).toContain("a.txt");
      expect(
        readDirSyncEntries(base).some((e) => e.name === "sub" && e.isDirectory()),
      ).toBe(true);

      const disk = await statFs(base);
      expect(disk.bsize).toBeGreaterThan(0);

      const watcher = watchPath(base, { persistent: false }, () => {});
      watcher.close();

      await removeEmptyDir(join(base, "sync-dir"));
      expect(existsSyncPath(join(base, "sync-dir"))).toBe(false);

      // Structural http-compat types compile-time verification
      const headers: HttpIncomingHeaders = { authorization: "Bearer x" };
      const reqLike: HttpIncomingMessageLike = { method: "GET", url: "/", headers };
      const resLike: HttpServerResponseLike = {
        setHeader: () => {},
        writeHead: () => {},
        write: () => true,
        end: () => {},
        destroy: () => {},
        on: () => {},
        once: () => {},
        off: () => {},
      };
      expect(reqLike.headers.authorization).toBe("Bearer x");
      expect(typeof resLike.writeHead).toBe("function");
    });

    it("runs Bun-native interactive REPL cleanly with custom async input and output", async () => {
      @Injectable()
      class MathService {
        double(n: number) {
          return n * 2;
        }
      }

      @Module({ providers: [MathService] })
      class ReplTestModule {}

      const outputChunks: string[] = [];
      let exited = false;
      let releaseInput!: () => void;
      const inputGate = new Promise<void>((r) => {
        releaseInput = r;
      });

      async function* scriptedInput() {
        await inputGate;
        yield "1 + 2\n";
        yield ".exit\n";
      }

      const server = await repl(ReplTestModule, {
        prompt: "bunest> ",
        useColors: false,
        input: scriptedInput(),
        output: {
          write(chunk: string) {
            outputChunks.push(chunk);
          },
        },
      });

      server.on("exit", () => {
        exited = true;
      });

      // Evaluate expressions directly against DI context via evalLine
      const svc = server.context.get as (token: unknown) => MathService;
      expect(svc(MathService).double(21)).toBe(42);
      expect(await server.evalLine("20 + 22")).toBe(42);
      expect(server.context._).toBe(42);

      // Now release scripted input (`1 + 2` then `.exit`)
      releaseInput();
      await Bun.sleep(20);
      expect(server.context._).toBe(3);
      expect(server.closed).toBe(true);
      expect(exited).toBe(true);
      expect(outputChunks.join("")).toContain("42");
      expect(outputChunks.join("")).toContain("3");
    });
  });
});
