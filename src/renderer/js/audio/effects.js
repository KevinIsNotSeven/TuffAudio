// Effect ("modifier") definitions.
//
// kind: 'node'   – realtime Web Audio graph; sliders update live while playing.
//       'buffer' – sample-domain processor run on the audio (pre-rendered, cached).
// The same definitions drive realtime playback, offline export and "Apply", so
// what you hear is exactly what gets baked.

import { dbToGain, normalize, noiseGate, makeImpulse } from '../dsp/analysis.js';
import { reverse } from '../dsp/edit.js';

const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const pct = (v) => `${Math.round(v * 100)}%`;
const db = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const sec = (v) => `${v.toFixed(2)} s`;

// Smoothly set an AudioParam (avoids zipper noise while dragging sliders).
const setP = (ctx, param, v) => {
  if (ctx instanceof OfflineAudioContext) param.value = v;
  else param.setTargetAtTime(v, ctx.currentTime, 0.015);
};

/** Wet/dry wrapper: returns {input, output, wet(in)->node to connect, setMix} */
function wetDry(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  return {
    input, output, wetIn: wet,
    setMix(m) { setP(ctx, dry.gain, Math.cos((m * Math.PI) / 2)); setP(ctx, wet.gain, Math.sin((m * Math.PI) / 2)); },
  };
}

const fadeShape = (x, shape) => {
  x = Math.max(0, Math.min(1, x));
  if (shape === 'linear') return x;
  if (shape === 'exp') return x * x * x;
  return Math.sin((x * Math.PI) / 2) ** 2; // smooth (S-curve)
};

/**
 * Schedules gain(trackTime) on an AudioParam for the playback described by `timing`
 * ({when, offset, duration}): the source plays track position `offset` at context time `when`.
 */
function scheduleEnvelope(ctx, param, fn, segStart, segEnd, timing) {
  const now = ctx.currentTime;
  const at = Math.max(now, timing.when);
  const from = timing.offset + Math.max(0, now - timing.when);
  param.cancelScheduledValues(0);
  const a = Math.max(from, segStart);
  if (segEnd - a <= 1e-4) { param.setValueAtTime(fn(Math.max(from, segEnd)), at); return; }
  if (a > from) param.setValueAtTime(fn(from), at);
  const N = 256;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) curve[i] = fn(a + ((segEnd - a) * i) / (N - 1));
  param.setValueCurveAtTime(curve, at + (a - from), segEnd - a);
}

function fadeEffect(dir) {
  return {
    name: dir === 'in' ? 'Fade In' : 'Fade Out',
    category: 'Volume',
    icon: dir === 'in' ? 'fadeIn' : 'fadeOut',
    kind: 'node',
    description: dir === 'in' ? 'Ramp the volume up from silence at the start.' : 'Ramp the volume down to silence at the end.',
    params: [
      { key: 'length', label: 'Length', min: 0.05, max: 20, step: 0.01, default: 2, format: sec },
      { key: 'shape', label: 'Curve', type: 'select', default: 'smooth', options: [['smooth', 'Smooth'], ['linear', 'Linear'], ['exp', 'Exponential']] },
    ],
    build(ctx, p, timing) {
      const g = ctx.createGain();
      const apply = (p) => {
        const dur = timing.duration;
        const len = Math.min(p.length, dur);
        if (dir === 'in') scheduleEnvelope(ctx, g.gain, (x) => (x < len ? fadeShape(x / len, p.shape) : 1), 0, len, timing);
        else scheduleEnvelope(ctx, g.gain, (x) => (x <= dur - len ? 1 : fadeShape((dur - x) / len, p.shape)), dur - len, dur, timing);
      };
      apply(p);
      return { input: g, output: g, update: apply, timed: true };
    },
  };
}

function shaperCurve(drive) {
  const n = 4096, curve = new Float32Array(n), k = drive;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

export const EFFECTS = {
  // ---- Volume ---------------------------------------------------------------
  gain: {
    name: 'Gain', category: 'Volume', icon: 'gain', kind: 'node',
    description: 'Make it louder or quieter.',
    params: [{ key: 'db', label: 'Gain', min: -36, max: 24, step: 0.1, default: 0, format: db }],
    build(ctx, p) {
      const g = ctx.createGain();
      const u = (p) => setP(ctx, g.gain, dbToGain(p.db));
      g.gain.value = dbToGain(p.db);
      return { input: g, output: g, update: u };
    },
  },
  fadeIn: fadeEffect('in'),
  fadeOut: fadeEffect('out'),
  normalize: {
    name: 'Normalize', category: 'Volume', icon: 'normalize', kind: 'buffer',
    description: 'Scale so the loudest peak hits a target level.',
    params: [{ key: 'target', label: 'Peak target', min: -24, max: 0, step: 0.1, default: -1, format: db }],
    process: (ch, p) => normalize(ch, p.target),
  },

  // ---- Dynamics -------------------------------------------------------------
  compressor: {
    name: 'Compressor', category: 'Dynamics', icon: 'compress', kind: 'node',
    description: 'Even out loud and quiet parts.',
    params: [
      { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.5, default: -20, format: db },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, default: 4, format: (v) => `${v.toFixed(1)} : 1` },
      { key: 'attack', label: 'Attack', min: 0, max: 200, step: 1, default: 10, format: ms },
      { key: 'release', label: 'Release', min: 10, max: 1000, step: 1, default: 200, format: ms },
      { key: 'knee', label: 'Knee', min: 0, max: 30, step: 1, default: 6, format: (v) => `${v} dB` },
      { key: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.1, default: 3, format: db },
    ],
    build(ctx, p) {
      const c = ctx.createDynamicsCompressor();
      const g = ctx.createGain();
      c.connect(g);
      const u = (p) => {
        setP(ctx, c.threshold, p.threshold); setP(ctx, c.ratio, p.ratio);
        setP(ctx, c.attack, p.attack / 1000); setP(ctx, c.release, p.release / 1000);
        setP(ctx, c.knee, p.knee); setP(ctx, g.gain, dbToGain(p.makeup));
      };
      c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.attack.value = p.attack / 1000;
      c.release.value = p.release / 1000; c.knee.value = p.knee; g.gain.value = dbToGain(p.makeup);
      return { input: c, output: g, update: u };
    },
  },
  limiter: {
    name: 'Limiter', category: 'Dynamics', icon: 'limit', kind: 'node',
    description: 'Push loudness up while keeping peaks under a ceiling.',
    params: [
      { key: 'drive', label: 'Input boost', min: 0, max: 24, step: 0.1, default: 3, format: db },
      { key: 'ceiling', label: 'Ceiling', min: -12, max: 0, step: 0.1, default: -1, format: db },
      { key: 'release', label: 'Release', min: 10, max: 500, step: 1, default: 60, format: ms },
    ],
    build(ctx, p) {
      const pre = ctx.createGain();
      const c = ctx.createDynamicsCompressor();
      const post = ctx.createGain();
      pre.connect(c).connect(post);
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
      const u = (p, init) => {
        const set = init ? (prm, v) => (prm.value = v) : (prm, v) => setP(ctx, prm, v);
        set(pre.gain, dbToGain(p.drive));
        // The compressor overshoots slightly on fast transients; aim a little below the ceiling.
        set(c.threshold, p.ceiling - 1);
        set(c.release, p.release / 1000);
      };
      u(p, true);
      return { input: pre, output: post, update: (p) => u(p, false) };
    },
  },
  gate: {
    name: 'Noise Gate', category: 'Dynamics', icon: 'gate', kind: 'buffer',
    description: 'Silence background hiss and room noise between phrases.',
    params: [
      { key: 'thresholdDb', label: 'Threshold', min: -90, max: -10, step: 0.5, default: -45, format: db },
      { key: 'floorDb', label: 'Reduction', min: -90, max: 0, step: 1, default: -60, format: db },
      { key: 'attackMs', label: 'Attack', min: 0.1, max: 50, step: 0.1, default: 2, format: (v) => `${v.toFixed(1)} ms` },
      { key: 'holdMs', label: 'Hold', min: 0, max: 500, step: 1, default: 80, format: ms },
      { key: 'releaseMs', label: 'Release', min: 5, max: 1000, step: 1, default: 150, format: ms },
    ],
    process: (ch, p, sr) => noiseGate(ch, sr, p),
  },

  // ---- Tone -----------------------------------------------------------------
  eq: {
    name: 'Equalizer', category: 'Tone', icon: 'eq', kind: 'node',
    description: 'Three-band EQ: shape lows, mids and highs.',
    params: [
      { key: 'low', label: 'Low (100 Hz)', min: -18, max: 18, step: 0.1, default: 0, format: db },
      { key: 'mid', label: 'Mid', min: -18, max: 18, step: 0.1, default: 0, format: db },
      { key: 'midFreq', label: 'Mid freq', min: 200, max: 8000, step: 1, default: 1200, log: true, format: hz },
      { key: 'high', label: 'High (8 kHz)', min: -18, max: 18, step: 0.1, default: 0, format: db },
    ],
    build(ctx, p) {
      const lo = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 100 });
      const mi = new BiquadFilterNode(ctx, { type: 'peaking', Q: 0.9 });
      const hi = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 8000 });
      lo.connect(mi).connect(hi);
      const u = (p, init) => {
        const set = init ? (prm, v) => (prm.value = v) : (prm, v) => setP(ctx, prm, v);
        set(lo.gain, p.low); set(mi.gain, p.mid); set(mi.frequency, p.midFreq); set(hi.gain, p.high);
      };
      u(p, true);
      return { input: lo, output: hi, update: (p) => u(p) };
    },
  },
  filter: {
    name: 'Filter', category: 'Tone', icon: 'filter', kind: 'node',
    description: 'Cut lows (rumble), highs (hiss), or isolate a band.',
    params: [
      { key: 'type', label: 'Type', type: 'select', default: 'highpass', options: [['highpass', 'High-pass'], ['lowpass', 'Low-pass'], ['bandpass', 'Band-pass'], ['notch', 'Notch']] },
      { key: 'freq', label: 'Frequency', min: 20, max: 20000, step: 1, default: 80, log: true, format: hz },
      { key: 'q', label: 'Resonance', min: 0.1, max: 18, step: 0.01, default: 0.71, log: true, format: (v) => v.toFixed(2) },
    ],
    build(ctx, p) {
      // Two cascaded biquads = steeper 24 dB/oct slope.
      const a = new BiquadFilterNode(ctx), b = new BiquadFilterNode(ctx);
      a.connect(b);
      const u = (p, init) => {
        for (const f of [a, b]) {
          f.type = p.type;
          if (init) { f.frequency.value = p.freq; f.Q.value = p.q; } else { setP(ctx, f.frequency, p.freq); setP(ctx, f.Q, p.q); }
        }
      };
      u(p, true);
      return { input: a, output: b, update: (p) => u(p) };
    },
  },

  // ---- Space ----------------------------------------------------------------
  reverb: {
    name: 'Reverb', category: 'Space', icon: 'reverb', kind: 'node',
    description: 'Place the sound in a room, hall or cathedral.',
    params: [
      { key: 'size', label: 'Room size', min: 0.2, max: 8, step: 0.05, default: 2.2, format: sec },
      { key: 'decay', label: 'Decay', min: 1, max: 8, step: 0.1, default: 3, format: (v) => v.toFixed(1) },
      { key: 'damping', label: 'Brightness', min: 1000, max: 20000, step: 10, default: 9000, log: true, format: hz },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 200, step: 1, default: 15, format: ms },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.3, format: pct },
    ],
    build(ctx, p) {
      const w = wetDry(ctx);
      const pre = new DelayNode(ctx, { maxDelayTime: 0.5 });
      const conv = ctx.createConvolver();
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass' });
      w.input.connect(pre).connect(conv).connect(tone).connect(w.wetIn);
      let irKey = '';
      const u = (p, init) => {
        const key = `${p.size}|${p.decay}`;
        if (key !== irKey) {
          irKey = key;
          const ir = makeImpulse(ctx.sampleRate, p.size, p.decay);
          const buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
          ir.forEach((d, i) => buf.copyToChannel(d, i));
          conv.buffer = buf;
        }
        if (init) { pre.delayTime.value = p.predelay / 1000; tone.frequency.value = p.damping; }
        else { setP(ctx, pre.delayTime, p.predelay / 1000); setP(ctx, tone.frequency, p.damping); }
        w.setMix(p.mix);
      };
      u(p, true);
      return { input: w.input, output: w.output, update: (p) => u(p) };
    },
  },
  delay: {
    name: 'Echo / Delay', category: 'Space', icon: 'delay', kind: 'node',
    description: 'Repeating echoes with feedback.',
    params: [
      { key: 'time', label: 'Time', min: 10, max: 2000, step: 1, default: 320, format: ms },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, default: 0.4, format: pct },
      { key: 'tone', label: 'Tone', min: 500, max: 20000, step: 10, default: 6000, log: true, format: hz },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.35, format: pct },
    ],
    build(ctx, p) {
      const w = wetDry(ctx);
      const d = new DelayNode(ctx, { maxDelayTime: 2.5 });
      const fb = ctx.createGain();
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass' });
      w.input.connect(d).connect(tone).connect(w.wetIn);
      tone.connect(fb).connect(d);
      const u = (p, init) => {
        if (init) { d.delayTime.value = p.time / 1000; fb.gain.value = p.feedback; tone.frequency.value = p.tone; }
        else { setP(ctx, d.delayTime, p.time / 1000); setP(ctx, fb.gain, p.feedback); setP(ctx, tone.frequency, p.tone); }
        w.setMix(p.mix);
      };
      u(p, true);
      return { input: w.input, output: w.output, update: (p) => u(p) };
    },
  },
  chorus: {
    name: 'Chorus', category: 'Space', icon: 'chorus', kind: 'node',
    description: 'Thicken and widen with gently detuned copies.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 8, step: 0.01, default: 0.8, log: true, format: (v) => `${v.toFixed(2)} Hz` },
      { key: 'depth', label: 'Depth', min: 0.1, max: 10, step: 0.1, default: 3, format: (v) => `${v.toFixed(1)} ms` },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.45, format: pct },
    ],
    build(ctx, p) {
      const w = wetDry(ctx);
      const merger = ctx.createChannelMerger(2);
      const oscs = [];
      const voices = [0, Math.PI].map((phase, i) => {
        const d = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: 0.018 });
        const real = new Float32Array([0, Math.cos(phase)]);
        const imag = new Float32Array([0, Math.sin(phase)]);
        const osc = new OscillatorNode(ctx);
        osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
        const depth = ctx.createGain();
        osc.connect(depth).connect(d.delayTime);
        osc.start();
        oscs.push(osc);
        w.input.connect(d).connect(merger, 0, i);
        return { osc, depth };
      });
      merger.connect(w.wetIn);
      const u = (p, init) => {
        for (const v of voices) {
          if (init) { v.osc.frequency.value = p.rate; v.depth.gain.value = p.depth / 1000; }
          else { setP(ctx, v.osc.frequency, p.rate); setP(ctx, v.depth.gain, p.depth / 1000); }
        }
        w.setMix(p.mix);
      };
      u(p, true);
      return { input: w.input, output: w.output, update: (p) => u(p), dispose: () => oscs.forEach((o) => o.stop()) };
    },
  },

  // ---- Character ------------------------------------------------------------
  distortion: {
    name: 'Distortion', category: 'Character', icon: 'distort', kind: 'node',
    description: 'Warm saturation up to full fuzz.',
    params: [
      { key: 'drive', label: 'Drive', min: 1, max: 50, step: 0.1, default: 6, log: true, format: (v) => `${v.toFixed(1)}×` },
      { key: 'tone', label: 'Tone', min: 500, max: 20000, step: 10, default: 8000, log: true, format: hz },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1, format: pct },
      { key: 'output', label: 'Output', min: -24, max: 6, step: 0.1, default: -6, format: db },
    ],
    build(ctx, p) {
      const w = wetDry(ctx);
      const sh = new WaveShaperNode(ctx, { oversample: '4x' });
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass' });
      const out = ctx.createGain();
      w.input.connect(sh).connect(tone).connect(w.wetIn);
      w.output.connect(out);
      let k = -1;
      const u = (p, init) => {
        if (p.drive !== k) { k = p.drive; sh.curve = shaperCurve(k); }
        if (init) { tone.frequency.value = p.tone; out.gain.value = dbToGain(p.output); }
        else { setP(ctx, tone.frequency, p.tone); setP(ctx, out.gain, dbToGain(p.output)); }
        w.setMix(p.mix);
      };
      u(p, true);
      return { input: w.input, output: out, update: (p) => u(p) };
    },
  },
  lofi: {
    name: 'Lo-Fi', category: 'Character', icon: 'lofi', kind: 'buffer',
    description: 'Bit-crush and down-sample for retro grit.',
    params: [
      { key: 'bits', label: 'Bit depth', min: 2, max: 16, step: 1, default: 8, format: (v) => `${v} bit` },
      { key: 'rate', label: 'Sample rate', min: 1000, max: 44100, step: 50, default: 11025, log: true, format: hz },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1, format: pct },
    ],
    process(ch, p, sr) {
      const steps = Math.pow(2, p.bits - 1);
      const hold = Math.max(1, sr / p.rate);
      return ch.map((c) => {
        const out = new Float32Array(c.length);
        let held = 0, next = 0;
        for (let i = 0; i < c.length; i++) {
          if (i >= next) { held = Math.round(c[i] * steps) / steps; next += hold; }
          out[i] = c[i] * (1 - p.mix) + held * p.mix;
        }
        return out;
      });
    },
  },
  tremolo: {
    name: 'Tremolo', category: 'Character', icon: 'tremolo', kind: 'node',
    description: 'Rhythmic volume wobble.',
    params: [
      { key: 'rate', label: 'Rate', min: 0.1, max: 20, step: 0.01, default: 5, log: true, format: (v) => `${v.toFixed(2)} Hz` },
      { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, default: 0.5, format: pct },
      { key: 'wave', label: 'Wave', type: 'select', default: 'sine', options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']] },
    ],
    build(ctx, p) {
      const g = ctx.createGain();
      const osc = new OscillatorNode(ctx);
      const depth = ctx.createGain();
      osc.connect(depth).connect(g.gain);
      osc.start();
      const u = (p, init) => {
        osc.type = p.wave;
        if (init) { osc.frequency.value = p.rate; depth.gain.value = p.depth / 2; g.gain.value = 1 - p.depth / 2; }
        else { setP(ctx, osc.frequency, p.rate); setP(ctx, depth.gain, p.depth / 2); setP(ctx, g.gain, 1 - p.depth / 2); }
      };
      u(p, true);
      return { input: g, output: g, update: (p) => u(p), dispose: () => osc.stop() };
    },
  },

  // ---- Stereo ---------------------------------------------------------------
  pan: {
    name: 'Pan', category: 'Stereo', icon: 'pan', kind: 'node',
    description: 'Position the sound left or right.',
    params: [{ key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, default: 0, format: (v) => (Math.abs(v) < 0.005 ? 'Center' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'L' : 'R'}`) }],
    build(ctx, p) {
      const n = new StereoPannerNode(ctx, { pan: p.pan });
      return { input: n, output: n, update: (p) => setP(ctx, n.pan, p.pan) };
    },
  },
  width: {
    name: 'Stereo Width', category: 'Stereo', icon: 'width', kind: 'node',
    description: 'Narrow to mono or widen beyond the speakers.',
    params: [{ key: 'width', label: 'Width', min: 0, max: 2, step: 0.01, default: 1.4, format: pct }],
    build(ctx, p) {
      const input = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const ll = ctx.createGain(), rr = ctx.createGain(), lr = ctx.createGain(), rl = ctx.createGain();
      input.connect(split);
      split.connect(ll, 0); split.connect(lr, 0);
      split.connect(rr, 1); split.connect(rl, 1);
      ll.connect(merge, 0, 0); rl.connect(merge, 0, 0);
      rr.connect(merge, 0, 1); lr.connect(merge, 0, 1);
      const u = (p, init) => {
        const same = (1 + p.width) / 2, cross = (1 - p.width) / 2;
        const set = init ? (prm, v) => (prm.value = v) : (prm, v) => setP(ctx, prm, v);
        set(ll.gain, same); set(rr.gain, same); set(lr.gain, cross); set(rl.gain, cross);
      };
      u(p, true);
      return { input, output: merge, update: (p) => u(p) };
    },
  },

  // ---- Time -----------------------------------------------------------------
  reverse: {
    name: 'Reverse', category: 'Time', icon: 'reverse', kind: 'buffer',
    description: 'Play it backwards.',
    params: [],
    process: (ch) => reverse(ch),
  },
};

export const CATEGORIES = ['Volume', 'Dynamics', 'Tone', 'Space', 'Character', 'Stereo', 'Time'];

export function defaultParams(type) {
  return Object.fromEntries(EFFECTS[type].params.map((p) => [p.key, p.default]));
}

let uid = 0;
export function createEffect(type, overrides = {}) {
  return { id: `fx${Date.now().toString(36)}${(uid++).toString(36)}`, type, enabled: true, collapsed: false, params: { ...defaultParams(type), ...overrides } };
}

/** One-click effect stacks. */
export const PRESETS = [
  {
    name: 'Voice Clean-up', description: 'Rumble filter, gate, gentle compression, clarity',
    stack: [['filter', { type: 'highpass', freq: 80 }], ['gate', { thresholdDb: -50 }], ['compressor', { threshold: -22, ratio: 3 }], ['eq', { low: -2, mid: 2, midFreq: 3200, high: 2 }], ['normalize', { target: -1 }]],
  },
  {
    name: 'Podcast Polish', description: 'Broadcast-style loud, even voice',
    stack: [['filter', { type: 'highpass', freq: 70 }], ['compressor', { threshold: -26, ratio: 4, makeup: 6 }], ['eq', { low: 1.5, mid: 1.5, midFreq: 2800, high: 3 }], ['limiter', { drive: 4, ceiling: -1 }]],
  },
  {
    name: 'Telephone', description: 'Narrow, crunchy phone-line sound',
    stack: [['filter', { type: 'bandpass', freq: 1600, q: 1.1 }], ['distortion', { drive: 4, tone: 4000, mix: 0.6, output: -3 }], ['lofi', { bits: 10, rate: 8000 }]],
  },
  {
    name: 'Lo-fi Tape', description: 'Dusty, warbly cassette vibe',
    stack: [['lofi', { bits: 12, rate: 22050, mix: 0.8 }], ['filter', { type: 'lowpass', freq: 7000 }], ['chorus', { rate: 0.4, depth: 1.5, mix: 0.4 }], ['distortion', { drive: 2, mix: 0.4, output: -2 }]],
  },
  {
    name: 'Big Hall', description: 'Lush, spacious reverb',
    stack: [['reverb', { size: 4.5, decay: 3.5, mix: 0.35, predelay: 30 }], ['width', { width: 1.5 }]],
  },
];
