// WAV encoding (PCM 16/24-bit, 32-bit float) with TPDF dither for integer formats.

import { mulberry32 } from './analysis.js';

export function encodeWav(channels, sampleRate, bitDepth = 16) {
  const numCh = channels.length;
  const frames = numCh ? channels[0].length : 0;
  const isFloat = bitDepth === 32;
  const bytes = bitDepth / 8;
  const dataSize = frames * numCh * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, isFloat ? 3 : 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytes, true);
  v.setUint16(32, numCh * bytes, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  const rnd = mulberry32(7);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i];
      if (isFloat) { v.setFloat32(o, s, true); o += 4; continue; }
      const max = bitDepth === 16 ? 32767 : 8388607;
      s = s * max + (rnd() - rnd()); // TPDF dither, ±1 LSB
      s = Math.max(-max - 1, Math.min(max, Math.round(s)));
      if (bitDepth === 16) { v.setInt16(o, s, true); o += 2; }
      else { v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff); o += 3; }
    }
  }
  return buf;
}
