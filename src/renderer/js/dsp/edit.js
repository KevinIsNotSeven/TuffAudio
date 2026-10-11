// Pure, allocation-friendly editing primitives.
// Audio is represented as an array of Float32Array channels of equal length.
// Every function returns NEW arrays and never mutates its inputs, which makes
// undo snapshots free (they just keep references to the old arrays).

export const length = (ch) => (ch.length ? ch[0].length : 0);

const clampRange = (ch, s, e) => {
  const n = length(ch);
  s = Math.max(0, Math.min(n, Math.round(s)));
  e = Math.max(s, Math.min(n, Math.round(e)));
  return [s, e];
};

export function slice(ch, s, e) {
  [s, e] = clampRange(ch, s, e);
  return ch.map((c) => c.slice(s, e));
}

export function remove(ch, s, e) {
  [s, e] = clampRange(ch, s, e);
  return ch.map((c) => {
    const out = new Float32Array(c.length - (e - s));
    out.set(c.subarray(0, s), 0);
    out.set(c.subarray(e), s);
    return out;
  });
}

export function insert(ch, at, clip) {
  const n = length(ch);
  at = Math.max(0, Math.min(n, Math.round(at)));
  const fitted = matchChannels(clip, ch.length);
  const add = length(fitted);
  return ch.map((c, i) => {
    const out = new Float32Array(c.length + add);
    out.set(c.subarray(0, at), 0);
    out.set(fitted[i], at);
    out.set(c.subarray(at), at + add);
    return out;
  });
}

/** Replace [s,e) with `clip` (used by paste-over-selection). */
export function replace(ch, s, e, clip) {
  [s, e] = clampRange(ch, s, e);
  return insert(remove(ch, s, e), s, clip);
}

export function silence(ch, s, e) {
  [s, e] = clampRange(ch, s, e);
  return ch.map((c) => {
    const out = c.slice();
    out.fill(0, s, e);
    return out;
  });
}

export function padStart(ch, frames) {
  frames = Math.max(0, Math.round(frames));
  if (!frames) return ch;
  return ch.map((c) => {
    const out = new Float32Array(c.length + frames);
    out.set(c, frames);
    return out;
  });
}

/** Ensures all channels have `frames` length by zero-padding the end. */
export function padEnd(ch, frames) {
  return ch.map((c) => {
    if (c.length >= frames) return c;
    const out = new Float32Array(frames);
    out.set(c);
    return out;
  });
}

const curve = (x, shape) => (shape === 'linear' ? x : Math.sin((x * Math.PI) / 2) ** 2);

export function fade(ch, s, e, dir = 'in', shape = 'smooth') {
  [s, e] = clampRange(ch, s, e);
  const len = e - s;
  return ch.map((c) => {
    const out = c.slice();
    for (let i = 0; i < len; i++) {
      const x = len <= 1 ? 1 : i / (len - 1);
      out[s + i] *= curve(dir === 'in' ? x : 1 - x, shape);
    }
    return out;
  });
}

export function gain(ch, g, s = 0, e = length(ch)) {
  [s, e] = clampRange(ch, s, e);
  return ch.map((c) => {
    const out = c.slice();
    for (let i = s; i < e; i++) out[i] *= g;
    return out;
  });
}

export function reverse(ch, s = 0, e = length(ch)) {
  [s, e] = clampRange(ch, s, e);
  return ch.map((c) => {
    const out = c.slice();
    out.subarray(s, e).reverse();
    return out;
  });
}

// ---- Channel layout -------------------------------------------------------

/** mode: 'mix' (L+R)/2, 'left', 'right' */
export function toMono(ch, mode = 'mix') {
  if (ch.length === 1) return ch;
  if (mode === 'left') return [ch[0].slice()];
  if (mode === 'right') return [ch[1].slice()];
  const n = length(ch);
  const out = new Float32Array(n);
  for (const c of ch) for (let i = 0; i < n; i++) out[i] += c[i];
  const k = 1 / ch.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return [out];
}

export function toStereo(ch) {
  if (ch.length >= 2) return ch.slice(0, 2);
  return [ch[0].slice(), ch[0].slice()];
}

export function swapChannels(ch) {
  return ch.length < 2 ? ch : [ch[1], ch[0], ...ch.slice(2)];
}

export function matchChannels(ch, count) {
  if (ch.length === count) return ch;
  if (count === 1) return toMono(ch);
  if (ch.length === 1) return Array.from({ length: count }, () => ch[0].slice());
  return ch.slice(0, count);
}

/** Splice `src[s,e)` into `dst` with short crossfades at the borders (used for "apply to selection"). */
export function spliceProcessed(dst, src, s, e, xfade = 64) {
  [s, e] = clampRange(dst, s, e);
  const fitted = matchChannels(src, dst.length);
  return dst.map((c, ci) => {
    const out = c.slice();
    const p = fitted[ci];
    for (let i = s; i < e; i++) {
      let w = 1;
      if (i - s < xfade) w = (i - s) / xfade;
      if (e - 1 - i < xfade) w = Math.min(w, (e - 1 - i) / xfade);
      out[i] = c[i] * (1 - w) + (p[i] ?? 0) * w;
    }
    return out;
  });
}
