/**
 * Where `runStoreCli()` writes, and the environment it reads `DATABASE_URL` from: the process's by default;
 * a test passes its own to read the output.
 */
export interface StoreCliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
}
