// AES-256-ECB 解密（纯 JS，不依赖 node:crypto 或 WebCrypto 的 ECB 支持）。
// WebCrypto 只提供 CBC/CTR/GCM，而 CBC 会校验 PKCS#7 填充，正文密文必然报错，
// 所以这里直接实现 AES-256 解密本体。

// ---- GF(2^8) ----
const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const gmul = (a, b) => {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    a = xt(a);
    b >>= 1;
  }
  return p & 0xff;
};

// ---- S 盒（由乘法逆元 + 仿射变换生成，避免手抄错表）----
const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(function buildSBox() {
  const inv = new Uint8Array(256);
  for (let a = 1; a < 256; a++) {
    // a^254 = a^-1 in GF(2^8)
    let r = 1, base = a, e = 254;
    while (e) {
      if (e & 1) r = gmul(r, base);
      base = gmul(base, base);
      e >>= 1;
    }
    inv[a] = r;
  }
  for (let a = 0; a < 256; a++) {
    const x = inv[a];
    SBOX[a] = (x ^ rotl8(x, 1) ^ rotl8(x, 2) ^ rotl8(x, 3) ^ rotl8(x, 4) ^ 0x63) & 0xff;
  }
  for (let a = 0; a < 256; a++) INV_SBOX[SBOX[a]] = a;
})();

function expandKey(key) {
  const Nk = 8, Nr = 14;
  const w = new Uint32Array(4 * (Nr + 1));
  for (let i = 0; i < Nk; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  let rcon = 1;
  for (let i = Nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % Nk === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0; // RotWord
      // SubWord
      t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
      t = (t ^ (rcon << 24)) >>> 0;
      rcon = xt(rcon);
    } else if (i % Nk === 4) {
      t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
    }
    w[i] = (w[i - Nk] ^ t) >>> 0;
  }
  return w;
}

function addRoundKey(s, w, round) {
  for (let c = 0; c < 4; c++) {
    const k = w[round * 4 + c];
    s[4 * c] ^= (k >>> 24) & 0xff;
    s[4 * c + 1] ^= (k >>> 16) & 0xff;
    s[4 * c + 2] ^= (k >>> 8) & 0xff;
    s[4 * c + 3] ^= k & 0xff;
  }
}

function invShiftRows(s) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      s[r + 4 * ((c + r) % 4)] = t[r + 4 * c];
    }
  }
}

function invSubBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
}

function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = 4 * c;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 0x0e) ^ gmul(a1, 0x0b) ^ gmul(a2, 0x0d) ^ gmul(a3, 0x09);
    s[i + 1] = gmul(a0, 0x09) ^ gmul(a1, 0x0e) ^ gmul(a2, 0x0b) ^ gmul(a3, 0x0d);
    s[i + 2] = gmul(a0, 0x0d) ^ gmul(a1, 0x09) ^ gmul(a2, 0x0e) ^ gmul(a3, 0x0b);
    s[i + 3] = gmul(a0, 0x0b) ^ gmul(a1, 0x0d) ^ gmul(a2, 0x09) ^ gmul(a3, 0x0e);
  }
}

function decryptBlock(block, w) {
  const s = Uint8Array.from(block);
  addRoundKey(s, w, 14);
  for (let round = 13; round >= 1; round--) {
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, w, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  invSubBytes(s);
  addRoundKey(s, w, 0);
  return s;
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/[\s\r\n]+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 解密 base64 密文，返回 UTF-8 字符串（去掉尾部 NUL 与 PKCS#7 残留） */
export function aesEcbDecrypt(b64, keyStr = "FF32AE65FBFD19414EAAFF6291A54B42") {
  const key = new TextEncoder().encode(keyStr);
  if (key.length !== 32) throw new Error("AES-256 需要 32 字节密钥");
  const w = expandKey(key);
  const ct = b64ToBytes(b64);
  const chunks = [];
  for (let off = 0; off + 16 <= ct.length; off += 16) {
    chunks.push(decryptBlock(ct.subarray(off, off + 16), w));
  }
  let out = new Uint8Array(chunks.length * 16);
  chunks.forEach((c, i) => out.set(c, i * 16));

  // 去掉 PKCS#7 填充（合法时）以及尾部 NUL
  const pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16 && out.length >= pad) {
    let good = true;
    for (let i = out.length - pad; i < out.length; i++) if (out[i] !== pad) { good = false; break; }
    if (good) out = out.subarray(0, out.length - pad);
  }
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  return new TextDecoder("utf-8", { fatal: false }).decode(out.subarray(0, end));
}
