// Container writers that don't need a codec library: AIFF (PCM) and Ogg (for Opus).

/** 80-bit IEEE 754 extended float, as AIFF stores its sample rate. */
function writeExtended(v, view, o) {
  let exp = 16383 + 63, mant = v;
  if (v === 0) exp = 0;
  else {
    while (mant < 2 ** 63) { mant *= 2; exp--; }
    while (mant >= 2 ** 64) { mant /= 2; exp++; }
  }
  view.setUint16(o, exp, false);
  const hi = Math.floor(mant / 2 ** 32);
  view.setUint32(o + 2, hi >>> 0, false);
  view.setUint32(o + 6, (mant - hi * 2 ** 32) >>> 0, false);
}

export function encodeAiff(channels, sampleRate, bitDepth = 16) {
  const nch = channels.length;
  const frames = nch ? channels[0].length : 0;
  const bytes = bitDepth / 8;
  const dataSize = frames * nch * bytes;
  const buf = new ArrayBuffer(54 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'FORM'); v.setUint32(4, 46 + dataSize, false); str(8, 'AIFF');
  str(12, 'COMM'); v.setUint32(16, 18, false);
  v.setUint16(20, nch, false); v.setUint32(22, frames, false); v.setUint16(26, bitDepth, false);
  writeExtended(sampleRate, v, 28);
  str(38, 'SSND'); v.setUint32(42, 8 + dataSize, false); v.setUint32(46, 0, false); v.setUint32(50, 0, false);
  const max = 2 ** (bitDepth - 1) - 1;
  let o = 54;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-max - 1, Math.min(max, Math.round(channels[c][i] * max)));
      if (bitDepth === 16) { v.setInt16(o, s, false); o += 2; }
      else { v.setUint8(o, (s >> 16) & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, s & 0xff); o += 3; }
    }
  }
  return buf;
}

// ---- Ogg ---------------------------------------------------------------------

const OGG_CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
  OGG_CRC[i] = r >>> 0;
}
export function oggCrc(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

/**
 * Packs packets into Ogg pages. packets: [{data: Uint8Array, granule: number}]
 * where granule is the absolute granule position after that packet.
 * Packets flagged `alone` (headers) get a page to themselves.
 */
export function oggMux(packets, serial = 0x7475ff01) {
  const pages = [];
  let seq = 0;
  let cur = [];
  const flush = (eos) => {
    if (!cur.length) return;
    const lacing = [];
    for (const p of cur) {
      let n = p.data.length;
      while (n >= 255) { lacing.push(255); n -= 255; }
      lacing.push(n);
    }
    const body = cur.reduce((a, p) => a + p.data.length, 0);
    const page = new Uint8Array(27 + lacing.length + body);
    const v = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
    page[4] = 0;
    page[5] = (seq === 0 ? 0x02 : 0) | (eos ? 0x04 : 0);
    const g = cur.at(-1).granule;
    v.setUint32(6, g >>> 0, true);
    v.setUint32(10, Math.floor(g / 2 ** 32), true);
    v.setUint32(14, serial, true);
    v.setUint32(18, seq++, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of cur) { page.set(p.data, o); o += p.data.length; }
    v.setUint32(22, oggCrc(page), true);
    pages.push(page);
    cur = [];
  };
  packets.forEach((p, i) => {
    const last = i === packets.length - 1;
    const segs = Math.floor(p.data.length / 255) + 1;
    const used = cur.reduce((a, q) => a + Math.floor(q.data.length / 255) + 1, 0);
    if (p.alone || used + segs > 255 || cur.reduce((a, q) => a + q.data.length, 0) > 4000) flush(false);
    cur.push(p);
    if (p.alone || last) flush(last);
  });
  const total = pages.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  return out.buffer;
}

/** OpusHead + OpusTags header packets (RFC 7845). */
export function opusHeaders(channels, inputRate, preSkip) {
  const head = new Uint8Array(19);
  const v = new DataView(head.buffer);
  head.set([...'OpusHead'].map((c) => c.charCodeAt(0)), 0);
  head[8] = 1;
  head[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  v.setInt16(16, 0, true);
  head[18] = 0; // mapping family 0 (mono/stereo)
  const vendor = new TextEncoder().encode('TuffAudio');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const tv = new DataView(tags.buffer);
  tags.set([...'OpusTags'].map((c) => c.charCodeAt(0)), 0);
  tv.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  tv.setUint32(12 + vendor.length, 0, true);
  return [head, tags];
}
