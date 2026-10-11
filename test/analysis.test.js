import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peaks, PEAK_BLOCK, normalize, peakLevel, noiseGate, detectSilenceBounds, dbToGain, gainToDb, makeImpulse } from '../src/renderer/js/dsp/analysis.js';
import { encodeWav } from '../src/renderer/js/dsp/wav.js';
import { serializeProject, deserializeProject } from '../src/renderer/js/dsp/projectfile.js';

test('db conversions round-trip', () => {
  assert.ok(Math.abs(gainToDb(dbToGain(-6)) + 6) < 1e-9);
});

test('peaks computes min/max per block and caches', () => {
  const c = new Float32Array(PEAK_BLOCK * 2);
  c[3] = 0.5; c[PEAK_BLOCK + 7] = -0.8;
  const p = peaks(c);
  assert.deepEqual([...p].map((v) => +v.toFixed(2)), [0, 0.5, -0.8, 0]);
  assert.equal(peaks(c), p);
});

test('normalize hits the target peak', () => {
  const out = normalize([Float32Array.of(0.1, -0.25, 0.2)], -6);
  assert.ok(Math.abs(peakLevel(out) - dbToGain(-6)) < 1e-6);
});

test('noise gate silences quiet parts and keeps loud ones', () => {
  const sr = 8000;
  const c = new Float32Array(sr);
  for (let i = 0; i < sr; i++) c[i] = i > sr / 2 ? Math.sin(i / 3) * 0.8 : Math.sin(i / 3) * 0.001;
  const out = noiseGate([c], sr, { thresholdDb: -30, floorDb: -80 })[0];
  assert.ok(peakLevel([out], 0, sr / 4) < 1e-4);
  assert.ok(peakLevel([out], sr * 0.75, sr) > 0.7);
});

test('detectSilenceBounds finds the audible region', () => {
  const sr = 1000;
  const c = new Float32Array(1000);
  c.fill(0.5, 300, 600);
  const [s, e] = detectSilenceBounds([c], sr, -40, 10);
  assert.equal(s, 290);
  assert.equal(e, 610);
  assert.equal(detectSilenceBounds([new Float32Array(10)], sr), null);
});

test('impulse response is deterministic', () => {
  const a = makeImpulse(1000, 0.1, 2), b = makeImpulse(1000, 0.1, 2);
  assert.deepEqual(a, b);
});

test('WAV encoder writes valid headers', () => {
  const buf = encodeWav([Float32Array.of(0, 1, -1), Float32Array.of(0, 0.5, -0.5)], 44100, 16);
  const v = new DataView(buf);
  const str = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(str(0), 'RIFF');
  assert.equal(str(8), 'WAVE');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(40, true), 3 * 2 * 2);
  assert.equal(buf.byteLength, 44 + 12);
  assert.ok(Math.abs(v.getInt16(48, true) - 32767) <= 1);
  const f = encodeWav([Float32Array.of(0.25)], 48000, 32);
  assert.equal(new DataView(f).getUint16(20, true), 3);
  assert.equal(new DataView(f).getFloat32(44, true), 0.25);
  const p24 = encodeWav([Float32Array.of(0.5)], 48000, 24);
  assert.equal(p24.byteLength, 44 + 3);
});

test('project files round-trip audio and effect stacks', () => {
  const tracks = [
    { name: 'Voice', color: '#fff', gainDb: -3, pan: 0.2, mute: false, solo: true, channels: [Float32Array.of(0.1, 0.2, 0.3)], effects: [{ id: 'x', type: 'reverb', enabled: false, collapsed: true, params: { mix: 0.4 } }] },
    { name: 'Music', color: '#000', gainDb: 0, pan: 0, mute: true, solo: false, channels: [Float32Array.of(1, 2), Float32Array.of(3, 4)], effects: [] },
  ];
  const back = deserializeProject(serializeProject({ sampleRate: 48000, tracks }));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.tracks.length, 2);
  assert.deepEqual([...back.tracks[0].channels[0]].map((v) => +v.toFixed(3)), [0.1, 0.2, 0.3]);
  assert.deepEqual([...back.tracks[1].channels[1]], [3, 4]);
  assert.deepEqual(back.tracks[0].effects[0], { type: 'reverb', enabled: false, collapsed: true, params: { mix: 0.4 } });
  assert.equal(back.tracks[0].solo, true);
  assert.throws(() => deserializeProject(new ArrayBuffer(16)));
});
