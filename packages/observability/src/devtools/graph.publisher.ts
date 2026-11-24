import type { INestApplication } from "@bunest/core";
import {
  BunestApplication,
  BunestApplicationContext,
  SerializedGraph,
} from "@bunest/core";

/**
 * Compresses UTF-8 bytes into an RFC 1950 zlib-wrapped deflate stream using
 * Bun's native `Bun.deflateSync()` and `Bun.hash.adler32()` (zero `node:zlib`).
 */
function zlibDeflate(input: string): Buffer {
  const bytes = new TextEncoder().encode(input);
  const raw = Bun.deflateSync(bytes);
  const out = Buffer.allocUnsafe(2 + raw.byteLength + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  out.writeUInt32BE(Bun.hash.adler32(bytes) >>> 0, 2 + raw.byteLength);
  return out;
}

export type PublishGraphOptions = {
  apiKey: string;
  owner: string;
  repository: string;
  branch: string;
  trigger: "push" | "pull";
  sha: string;
  target?: string;
  targetBranch?: string;
  /** Optional override for Devtools API base URL (defaults to `DEVTOOLS_API_URL` or NestJS Devtools endpoint) */
  endpoint?: string;
  /** Optional custom fetch implementation (defaults to native `globalThis.fetch`) */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export interface GraphPublisherResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly previewUrl?: string;
  readonly reportUrl?: string;
  readonly errorText?: string;
}

/**
 * Serializes and publishes a Bunest application's `SerializedGraph` snapshot
 * to a NestJS Devtools-compatible endpoint using native `fetch()` and `node:zlib`.
 */
export class GraphPublisher {
  private readonly serializedGraph: SerializedGraph;

  constructor(
    app: BunestApplication | BunestApplicationContext | INestApplication,
  ) {
    let graph: SerializedGraph | undefined;
    try {
      graph = (app as { get(token: unknown): unknown }).get(SerializedGraph) as
        SerializedGraph | undefined;
    } catch {
      graph = undefined;
    }

    if (
      !graph &&
      (app instanceof BunestApplication ||
        app instanceof BunestApplicationContext)
    ) {
      graph = app.getModuleContainer().getSerializedGraph();
    }

    if (!graph) {
      throw new Error(
        "GraphPublisher: Could not resolve SerializedGraph from application instance. Ensure snapshot mode is enabled.",
      );
    }

    this.serializedGraph = graph;
  }

  async publish(options: PublishGraphOptions): Promise<void> {
    this.assertOption(options, "owner");
    this.assertOption(options, "repository");
    this.assertOption(options, "sha");
    this.assertOption(options, "branch");

    const organizationSlug = options.owner;
    const projectSlug = options.repository;
    const baseUrl =
      options.endpoint ??
      process.env.DEVTOOLS_API_URL ??
      "https://devtools-api.nestjs.com";
    const url = `${baseUrl.replace(/\/+$/, "")}/organizations/${organizationSlug}/projects/${projectSlug}/builds`;

    const snapshot = this.serializedGraph.toString();
    const deflatedSnapshot = zlibDeflate(snapshot);
    const fetchFn = options.fetch ?? globalThis.fetch;

    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${options.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        branch: options.branch,
        trigger: options.trigger ?? "push",
        snapshot: deflatedSnapshot.toString("base64"),
        hash: options.sha,
        target: options.target || undefined,
        ...(options.targetBranch ? { targetBranch: options.targetBranch } : {}),
      }),
    });

    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        previewUrl?: string;
        reportUrl?: string;
      };
      this.printGraphPublishedLog(data);
    } else {
      if (response.status === 401) {
        this.printUnauthorizedErrorLog();
      } else if (response.status === 400) {
        this.printBadRequestErrorLog();
      } else {
        this.printUnknownErrorLog();
      }
      const errText = await response.text().catch(() => "");
      console.error("Error:", errText, response.status);
    }
  }

  private assertOption(
    options: PublishGraphOptions,
    key: keyof PublishGraphOptions,
  ): void {
    if (!options[key]) {
      throw new Error(`GraphPublisher: "${String(key)}" parameter is required`);
    }
  }

  private printGraphPublishedLog(data: {
    previewUrl?: string;
    reportUrl?: string;
  }): void {
    console.log(
      `[DEVTOOLS] Graph has been successfully published. Preview: ${data.previewUrl ?? "-"} Report: ${data.reportUrl ?? "-"}`,
    );
  }

  private printUnauthorizedErrorLog(): void {
    console.log(
      "[DEVTOOLS] Error! Graph has not been successfully published (401 Unauthorized - check your API key).",
    );
  }

  private printBadRequestErrorLog(): void {
    console.log(
      "[DEVTOOLS] Error! Graph has not been successfully published (400 Bad Request - check your payload).",
    );
  }

  private printUnknownErrorLog(): void {
    console.log(
      "[DEVTOOLS] Error! Something went wrong while publishing the graph.",
    );
  }
}
