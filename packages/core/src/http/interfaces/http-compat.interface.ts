/**
 * Structural HTTP request/response compatibility types (zero `node:http` dependency).
 */

export interface HttpIncomingHeaders {
  [header: string]: string | string[] | undefined;
}

export interface HttpServerResponseLike {
  statusCode?: number;
  readonly headersSent?: boolean;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  readonly writableFinished?: boolean;
  setHeader(
    name: string,
    value: string | number | readonly string[],
  ): unknown;
  getHeader?(name: string): string | number | string[] | undefined;
  hasHeader?(name: string): boolean;
  removeHeader?(name: string): void;
  writeHead(
    statusCode: number,
    statusMessage?:
      | string
      | Record<string, string | number | readonly string[]>,
    headers?: Record<string, string | number | readonly string[]>,
  ): unknown;
  flushHeaders?(): void;
  write(chunk: Uint8Array | string, encoding?: string): boolean;
  end(chunk?: Uint8Array | string, encoding?: string): unknown;
  destroy(error?: Error): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface HttpIncomingMessageLike {
  method?: string;
  url?: string;
  headers: HttpIncomingHeaders;
  rawHeaders?: string[];
  httpVersion?: string;
  socket?: {
    remoteAddress?: string;
    remotePort?: number;
    encrypted?: boolean;
  };
  on?(event: string, listener: (...args: any[]) => void): unknown;
  once?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>;
}
