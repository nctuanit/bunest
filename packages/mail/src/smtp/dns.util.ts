export interface MxRecordInfo {
  readonly exchange: string;
  readonly priority: number;
}

interface BunDnsMxLike {
  resolveMx?(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
}

/**
 * Resolves DNS MX records for a domain (or email address) sorted by ascending
 * preference priority using Bun's native `Bun.dns.resolveMx()`.
 */
export async function resolveMxRecords(
  domainOrEmail: string,
): Promise<MxRecordInfo[]> {
  const trimmed = domainOrEmail.trim();
  const atIdx = trimmed.lastIndexOf("@");
  const domain = (atIdx !== -1 ? trimmed.slice(atIdx + 1) : trimmed).trim();
  if (!domain) {
    return [];
  }
  const dns = (Bun as unknown as { dns?: BunDnsMxLike }).dns;
  if (!dns || typeof dns.resolveMx !== "function") {
    throw new Error(
      "Bun.dns.resolveMx is unavailable in the current runtime (requires Bun >= 1.4.5).",
    );
  }
  const records = await dns.resolveMx(domain);
  return [...records]
    .map((r) => ({ exchange: r.exchange, priority: r.priority }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Returns `true` if the target domain (or email address domain) has at least
 * one non-empty DNS MX record via `Bun.dns.resolveMx()`.
 */
export async function hasValidMxRecord(
  domainOrEmail: string,
): Promise<boolean> {
  try {
    const records = await resolveMxRecords(domainOrEmail);
    return records.some((r) => r.exchange.length > 0 && r.exchange !== ".");
  } catch {
    return false;
  }
}
