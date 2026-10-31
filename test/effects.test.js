import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectRange, isFullRange, migrateParams, defaultParams, EFFECTS } from '../src/renderer/js/audio/effects.js';
import { VERSION } from '../src/renderer/js/version.js';

test('app version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(VERSION, pkg.version);
});

test('effect ranges are clamped, and end = null means the end of the track', () => {
  assert.deepEqual(effectRange({ start: 0, end: null }, 10), [0, 10]);
  assert.deepEqual(effectRange({ start: 2, end: 5 }, 10), [2, 5]);
  assert.deepEqual(effectRange({ start: -3, end: 50 }, 10), [0, 10]);
  assert.deepEqual(effectRange({ start: 8, end: 4 }, 10), [8, 8]);
  assert.ok(isFullRange({ start: 0, end: null }, 10));
  assert.ok(!isFullRange({ start: 1, end: null }, 10));
});

test('every effect gets a default range covering the whole track', () => {
  for (const type of Object.keys(EFFECTS)) {
    const p = defaultParams(type);
    assert.equal(p.start, 0, type);
    assert.equal(p.end, null, type);
  }
});

test('old fade-length projects migrate to time ranges', () => {
  assert.deepEqual(effectRange(migrateParams('fadeIn', { length: 3, shape: 'linear' }, 20), 20), [0, 3]);
  assert.deepEqual(effectRange(migrateParams('fadeOut', { length: 4 }, 20), 20), [16, 20]);
  assert.equal(migrateParams('fadeOut', { length: 4 }, 20).length, undefined);
  assert.equal(migrateParams('reverb', { mix: 0.5 }, 20).mix, 0.5);
});
