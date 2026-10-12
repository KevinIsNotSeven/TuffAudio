// Small, dependency-free FLAC encoder (lossless).
// Fixed-blocksize frames; each channel picks the best of CONSTANT, VERBATIM or
// FIXED prediction (orders 0–4) with partitioned Rice-coded residuals.

const BLOCK = 4096;

class BitWriter {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.n = 0; }
  ensure(bytes) {
    if (this.pos + bytes <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + bytes) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
  /** Write the low `bits` bits of non-negative integer `v` (bits ≤ 32). */
  write(v, bits) {
    while (bits > 0) {
      const take = Math.min(bits, 24 - this.n);
      const chunk = Math.floor(v / 2 ** (bits - take)) & ((1 << take) - 1);
      this.acc = (this.acc << take) | chunk;
      this.n += take;
      bits -= take;
      while (this.n >= 8) {
        this.ensure(1);
        this.n -= 8;
        this.buf[this.pos++] = (this.acc >> this.n) & 0xff;
      }
      this.acc &= (1 << this.n) - 1;
    }
  }
  writeSigned(v, bits) { this.write(v < 0 ? v + 2 ** bits : v, bits); }
  /** Unary: q zeros followed by a one. */
  unary(q) {
    while (q >= 16) { this.write(0, 16); q -= 16; }
    this.write(1, q + 1);
  }
  align() { if (this.n) this.write(0, 8 - this.n); }
  bytes() { return this.buf.subarray(0, this.pos); }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
const crc8 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

/** Frame numbers use FLAC's "UTF-8-like" variable-length coding. */
function writeUtf8Number(w, v) {
  if (v < 0x80) { w.write(v, 8); return; }
  let bytes = 2;
  while (v >= 2 ** (5 * bytes + 1)) bytes++;
  const lead = (0xff00 >> bytes) & 0xff;
  w.write(lead | Math.floor(v / 2 ** (6 * (bytes - 1))), 8);
  for (let i = bytes - 2; i >= 0; i--) w.write(0x80 | (Math.floor(v / 2 ** (6 * i)) & 0x3f), 8);
}

function residuals(x, order) {
  const n = x.length, r = new Int32Array(n - order);
  for (let i = order; i < n; i++) {
    let p;
    switch (order) {
      case 0: p = 0; break;
      case 1: p = x[i - 1]; break;
      case 2: p = 2 * x[i - 1] - x[i - 2]; break;
      case 3: p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break;
      default: p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
    }
    r[i - order] = x[i] - p;
  }
  return r;
}

const zigzag = (v) => (v >= 0 ? 2 * v : -2 * v - 1);

/** Best Rice parameter and its exact bit cost for residual slice [s, e). */
function bestRice(r, s, e) {
  let sum = 0;
  for (let i = s; i < e; i++) sum += zigzag(r[i]);
  const n = e - s;
  if (!n) return { k: 0, bits: 0 };
  const mean = sum / n;
  let k0 = mean > 1 ? Math.floor(Math.log2(mean)) : 0;
  let best = null;
  for (let k = Math.max(0, k0 - 1); k <= Math.min(30, k0 + 1); k++) {
    let bits = 0;
    const d = 2 ** k;
    for (let i = s; i < e; i++) bits += Math.floor(zigzag(r[i]) / d) + 1 + k;
    if (!best || bits < best.bits) best = { k, bits };
  }
  return best;
}

/** Choose partition order (0–6) minimising bits; returns {porder, params}. */
function planResidual(r, blockSize, order) {
  let best = null;
  for (let po = 0; po <= 6; po++) {
    const parts = 1 << po;
    if (blockSize % parts || (blockSize >> po) <= order) break;
    const per = blockSize >> po;
    let bits = 0;
    const params = [];
    let s = 0;
    for (let p = 0; p < parts; p++) {
      const e = s + per - (p === 0 ? order : 0);
      const { k, bits: b } = bestRice(r, s, e);
      params.push(k);
      bits += 5 + b;
      s = e;
    }
    if (!best || bits < best.bits) best = { porder: po, params, bits };
  }
  return best;
}

function writeSubframe(w, x, bps) {
  const n = x.length;
  // CONSTANT (e.g. digital silence)
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) { w.write(0, 8); w.writeSigned(x[0], bps); return; }

  let best = null;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const r = residuals(x, order);
    const plan = planResidual(r, n, order);
    if (!plan) continue;
    const bits = order * bps + 6 + plan.bits;
    if (!best || bits < best.bits) best = { order, r, plan, bits };
  }
  if (!best || best.bits >= n * bps) {
    w.write(0b00000010, 8); // VERBATIM
    for (let i = 0; i < n; i++) w.writeSigned(x[i], bps);
    return;
  }
  const { order, r, plan } = best;
  w.write((0b001000 | order) << 1, 8); // FIXED, no wasted bits
  for (let i = 0; i < order; i++) w.writeSigned(x[i], bps);
  w.write(0b01, 2); // RICE2: 5-bit parameters
  w.write(plan.porder, 4);
  const per = n >> plan.porder;
  let s = 0;
  plan.params.forEach((k, p) => {
    const e = s + per - (p === 0 ? order : 0);
    w.write(k, 5);
    for (let i = s; i < e; i++) {
      const u = zigzag(r[i]) >>> 0;
      w.unary(Math.floor(u / 2 ** k));
      if (k) w.write(u % 2 ** k, k);
    }
    s = e;
  });
}

/**
 * channels: Float32Array[] (−1…1), bitDepth: 16 or 24. Returns an ArrayBuffer.
 */
export function encodeFlac(channels, sampleRate, bitDepth = 16) {
  const nch = channels.length;
  const total = nch ? channels[0].length : 0;
  const max = 2 ** (bitDepth - 1) - 1;
  const ints = channels.map((c) => {
    const o = new Int32Array(c.length);
    for (let i = 0; i < c.length; i++) o[i] = Math.max(-max - 1, Math.min(max, Math.round(c[i] * max)));
    return o;
  });

  const w = new BitWriter(Math.max(1 << 16, total * nch * (bitDepth / 8) * 0.7));
  w.write(0x664c6143, 32); // "fLaC"
  w.write(0x80, 8); // last metadata block, type 0 (STREAMINFO)
  w.write(34, 24);
  w.write(BLOCK, 16); w.write(BLOCK, 16);
  w.write(0, 24); w.write(0, 24);
  w.write(sampleRate, 20);
  w.write(nch - 1, 3);
  w.write(bitDepth - 1, 5);
  w.write(Math.floor(total / 2 ** 32), 4); w.write(total >>> 0, 32);
  for (let i = 0; i < 4; i++) w.write(0, 32); // MD5 unknown

  for (let f = 0, s = 0; s < total; f++, s += BLOCK) {
    const n = Math.min(BLOCK, total - s);
    const start = w.pos;
    w.write(0b11111111111110, 14); // sync
    w.write(0, 1); w.write(0, 1); // reserved, fixed blocksize
    w.write(n === BLOCK ? 0b1100 : 0b0111, 4);
    w.write(0b0000, 4); // sample rate from STREAMINFO
    w.write(nch - 1, 4); // independent channels
    w.write(bitDepth === 24 ? 0b110 : 0b100, 3);
    w.write(0, 1);
    writeUtf8Number(w, f);
    if (n !== BLOCK) w.write(n - 1, 16);
    w.write(crc8(w.buf, start, w.pos), 8);
    for (const ch of ints) writeSubframe(w, ch.subarray(s, s + n), bitDepth);
    w.align();
    w.write(crc16(w.buf, start, w.pos), 16);
  }
  return w.bytes().slice().buffer;
}
