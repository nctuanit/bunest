import { AssertionError, matchesShape } from "@bunest/core/common";

/**
 * Returns `true` when `actual` recursively matches all fields specified in
 * `expectedSubset` using Bun's native `Bun.deepMatch(expectedSubset, actual)`.
 */
export function matchShape(actual: unknown, expectedSubset: unknown): boolean {
  return matchesShape(actual, expectedSubset);
}

/**
 * Asserts that `actual` structurally matches `expectedSubset` using Bun's
 * native `Bun.deepMatch(expectedSubset, actual)`, throwing an `AssertionError`
 * with diagnostic details on mismatch.
 */
export function assertDeepMatch(
  actual: unknown,
  expectedSubset: unknown,
  message?: string,
): void {
  if (!matchesShape(actual, expectedSubset)) {
    throw new AssertionError({
      message:
        message ??
        `Expected value to deep-match subset ${Bun.inspect(expectedSubset)}, received ${Bun.inspect(actual)}`,
      actual,
      expected: expectedSubset,
      operator: "deepMatch",
    });
  }
}

export interface WebViewHarnessOptions {
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly headless?: boolean;
  /** Optional `Bun.WebView`-compatible constructor override (useful for unit tests/mocks). */
  readonly webViewConstructor?:
    | (new (opts?: Record<string, unknown>) => WebViewLike)
    | null;
}

export interface WebViewLike {
  navigate?(url: string): Promise<void> | void;
  evaluate?(script: string): Promise<unknown> | unknown;
  close(): void;
}

export interface WebViewHarness {
  readonly view: WebViewLike;
  navigate(url: string): Promise<void>;
  evaluate<T = unknown>(script: string): Promise<T>;
  close(): void;
  [Symbol.dispose](): void;
}

/**
 * Checks whether Bun's native headless browser `Bun.WebView` is available in
 * the current runtime.
 */
export function isWebViewAvailable(): boolean {
  return (
    typeof Bun !== "undefined" &&
    typeof (Bun as unknown as { WebView?: unknown }).WebView === "function"
  );
}

/**
 * Creates a lightweight E2E browser testing harness over Bun's native
 * `Bun.WebView` (zero Playwright/Puppeteer dependency). Useful for smoke-testing
 * Swagger UI, GraphiQL, Queue Dashboard, DevTools viewer, or full-stack routes.
 */
export function createWebViewHarness(
  options: WebViewHarnessOptions = {},
): WebViewHarness {
  const WebViewCtor =
    options.webViewConstructor !== undefined
      ? options.webViewConstructor
      : (
          Bun as unknown as {
            WebView?: new (opts?: Record<string, unknown>) => WebViewLike;
          }
        ).WebView;
  if (typeof WebViewCtor !== "function") {
    throw new Error(
      "Bun.WebView is unavailable in the current runtime (requires Bun >= 1.4.5 with WebView backend).",
    );
  }
  const view = new WebViewCtor({
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.headless !== undefined ? { headless: options.headless } : {}),
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    view.close();
  };

  return {
    view,
    async navigate(url: string): Promise<void> {
      if (typeof view.navigate !== "function") {
        throw new Error("Bun.WebView instance does not expose navigate().");
      }
      await view.navigate(url);
    },
    async evaluate<T = unknown>(script: string): Promise<T> {
      if (typeof view.evaluate !== "function") {
        throw new Error("Bun.WebView instance does not expose evaluate().");
      }
      return (await view.evaluate(script)) as T;
    },
    close,
    [Symbol.dispose](): void {
      close();
    },
  };
}
