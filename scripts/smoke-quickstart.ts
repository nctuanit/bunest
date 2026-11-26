/**
 * CI smoke test for the public quickstart flow (`examples/hello-world`).
 *
 * Verifies:
 * 1. `bun run --cwd examples/hello-world start` boots on an ephemeral PORT without exiting early.
 * 2. `GET /health` returns HTTP 200 with `{"status":"ok"}`.
 * 3. `GET /?name=Dev` returns HTTP 200 with `message === "Hello, Dev!"` and a non-empty `runtime` string.
 * 4. `bun run --cwd examples/hello-world test` exits with code 0.
 *
 * Zero external dependencies, no `node:*` imports.
 */

const BOOT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;

function pickFreePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== "number" || port <= 0) {
    throw new Error("Failed to allocate an ephemeral free port");
  }
  return port;
}

async function readStreamSafe(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

async function waitForServerReady(
  baseUrl: string,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `examples/hello-world exited prematurely with code ${proc.exitCode}`,
      );
    }

    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res;
    } catch (err) {
      lastError = err;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${baseUrl}/health (${String(lastError)})`,
  );
}

async function verifyLiveServer(): Promise<void> {
  const port = pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(
    ["bun", "run", "--cwd", "examples/hello-world", "start"],
    {
      env: { ...Bun.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  try {
    const healthRes = await waitForServerReady(baseUrl, proc, BOOT_TIMEOUT_MS);
    const healthText = await healthRes.text();
    if (healthRes.status !== 200) {
      throw new Error(
        `GET /health expected HTTP 200, got ${healthRes.status}: ${healthText}`,
      );
    }

    let healthBody: unknown;
    try {
      healthBody = JSON.parse(healthText);
    } catch {
      throw new Error(`GET /health returned invalid JSON: ${healthText}`);
    }

    if (
      typeof healthBody !== "object" ||
      healthBody === null ||
      (healthBody as Record<string, unknown>).status !== "ok" ||
      Object.keys(healthBody as Record<string, unknown>).length !== 1
    ) {
      throw new Error(
        `GET /health expected {"status":"ok"}, got ${healthText}`,
      );
    }
    console.log(`[smoke] PASS GET /health -> 200 ${healthText}`);

    const greetRes = await fetch(`${baseUrl}/?name=Dev`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const greetText = await greetRes.text();
    if (greetRes.status !== 200) {
      throw new Error(
        `GET /?name=Dev expected HTTP 200, got ${greetRes.status}: ${greetText}`,
      );
    }

    let greetBody: unknown;
    try {
      greetBody = JSON.parse(greetText);
    } catch {
      throw new Error(`GET /?name=Dev returned invalid JSON: ${greetText}`);
    }

    const greetObj =
      typeof greetBody === "object" && greetBody !== null
        ? (greetBody as Record<string, unknown>)
        : null;

    if (
      !greetObj ||
      greetObj.message !== "Hello, Dev!" ||
      typeof greetObj.runtime !== "string" ||
      greetObj.runtime.trim().length === 0
    ) {
      throw new Error(
        `GET /?name=Dev expected { message: "Hello, Dev!", runtime: "<non-empty>" }, got ${greetText}`,
      );
    }
    console.log(`[smoke] PASS GET /?name=Dev -> 200 ${greetText}`);
  } catch (err) {
    try {
      proc.kill();
    } catch {
      // ignore if already exited
    }
    const [stdout, stderr] = await Promise.all([
      readStreamSafe(proc.stdout),
      readStreamSafe(proc.stderr),
    ]);
    if (stdout.trim()) {
      console.error("[smoke] server stdout:\n" + stdout.trim());
    }
    if (stderr.trim()) {
      console.error("[smoke] server stderr:\n" + stderr.trim());
    }
    throw err;
  } finally {
    try {
      proc.kill();
    } catch {
      // ignore if already exited
    }
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
  }
}

async function verifyExampleTests(): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "run", "--cwd", "examples/hello-world", "test"],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, TEST_TIMEOUT_MS);

  try {
    const exitCode = await proc.exited;
    if (timedOut) {
      throw new Error(
        `examples/hello-world test timed out after ${TEST_TIMEOUT_MS}ms`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `examples/hello-world test failed with exit code ${exitCode}`,
      );
    }
    console.log("[smoke] PASS bun run --cwd examples/hello-world test");
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] Bun ${Bun.version} — verifying quickstart flow`);
  await verifyLiveServer();
  await verifyExampleTests();
  console.log("[smoke] Quickstart smoke check passed.");
}

main().catch((err: unknown) => {
  console.error(
    `[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
