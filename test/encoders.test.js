import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFlac } from '../src/renderer/js/dsp/flac.js';
import { encodeAiff, oggMux, oggCrc, opusHeaders } from '../src/renderer/js/dsp/containers.js';

const tone = (n, f = 0.03) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i * f));

test('FLAC stream header and STREAMINFO', () => {
  const buf = new Uint8Array(encodeFlac([tone(10000), tone(10000, 0.01)], 44100, 16));
  assert.equal(String.fromCharCode(...buf.subarray(0, 4)), 'fLaC');
  assert.equal(buf[4], 0x80); // last metadata block, STREAMINFO
  const v = new DataView(buf.buffer, buf.byteOffset);
  // sample rate (20 bits) | channels-1 (3) | bps-1 (5) | total samples (36)
  const sr = (v.getUint32(18) >>> 12);
  assert.equal(sr, 44100);
  assert.equal(((buf[20] >> 1) & 0x7) + 1, 2);
  assert.equal((((buf[20] & 1) << 4) | (buf[21] >> 4)) + 1, 16);
  assert.equal(v.getUint32(22), 10000);
  // first frame sync code
  assert.equal(buf[42], 0xff);
  assert.equal(buf[43] & 0xfe, 0xf8);
});

test('FLAC compresses silence to almost nothing', () => {
  const silent = encodeFlac([new Float32Array(48000)], 48000, 16);
  assert.ok(silent.byteLength < 400, `silence took ${silent.byteLength} bytes`);
  const noisy = encodeFlac([tone(48000)], 48000, 16);
  assert.ok(noisy.byteLength < 48000 * 2, 'tone compresses below raw size');
});

test('AIFF header', () => {
  const buf = encodeAiff([tone(100), tone(100)], 48000, 24);
  const v = new DataView(buf);
  const str = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(str(0), 'FORM');
  assert.equal(str(8), 'AIFF');
  assert.equal(v.getUint16(20), 2);
  assert.equal(v.getUint32(22), 100);
  assert.equal(v.getUint16(26), 24);
  assert.equal(v.getUint16(28), 16383 + 15); // 48000 ≈ 1.46 × 2^15
  assert.equal(buf.byteLength, 54 + 100 * 2 * 3);
});

test('Ogg pages are well-formed with valid CRCs', () => {
  const [head, tags] = opusHeaders(2, 44100, 312);
  const packets = [{ data: head, granule: 0, alone: true }, { data: tags, granule: 0, alone: true }];
  for (let i = 0; i < 300; i++) packets.push({ data: new Uint8Array(300 + (i % 7)).fill(i & 255), granule: 312 + (i + 1) * 960 });
  const bytes = new Uint8Array(oggMux(packets));
  let o = 0, pages = 0, lastFlags = 0, lastGranule = 0;
  while (o < bytes.length) {
    assert.equal(String.fromCharCode(...bytes.subarray(o, o + 4)), 'OggS');
    const v = new DataView(bytes.buffer, o);
    const segs = bytes[o + 26];
    let body = 0;
    for (let i = 0; i < segs; i++) body += bytes[o + 27 + i];
    const len = 27 + segs + body;
    const page = bytes.slice(o, o + len);
    const crc = v.getUint32(22, true);
    page.fill(0, 22, 26);
    assert.equal(oggCrc(page), crc);
    if (pages === 0) assert.equal(bytes[o + 5] & 0x02, 0x02);
    assert.equal(v.getUint32(18, true), pages);
    lastFlags = bytes[o + 5];
    lastGranule = v.getUint32(6, true);
    pages++;
    o += len;
  }
  assert.ok(pages > 3);
  assert.equal(lastFlags & 0x04, 0x04);
  assert.equal(lastGranule, 312 + 300 * 960);
});
