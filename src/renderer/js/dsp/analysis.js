// Analysis + sample-domain processors (no Web Audio dependency, unit-testable in Node).

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

export const PEAK_BLOCK = 256;
const peakCache = new WeakMap();

/** Min/max pairs per PEAK_BLOCK samples, cached per Float32Array identity. */
export function peaks(channel) {
  let p = peakCache.get(channel);
  if (p) return p;
  const blocks = Math.ceil(channel.length / PEAK_BLOCK);
  p = new Float32Array(blocks * 2);
  for (let b = 0; b < blocks; b++) {
    let mn = 1, mx = -1;
    const end = Math.min(channel.length, (b + 1) * PEAK_BLOCK);
    for (let i = b * PEAK_BLOCK; i < end; i++) {
      const v = channel[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    p[b * 2] = mn;
    p[b * 2 + 1] = mx;
  }
  peakCache.set(channel, p);
  return p;
}

export function peakLevel(ch, s = 0, e = Infinity) {
  let m = 0;
  for (const c of ch) {
    const end = Math.min(e, c.length);
    for (let i = Math.max(0, s); i < end; i++) {
      const a = Math.abs(c[i]);
      if (a > m) m = a;
    }
  }
  return m;
}

export function rms(ch) {
  let sum = 0, n = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) { sum += c[i] * c[i]; n++; }
  return n ? Math.sqrt(sum / n) : 0;
}

export function normalize(ch, targetDb = -1) {
  const pk = peakLevel(ch);
  if (pk === 0) return ch.map((c) => c.slice());
  const g = dbToGain(targetDb) / pk;
  return ch.map((c) => c.map((v) => v * g));
}

/**
 * Noise gate driven by a peak envelope follower across all channels.
 * thresholdDb: gate opens above this; floorDb: attenuation when closed.
 */
export function noiseGate(ch, sr, { thresholdDb = -45, attackMs = 2, holdMs = 60, releaseMs = 120, floorDb = -80 } = {}) {
  const n = ch.length ? ch[0].length : 0;
  const thr = dbToGain(thresholdDb);
  const floor = dbToGain(floorDb);
  const atk = 1 - Math.exp(-1 / Math.max(1, (attackMs / 1000) * sr));
  const rel = 1 - Math.exp(-1 / Math.max(1, (releaseMs / 1000) * sr));
  const holdN = Math.round((holdMs / 1000) * sr);
  // Look-ahead so the gate is already open when a transient arrives.
  const look = Math.round((attackMs / 1000) * sr);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const c of ch) { const a = Math.abs(c[i]); if (a > m) m = a; }
    env[i] = m;
  }
  const out = ch.map(() => new Float32Array(n));
  let g = floor, hold = 0;
  for (let i = 0; i < n; i++) {
    const probe = env[Math.min(n - 1, i + look)];
    if (probe >= thr) hold = holdN + 1;
    const target = hold > 0 ? 1 : floor;
    if (hold > 0) hold--;
    g += (target - g) * (target > g ? atk : rel);
    for (let c = 0; c < ch.length; c++) out[c][i] = ch[c][i] * g;
  }
  return out;
}

/** Returns [start, end) frames of the non-silent region, or null if everything is silent. */
export function detectSilenceBounds(ch, sr, thresholdDb = -50, padMs = 40) {
  const n = ch.length ? ch[0].length : 0;
  const thr = dbToGain(thresholdDb);
  const loud = (i) => ch.some((c) => Math.abs(c[i]) >= thr);
  let s = 0;
  while (s < n && !loud(s)) s++;
  if (s >= n) return null;
  let e = n - 1;
  while (e > s && !loud(e)) e--;
  const pad = Math.round((padMs / 1000) * sr);
  return [Math.max(0, s - pad), Math.min(n, e + 1 + pad)];
}

/** Simple deterministic PRNG so offline and realtime renders match exactly. */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponentially decaying stereo noise impulse response for the reverb. */
export function makeImpulse(sr, seconds, decay, channels = 2) {
  const n = Math.max(1, Math.round(sr * seconds));
  const rnd = mulberry32(1337);
  const out = [];
  for (let c = 0; c < channels; c++) {
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / n, decay);
    out.push(d);
  }
  return out;
}
