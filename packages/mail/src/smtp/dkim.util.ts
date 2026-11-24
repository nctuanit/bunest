import type {
  DkimKeyObjectLike,
  DkimOptions,
  DkimPrivateKeyInput,
} from "../interfaces/smtp-transport-options.interface";

export interface DkimSigner {
  (message: Buffer, now?: number): Promise<Buffer>;
}

export interface HeaderField {
  name: string;
  /** The whole field, continuation lines included, without the final CRLF. */
  raw: string;
}

type DkimAlgorithm = "rsa-sha256" | "ed25519-sha256";

interface ParsedDkimKey {
  algorithm: DkimAlgorithm;
  getCryptoKey: () => Promise<CryptoKey>;
}

const DEFAULT_HEADERS = [
  "from",
  "reply-to",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
];

const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const SELECTOR =
  /^[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?)*$/i;

const OID_RSA = "1.2.840.113549.1.1.1";
const OID_ED25519 = "1.3.101.112";
const RSA_ALG_ID_DER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

/** Validates the options once (at startup) and returns the async signing function. */
export function createDkimSigner(
  options: DkimOptions,
  owner: string,
): DkimSigner {
  const { domainName, keySelector } = options;
  if (typeof domainName !== "string" || !DOMAIN.test(domainName)) {
    throw new TypeError(`${owner} \`dkim.domainName\` must be a domain name`);
  }
  if (typeof keySelector !== "string" || !SELECTOR.test(keySelector)) {
    throw new TypeError(
      `${owner} \`dkim.keySelector\` must be a DNS label such as "mail2026"`,
    );
  }
  const parsed = parsePrivateKey(options.privateKey, owner);
  const wanted = options.headers?.map((name) => name.toLowerCase());
  return (message: Buffer, now = Date.now()) =>
    signMessage(message, {
      algorithm: parsed.algorithm,
      getCryptoKey: parsed.getCryptoKey,
      domainName: domainName.toLowerCase(),
      keySelector,
      wanted,
      now,
    });
}

async function signMessage(
  message: Buffer,
  o: {
    algorithm: DkimAlgorithm;
    getCryptoKey: () => Promise<CryptoKey>;
    domainName: string;
    keySelector: string;
    wanted?: string[];
    now: number;
  },
): Promise<Buffer> {
  const text = message.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const head = split === -1 ? text : text.slice(0, split + 2);
  const body = split === -1 ? "" : text.slice(split + 4);
  const fields = parseHeaderFields(head);
  const present = fields.map((f) => f.name.toLowerCase());
  const custom = present.filter(
    (name) =>
      !DEFAULT_HEADERS.includes(name) &&
      !name.startsWith("content-") &&
      name !== "dkim-signature",
  );
  const candidates = o.wanted ?? [...DEFAULT_HEADERS, ...custom];
  const signed: string[] = [];
  for (const name of new Set(["from", ...candidates])) {
    const count = present.filter((p) => p === name).length;
    for (let i = 0; i < count; i++) {
      signed.push(name);
    }
  }
  signed.push("from"); // over-sign: an added From would break the signature
  const bh = Buffer.from(
    new Bun.CryptoHasher("sha256")
      .update(relaxedBody(body), "utf8")
      .digest(),
  ).toString("base64");
  const tags = [
    "v=1",
    `a=${o.algorithm}`,
    "c=relaxed/relaxed",
    `d=${o.domainName}`,
    `s=${o.keySelector}`,
    `t=${Math.floor(o.now / 1000)}`,
    `h=${signed.join(":")}`,
    `bh=${bh}`,
    "b=",
  ];
  const unsigned = `DKIM-Signature: ${tags.join("; ")}`;
  const key = await o.getCryptoKey();
  const b = await computeSignature(fields, signed, unsigned, o.algorithm, key);
  return Buffer.concat([
    Buffer.from(`${fold(unsigned, b)}\r\n`, "utf8"),
    message,
  ]);
}

/**
 * The `b=` value: the signed header fields (picked from the bottom up, RFC 6376 §5.4.2)
 * and the DKIM-Signature field itself with an empty `b=`, relaxed-canonicalized.
 * Ed25519 signs the SHA-256 digest of that data (RFC 8463 §3).
 */
export async function computeSignature(
  fields: HeaderField[],
  signed: string[],
  dkimHeader: string,
  algorithm: DkimAlgorithm,
  key: CryptoKey | DkimPrivateKeyInput,
): Promise<string> {
  const used = new Map<string, number>();
  let data = "";
  for (const name of signed) {
    const matching = fields.filter((f) => f.name.toLowerCase() === name);
    const index = matching.length - 1 - (used.get(name) ?? 0);
    used.set(name, (used.get(name) ?? 0) + 1);
    if (index >= 0) {
      data += `${relaxedHeader(matching[index]!.raw)}\r\n`; // a missing one signs as empty
    }
  }
  data += relaxedHeader(dkimHeader.replace(/(\bb=)[^;]*$/, "$1"));
  const cryptoKey = isCryptoKey(key)
    ? key
    : await parsePrivateKey(key, "DKIM").getCryptoKey();
  const payload: Uint8Array<ArrayBuffer> =
    algorithm === "ed25519-sha256"
      ? toArrayBufferUint8Array(
          new Bun.CryptoHasher("sha256").update(data, "utf8").digest(),
        )
      : toArrayBufferUint8Array(new TextEncoder().encode(data));
  const signature = await crypto.subtle.sign(
    algorithm === "ed25519-sha256" ? "Ed25519" : "RSASSA-PKCS1-v1_5",
    cryptoKey,
    payload,
  );
  return Buffer.from(signature).toString("base64");
}

export function parseHeaderFields(head: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of head.split("\r\n")) {
    if (line === "") {
      continue;
    }
    if (/^[ \t]/.test(line) && fields.length) {
      fields[fields.length - 1]!.raw += `\r\n${line}`;
    } else {
      fields.push({ name: line.slice(0, line.indexOf(":")).trim(), raw: line });
    }
  }
  return fields;
}

/** RFC 6376 §3.4.2: lowercase name, unfold, collapse whitespace, trim around the colon. */
export function relaxedHeader(raw: string): string {
  const colon = raw.indexOf(":");
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw
    .slice(colon + 1)
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}`;
}

/** RFC 6376 §3.4.4: collapse whitespace, strip it at line ends, drop trailing empty lines. */
export function relaxedBody(body: string): string {
  const lines = body
    .split("\r\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

/** Folds between tags (replacing one space, so relaxed canonicalization is unchanged) and inside `b=`. */
function fold(unsigned: string, b: string): string {
  const parts = unsigned.split("; ");
  const lines: string[] = [];
  let line = "";
  for (const [i, part] of parts.entries()) {
    const piece = i < parts.length - 1 ? `${part};` : part;
    if (line && line.length + 1 + piece.length > 76) {
      lines.push(line);
      line = ` ${piece}`;
    } else {
      line = line ? `${line} ${piece}` : piece;
    }
  }
  // `b=` is last; its value may contain folding whitespace (a verifier removes it with the value)
  const chunks = b.match(/.{1,72}/g) ?? [""];
  line += chunks[0]!;
  lines.push(line, ...chunks.slice(1).map((chunk) => ` ${chunk}`));
  return lines.join("\r\n");
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

function isKeyObjectLike(value: unknown): value is DkimKeyObjectLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "export" in value &&
    typeof (value as { export?: unknown }).export === "function"
  );
}

function toArrayBufferUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function parsePrivateKey(
  input: DkimPrivateKeyInput,
  owner: string,
): ParsedDkimKey {
  if (isCryptoKey(input)) {
    if (input.type !== "private") {
      throw new TypeError(`${owner} \`dkim.privateKey\` must be a private key`);
    }
    const algName = input.algorithm.name;
    if (algName === "RSASSA-PKCS1-v1_5") {
      const alg = input.algorithm as {
        modulusLength?: number;
        hash?: { name?: string };
      };
      if ((alg.modulusLength ?? 0) < 1024) {
        throw new TypeError(
          `${owner} \`dkim.privateKey\` is an RSA key shorter than 1024 bits; use 2048`,
        );
      }
      if (alg.hash?.name !== "SHA-256") {
        throw new TypeError(
          `${owner} \`dkim.privateKey\` RSA CryptoKey must use SHA-256`,
        );
      }
      return {
        algorithm: "rsa-sha256",
        getCryptoKey: () => Promise.resolve(input),
      };
    }
    if (algName === "Ed25519") {
      return {
        algorithm: "ed25519-sha256",
        getCryptoKey: () => Promise.resolve(input),
      };
    }
    throw new TypeError(
      `${owner} \`dkim.privateKey\` must be an RSA or Ed25519 key`,
    );
  }

  let pkcs8Der: Uint8Array<ArrayBuffer>;
  if (isKeyObjectLike(input)) {
    if (input.type !== "private") {
      throw new TypeError(`${owner} \`dkim.privateKey\` must be a private key`);
    }
    try {
      const exported = (
        input as unknown as {
          export(opts: { type: "pkcs8"; format: "der" }): Uint8Array;
        }
      ).export({ type: "pkcs8", format: "der" });
      pkcs8Der = toArrayBufferUint8Array(exported);
    } catch {
      throw new TypeError(
        `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
      );
    }
  } else if (typeof input === "string" || input instanceof Uint8Array) {
    pkcs8Der = decodePemOrDerToPkcs8(input, owner);
  } else {
    throw new TypeError(
      `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
    );
  }

  const info = inspectPkcs8(pkcs8Der, owner);
  let cached: Promise<CryptoKey> | undefined;
  return {
    algorithm: info.algorithm,
    getCryptoKey: () => {
      cached ??= crypto.subtle.importKey(
        "pkcs8",
        pkcs8Der,
        info.algorithm === "ed25519-sha256"
          ? "Ed25519"
          : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return cached;
    },
  };
}

function decodePemOrDerToPkcs8(
  input: string | Uint8Array,
  owner: string,
): Uint8Array<ArrayBuffer> {
  const text =
    typeof input === "string"
      ? input
      : Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString(
          "latin1",
        );
  const match =
    /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) {
    if (input instanceof Uint8Array && input.byteLength > 0 && input[0] === 0x30) {
      return toArrayBufferUint8Array(input);
    }
    throw new TypeError(
      `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
    );
  }
  const label = match[1]!;
  if (label.includes("PUBLIC KEY") || label.includes("CERTIFICATE")) {
    throw new TypeError(`${owner} \`dkim.privateKey\` must be a private key`);
  }
  const b64 = match[2]!.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new TypeError(
      `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
    );
  }
  const der = toArrayBufferUint8Array(Buffer.from(b64, "base64"));
  if (label === "PRIVATE KEY") {
    return der;
  }
  if (label === "RSA PRIVATE KEY") {
    // Validate PKCS#1 structure and wrap in PKCS#8 PrivateKeyInfo for WebCrypto
    readRsaModulusBits(der, owner);
    return wrapPkcs1RsaInPkcs8(der);
  }
  if (label === "EC PRIVATE KEY") {
    throw new TypeError(
      `${owner} \`dkim.privateKey\` must be an RSA or Ed25519 key`,
    );
  }
  throw new TypeError(
    `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
  );
}

interface DerTlv {
  tag: number;
  start: number;
  end: number;
  next: number;
}

function readDerTlv(der: Uint8Array, offset: number, limit: number): DerTlv {
  if (offset >= limit) {
    throw new Error("DER truncated");
  }
  const tag = der[offset++]!;
  if (offset >= limit) {
    throw new Error("DER truncated length");
  }
  const firstLen = der[offset++]!;
  let len: number;
  if ((firstLen & 0x80) === 0) {
    len = firstLen;
  } else {
    const count = firstLen & 0x7f;
    if (count === 0 || count > 4 || offset + count > limit) {
      throw new Error("DER invalid length");
    }
    len = 0;
    for (let i = 0; i < count; i++) {
      len = len * 256 + der[offset++]!;
    }
  }
  const end = offset + len;
  if (end > limit) {
    throw new Error("DER element exceeds bounds");
  }
  return { tag, start: offset, end, next: end };
}

function decodeOid(der: Uint8Array, start: number, end: number): string {
  if (start >= end) {
    throw new Error("Empty OID");
  }
  const first = der[start]!;
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  let inArc = false;
  for (let i = start + 1; i < end; i++) {
    const byte = der[i]!;
    value = value * 128 + (byte & 0x7f);
    inArc = true;
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
      inArc = false;
    }
  }
  if (inArc) {
    throw new Error("Truncated OID");
  }
  return arcs.join(".");
}

function readRsaModulusBits(pkcs1Der: Uint8Array, owner: string): number {
  try {
    const seq = readDerTlv(pkcs1Der, 0, pkcs1Der.length);
    if (seq.tag !== 0x30) {
      throw new Error("Expected SEQUENCE");
    }
    const ver = readDerTlv(pkcs1Der, seq.start, seq.end);
    if (ver.tag !== 0x02) {
      throw new Error("Expected INTEGER version");
    }
    const mod = readDerTlv(pkcs1Der, ver.next, seq.end);
    if (mod.tag !== 0x02) {
      throw new Error("Expected INTEGER modulus");
    }
    let pos = mod.start;
    while (pos < mod.end && pkcs1Der[pos] === 0x00) {
      pos++;
    }
    if (pos >= mod.end) {
      return 0;
    }
    const firstByte = pkcs1Der[pos]!;
    return (mod.end - pos - 1) * 8 + (32 - Math.clz32(firstByte));
  } catch {
    throw new TypeError(
      `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
    );
  }
}

function inspectPkcs8(
  der: Uint8Array,
  owner: string,
): { algorithm: DkimAlgorithm } {
  let oid: string;
  let innerKey: Uint8Array;
  try {
    const seq = readDerTlv(der, 0, der.length);
    if (seq.tag !== 0x30 || seq.next !== der.length) {
      throw new Error("Invalid PKCS#8 outer SEQUENCE");
    }
    const ver = readDerTlv(der, seq.start, seq.end);
    if (ver.tag !== 0x02) {
      throw new Error("Invalid PKCS#8 version");
    }
    const algSeq = readDerTlv(der, ver.next, seq.end);
    if (algSeq.tag !== 0x30) {
      throw new Error("Invalid PKCS#8 AlgorithmIdentifier");
    }
    const oidTlv = readDerTlv(der, algSeq.start, algSeq.end);
    if (oidTlv.tag !== 0x06) {
      throw new Error("Invalid PKCS#8 OID");
    }
    oid = decodeOid(der, oidTlv.start, oidTlv.end);
    const privOctet = readDerTlv(der, algSeq.next, seq.end);
    if (privOctet.tag !== 0x04) {
      throw new Error("Invalid PKCS#8 privateKey OCTET STRING");
    }
    innerKey = der.subarray(privOctet.start, privOctet.end);
  } catch {
    throw new TypeError(
      `${owner} \`dkim.privateKey\` is not a valid PEM private key`,
    );
  }
  if (oid === OID_RSA) {
    const bits = readRsaModulusBits(innerKey, owner);
    if (bits < 1024) {
      throw new TypeError(
        `${owner} \`dkim.privateKey\` is an RSA key shorter than 1024 bits; use 2048`,
      );
    }
    return { algorithm: "rsa-sha256" };
  }
  if (oid === OID_ED25519) {
    return { algorithm: "ed25519-sha256" };
  }
  throw new TypeError(
    `${owner} \`dkim.privateKey\` must be an RSA or Ed25519 key`,
  );
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) {
    return new Uint8Array([len]);
  }
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function wrapDer(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const len = encodeDerLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function wrapPkcs1RsaInPkcs8(pkcs1Der: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privOctet = wrapDer(0x04, pkcs1Der);
  const body = new Uint8Array(
    version.length + RSA_ALG_ID_DER.length + privOctet.length,
  );
  body.set(version, 0);
  body.set(RSA_ALG_ID_DER, version.length);
  body.set(privOctet, version.length + RSA_ALG_ID_DER.length);
  return wrapDer(0x30, body);
}
