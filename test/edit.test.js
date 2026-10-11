import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/renderer/js/dsp/edit.js';

const ramp = (n, off = 0) => Float32Array.from({ length: n }, (_, i) => i + off);
const mono = (n) => [ramp(n)];
const stereo = (n) => [ramp(n), ramp(n, 100)];

test('slice keeps the selected range', () => {
  assert.deepEqual([...E.slice(mono(10), 2, 5)[0]], [2, 3, 4]);
});

test('remove deletes the range and never mutates input', () => {
  const src = mono(6);
  const out = E.remove(src, 1, 3);
  assert.deepEqual([...out[0]], [0, 3, 4, 5]);
  assert.equal(src[0].length, 6);
});

test('insert and replace', () => {
  const out = E.insert(mono(4), 2, [Float32Array.of(9, 9)]);
  assert.deepEqual([...out[0]], [0, 1, 9, 9, 2, 3]);
  const rep = E.replace(mono(5), 1, 4, [Float32Array.of(7)]);
  assert.deepEqual([...rep[0]], [0, 7, 4]);
});

test('insert adapts channel count of the clip', () => {
  const out = E.insert(stereo(2), 1, [Float32Array.of(5)]);
  assert.deepEqual([...out[0]], [0, 5, 1]);
  assert.deepEqual([...out[1]], [100, 5, 101]);
});

test('ranges are clamped', () => {
  assert.equal(E.remove(mono(5), -10, 100)[0].length, 0);
  assert.equal(E.slice(mono(5), 3, 1)[0].length, 0);
});

test('silence zeroes only the range', () => {
  assert.deepEqual([...E.silence(mono(5), 1, 3)[0]], [0, 0, 0, 3, 4]);
});

test('fade in starts at zero and ends at full level', () => {
  const ones = [new Float32Array(100).fill(1)];
  const out = E.fade(ones, 0, 100, 'in')[0];
  assert.equal(out[0], 0);
  assert.equal(out[99], 1);
  assert.ok(out[50] > 0.3 && out[50] < 0.7);
  const fo = E.fade(ones, 0, 100, 'out')[0];
  assert.equal(fo[0], 1);
  assert.equal(fo[99], 0);
});

test('mono / stereo conversion', () => {
  const s = [Float32Array.of(1, 0), Float32Array.of(0, 1)];
  assert.deepEqual([...E.toMono(s)[0]], [0.5, 0.5]);
  assert.deepEqual([...E.toMono(s, 'left')[0]], [1, 0]);
  assert.deepEqual([...E.toMono(s, 'right')[0]], [0, 1]);
  const st = E.toStereo([Float32Array.of(3, 4)]);
  assert.equal(st.length, 2);
  assert.deepEqual([...st[1]], [3, 4]);
  assert.notEqual(st[0], st[1]);
  assert.deepEqual(E.swapChannels(s).map((c) => [...c]), [[0, 1], [1, 0]]);
});

test('padStart / padEnd', () => {
  assert.deepEqual([...E.padStart(mono(2), 2)[0]], [0, 0, 0, 1]);
  assert.deepEqual([...E.padEnd(mono(2), 4)[0]], [0, 1, 0, 0]);
});

test('spliceProcessed only touches the range', () => {
  const dst = [new Float32Array(1000)];
  const src = [new Float32Array(1000).fill(1)];
  const out = E.spliceProcessed(dst, src, 200, 800, 10)[0];
  assert.equal(out[100], 0);
  assert.equal(out[500], 1);
  assert.equal(out[900], 0);
  assert.ok(out[202] > 0 && out[202] < 1);
});
