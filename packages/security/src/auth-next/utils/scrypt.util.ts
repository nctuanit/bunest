/**
 * Pure-TS RFC 7914 scrypt implementation backed by `Bun.CryptoHasher("sha256", key)`
 * for PBKDF2-HMAC-SHA256 (c = 1). Zero `node:crypto` dependencies.
 */

export interface ScryptOptions {
  N: number;
  r: number;
  p: number;
}

function pbkdf2HmacSha256Single(
  password: Uint8Array,
  salt: Uint8Array,
  dkLen: number,
): Uint8Array {
  const out = new Uint8Array(dkLen);
  const blockCount = Math.ceil(dkLen / 32);
  const input = new Uint8Array(salt.byteLength + 4);
  input.set(salt, 0);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let i = 1; i <= blockCount; i++) {
    view.setUint32(salt.byteLength, i, false);
    const mac = new Bun.CryptoHasher("sha256", password)
      .update(input)
      .digest();
    const offset = (i - 1) * 32;
    const len = Math.min(32, dkLen - offset);
    out.set(mac.subarray(0, len), offset);
  }
  return out;
}

function salsa20_8(B: Uint32Array): void {
  let x0 = B[0]!,
    x1 = B[1]!,
    x2 = B[2]!,
    x3 = B[3]!,
    x4 = B[4]!,
    x5 = B[5]!,
    x6 = B[6]!,
    x7 = B[7]!,
    x8 = B[8]!,
    x9 = B[9]!,
    x10 = B[10]!,
    x11 = B[11]!,
    x12 = B[12]!,
    x13 = B[13]!,
    x14 = B[14]!,
    x15 = B[15]!;
  let t: number;

  for (let i = 0; i < 8; i += 2) {
    t = (x0 + x12) | 0;
    x4 ^= (t << 7) | (t >>> 25);
    t = (x4 + x0) | 0;
    x8 ^= (t << 9) | (t >>> 23);
    t = (x8 + x4) | 0;
    x12 ^= (t << 13) | (t >>> 19);
    t = (x12 + x8) | 0;
    x0 ^= (t << 18) | (t >>> 14);

    t = (x5 + x1) | 0;
    x9 ^= (t << 7) | (t >>> 25);
    t = (x9 + x5) | 0;
    x13 ^= (t << 9) | (t >>> 23);
    t = (x13 + x9) | 0;
    x1 ^= (t << 13) | (t >>> 19);
    t = (x1 + x13) | 0;
    x5 ^= (t << 18) | (t >>> 14);

    t = (x10 + x6) | 0;
    x14 ^= (t << 7) | (t >>> 25);
    t = (x14 + x10) | 0;
    x2 ^= (t << 9) | (t >>> 23);
    t = (x2 + x14) | 0;
    x6 ^= (t << 13) | (t >>> 19);
    t = (x6 + x2) | 0;
    x10 ^= (t << 18) | (t >>> 14);

    t = (x15 + x11) | 0;
    x3 ^= (t << 7) | (t >>> 25);
    t = (x3 + x15) | 0;
    x7 ^= (t << 9) | (t >>> 23);
    t = (x7 + x3) | 0;
    x11 ^= (t << 13) | (t >>> 19);
    t = (x11 + x7) | 0;
    x15 ^= (t << 18) | (t >>> 14);

    t = (x0 + x3) | 0;
    x1 ^= (t << 7) | (t >>> 25);
    t = (x1 + x0) | 0;
    x2 ^= (t << 9) | (t >>> 23);
    t = (x2 + x1) | 0;
    x3 ^= (t << 13) | (t >>> 19);
    t = (x3 + x2) | 0;
    x0 ^= (t << 18) | (t >>> 14);

    t = (x5 + x4) | 0;
    x6 ^= (t << 7) | (t >>> 25);
    t = (x6 + x5) | 0;
    x7 ^= (t << 9) | (t >>> 23);
    t = (x7 + x6) | 0;
    x4 ^= (t << 13) | (t >>> 19);
    t = (x4 + x7) | 0;
    x5 ^= (t << 18) | (t >>> 14);

    t = (x10 + x9) | 0;
    x11 ^= (t << 7) | (t >>> 25);
    t = (x11 + x10) | 0;
    x8 ^= (t << 9) | (t >>> 23);
    t = (x8 + x11) | 0;
    x9 ^= (t << 13) | (t >>> 19);
    t = (x9 + x8) | 0;
    x10 ^= (t << 18) | (t >>> 14);

    t = (x15 + x14) | 0;
    x12 ^= (t << 7) | (t >>> 25);
    t = (x12 + x15) | 0;
    x13 ^= (t << 9) | (t >>> 23);
    t = (x13 + x12) | 0;
    x14 ^= (t << 13) | (t >>> 19);
    t = (x14 + x13) | 0;
    x15 ^= (t << 18) | (t >>> 14);
  }

  B[0] = (B[0]! + x0) >>> 0;
  B[1] = (B[1]! + x1) >>> 0;
  B[2] = (B[2]! + x2) >>> 0;
  B[3] = (B[3]! + x3) >>> 0;
  B[4] = (B[4]! + x4) >>> 0;
  B[5] = (B[5]! + x5) >>> 0;
  B[6] = (B[6]! + x6) >>> 0;
  B[7] = (B[7]! + x7) >>> 0;
  B[8] = (B[8]! + x8) >>> 0;
  B[9] = (B[9]! + x9) >>> 0;
  B[10] = (B[10]! + x10) >>> 0;
  B[11] = (B[11]! + x11) >>> 0;
  B[12] = (B[12]! + x12) >>> 0;
  B[13] = (B[13]! + x13) >>> 0;
  B[14] = (B[14]! + x14) >>> 0;
  B[15] = (B[15]! + x15) >>> 0;
}

function blockMix(
  src: Uint32Array,
  srcOff: number,
  dst: Uint32Array,
  dstOff: number,
  X: Uint32Array,
  r: number,
): void {
  const r2 = r * 2;
  const lastOff = srcOff + (r2 - 1) * 16;
  for (let j = 0; j < 16; j++) {
    X[j] = src[lastOff + j]!;
  }
  for (let i = 0; i < r2; i++) {
    const bOff = srcOff + i * 16;
    for (let j = 0; j < 16; j++) {
      X[j] = X[j]! ^ src[bOff + j]!;
    }
    salsa20_8(X);
    const outOff = dstOff + ((i & 1) === 0 ? i >> 1 : r + (i >> 1)) * 16;
    for (let j = 0; j < 16; j++) {
      dst[outOff + j] = X[j]!;
    }
  }
}

/**
 * Derives `keyLength` bytes with RFC 7914 scrypt (`N`, `r`, `p`).
 */
export async function scryptAsync(
  password: Uint8Array | string,
  salt: Uint8Array | string,
  keyLength: number,
  { N, r, p }: ScryptOptions,
): Promise<Buffer> {
  if (
    !Number.isInteger(N) ||
    N <= 1 ||
    (N & (N - 1)) !== 0 ||
    !Number.isInteger(r) ||
    r < 1 ||
    !Number.isInteger(p) ||
    p < 1 ||
    !Number.isInteger(keyLength) ||
    keyLength < 0
  ) {
    throw new RangeError("scrypt: invalid parameters");
  }
  const pwBytes =
    typeof password === "string" ? Buffer.from(password, "utf8") : password;
  const saltBytes =
    typeof salt === "string" ? Buffer.from(salt, "utf8") : salt;

  const blockBytes = 128 * r;
  const blockWords = 32 * r;
  const B = pbkdf2HmacSha256Single(pwBytes, saltBytes, p * blockBytes);
  const bView = new DataView(B.buffer, B.byteOffset, B.byteLength);
  const V = new Uint32Array(N * blockWords);
  const XY = new Uint32Array(blockWords * 2);
  const X = new Uint32Array(16);
  const mask = N - 1;
  const jIndex = (2 * r - 1) * 16;

  for (let i = 0; i < p; i++) {
    const bByteOff = i * blockBytes;
    for (let w = 0; w < blockWords; w++) {
      XY[w] = bView.getUint32(bByteOff + w * 4, true);
    }

    let cur = 0;
    let next = blockWords;
    for (let k = 0; k < N; k++) {
      const vOff = k * blockWords;
      for (let w = 0; w < blockWords; w++) {
        V[vOff + w] = XY[cur + w]!;
      }
      blockMix(XY, cur, XY, next, X, r);
      const tmp = cur;
      cur = next;
      next = tmp;
    }

    for (let k = 0; k < N; k++) {
      const j = XY[cur + jIndex]! & mask;
      const vOff = j * blockWords;
      for (let w = 0; w < blockWords; w++) {
        XY[cur + w] = XY[cur + w]! ^ V[vOff + w]!;
      }
      blockMix(XY, cur, XY, next, X, r);
      const tmp = cur;
      cur = next;
      next = tmp;
    }

    for (let w = 0; w < blockWords; w++) {
      bView.setUint32(bByteOff + w * 4, XY[cur + w]!, true);
    }
  }

  return Buffer.from(pbkdf2HmacSha256Single(pwBytes, B, keyLength));
}
