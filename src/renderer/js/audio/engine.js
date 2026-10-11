// Audio engine: playback graph, live effect updates, offline rendering.

import { EFFECTS } from './effects.js';
import { state, on, emit, hasRange, projectDuration, getTrack } from '../state.js';
import { dbToGain } from '../dsp/analysis.js';
import { spliceProcessed, padEnd } from '../dsp/edit.js';

let ctx = null;
let master = null;

export function getCtx() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    state.sampleRate = ctx.sampleRate;
    const gain = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const meters = [0, 1].map(() => new AnalyserNode(ctx, { fftSize: 2048 }));
    gain.connect(ctx.destination);
    gain.connect(split);
    meters.forEach((m, i) => split.connect(m, i));
    master = { gain, meters, buf: new Float32Array(2048) };
  }
  return ctx;
}

/** Peak levels (linear) of the master bus, [L, R]. */
export function masterLevels() {
  if (!master) return [0, 0];
  return master.meters.map((m) => {
    m.getFloatTimeDomainData(master.buf);
    let p = 0;
    for (const v of master.buf) { const a = Math.abs(v); if (a > p) p = a; }
    return p;
  });
}

// ---- Buffers & caches ------------------------------------------------------

const bufferCache = new WeakMap();
export function toAudioBuffer(channels, sr = state.sampleRate) {
  const hit = bufferCache.get(channels[0]);
  if (hit && hit.chs.length === channels.length && hit.chs.every((c, i) => c === channels[i]) && hit.buf.sampleRate === sr) return hit.buf;
  const buf = new AudioBuffer({ numberOfChannels: channels.length, length: Math.max(1, channels[0].length), sampleRate: sr });
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  bufferCache.set(channels[0], { chs: [...channels], buf });
  return buf;
}

const arrayIds = new WeakMap();
let arraySeq = 0;
const audioKey = (channels) => channels.map((c) => {
  if (!arrayIds.has(c)) arrayIds.set(c, ++arraySeq);
  return arrayIds.get(c);
}).join(',');
const fxKey = (effects) => JSON.stringify(effects.map((e) => [e.type, e.params]));

export const enabledEffects = (track) => track.effects.filter((e) => e.enabled && EFFECTS[e.type]);

/** Builds a serial chain of node-effects. Returns {input, output, items, dispose}. */
function buildChain(c, effects, timing) {
  const input = c.createGain();
  let tail = input;
  const items = [];
  for (const fx of effects) {
    const inst = EFFECTS[fx.type].build(c, fx.params, timing);
    tail.connect(inst.input);
    tail = inst.output;
    items.push({ id: fx.id, inst });
  }
  return {
    input, output: tail, items,
    dispose() {
      for (const { inst } of items) { try { inst.dispose?.(); } catch { /* already stopped */ } }
      try { input.disconnect(); } catch { /* noop */ }
      try { tail.disconnect(); } catch { /* noop */ }
    },
  };
}

async function renderNodes(channels, effects, sr) {
  const len = channels[0]?.length ?? 0;
  if (!len || !effects.length) return channels;
  const off = new OfflineAudioContext(channels.length, len, sr);
  const src = new AudioBufferSourceNode(off, { buffer: toAudioBuffer(channels, sr) });
  const chain = buildChain(off, effects, { when: 0, offset: 0, duration: len / sr });
  src.connect(chain.input);
  chain.output.connect(off.destination);
  src.start(0);
  const out = await off.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => new Float32Array(out.getChannelData(i)));
}

/** Runs `effects` (mixed node/buffer kinds) over `channels`, keeping the channel count. */
export async function renderChain(channels, effects, sr = state.sampleRate) {
  let cur = channels;
  let pending = [];
  for (const fx of effects) {
    const def = EFFECTS[fx.type];
    if (def.kind === 'node') { pending.push(fx); continue; }
    if (pending.length) { cur = await renderNodes(cur, pending, sr); pending = []; }
    cur = def.process(cur, fx.params, sr);
  }
  if (pending.length) cur = await renderNodes(cur, pending, sr);
  return cur;
}

// Effects up to (and including) the last buffer-kind effect are pre-rendered;
// the remaining node effects run live so their sliders respond instantly.
const prefixCache = new Map();
async function sourceFor(track) {
  const fx = enabledEffects(track);
  let last = -1;
  fx.forEach((e, i) => { if (EFFECTS[e.type].kind === 'buffer') last = i; });
  if (last < 0) return { channels: track.channels, live: fx };
  const prefix = fx.slice(0, last + 1);
  const key = audioKey(track.channels) + fxKey(prefix);
  let hit = prefixCache.get(track.id);
  if (!hit || hit.key !== key) {
    hit = { key, channels: await renderChain(track.channels, prefix) };
    prefixCache.set(track.id, hit);
  }
  return { channels: hit.channels, live: fx.slice(last + 1) };
}

const padCache = new WeakMap();
function padForLoop(channels, frames) {
  if (channels[0].length >= frames) return channels;
  const hit = padCache.get(channels[0]);
  if (hit && hit.frames === frames && hit.src.every((c, i) => c === channels[i])) return hit.out;
  const out = padEnd(channels, frames);
  padCache.set(channels[0], { frames, src: [...channels], out });
  return out;
}

const audible = (t, anySolo) => !t.mute && (!anySolo || t.solo);

/** Wires source → effects → track gain → pan → dest. Does not start the source. */
async function buildVoice(c, track, dest, timing, loop) {
  let { channels, live } = await sourceFor(track);
  if (!channels[0]?.length) return null;
  // Shorter tracks must loop at the same point as the others, so pad them with silence.
  if (loop) channels = padForLoop(channels, Math.ceil(loop.end * state.sampleRate));
  const source = new AudioBufferSourceNode(c, { buffer: toAudioBuffer(channels) });
  if (loop) { source.loop = true; source.loopStart = loop.start; source.loopEnd = loop.end; }
  const chain = buildChain(c, live, timing);
  const anySolo = state.tracks.some((t) => t.solo);
  const gain = new GainNode(c, { gain: audible(track, anySolo) ? dbToGain(track.gainDb) : 0 });
  const panner = new StereoPannerNode(c, { pan: track.pan });
  source.connect(chain.input);
  chain.output.connect(gain).connect(panner).connect(dest);
  return {
    source, chain, gain, panner,
    liveIds: new Set(live.map((e) => e.id)),
    /** Start the source; time-based automation (fades) is re-scheduled for the real start time. */
    start(when, offset) {
      timing.when = when;
      timing.offset = offset;
      for (const { id, inst } of chain.items) {
        if (!inst.timed) continue;
        const fx = track.effects.find((e) => e.id === id);
        if (fx) inst.update(fx.params);
      }
      if (offset < source.buffer.duration) source.start(when, offset);
    },
    stop() {
      try { source.stop(); } catch { /* not started */ }
      source.disconnect();
      chain.dispose();
      panner.disconnect();
    },
  };
}

// ---- Transport -------------------------------------------------------------

const voices = new Map();
let startCtxTime = 0;
let startOffset = 0;
let endTime = 0;
let loopRange = null;
let playToken = 0;

export function position() {
  if (!state.playing || !ctx) return state.playhead;
  const t = startOffset + Math.max(0, ctx.currentTime - startCtxTime);
  if (loopRange && t >= loopRange.end) {
    const len = loopRange.end - loopRange.start;
    return loopRange.start + ((t - loopRange.start) % len);
  }
  return t;
}

export async function play(from) {
  const c = getCtx();
  await c.resume();
  stopVoices();
  const token = ++playToken;
  const total = projectDuration();
  if (!total) return;
  const sel = state.selection;
  const range = hasRange();
  loopRange = state.loop ? (range ? { start: sel.start, end: sel.end } : { start: 0, end: total }) : null;
  let offset = from ?? (range ? sel.start : sel.start >= total - 0.01 ? 0 : sel.start);
  if (loopRange && (offset < loopRange.start || offset >= loopRange.end)) offset = loopRange.start;
  endTime = loopRange ? Infinity : (range && from === undefined ? sel.end : total);

  const built = await Promise.all(state.tracks.map(async (t) => [t.id, await buildVoice(c, t, master.gain, { when: 0, offset, duration: t.channels[0].length / state.sampleRate }, loopRange)]));
  if (token !== playToken) { built.forEach(([, v]) => v?.stop()); return; }

  const when = c.currentTime + 0.04;
  for (const [id, v] of built) {
    if (!v) continue;
    v.start(when, offset);
    voices.set(id, v);
  }
  startCtxTime = when;
  startOffset = offset;
  state.playing = true;
  emit('transport');
}

function stopVoices() {
  voices.forEach((v) => v.stop());
  voices.clear();
}

export function stop() {
  ++playToken;
  stopVoices();
  if (state.playing) {
    state.playing = false;
    emit('transport');
  }
}

export function seek(t) {
  state.playhead = t;
  if (state.playing) play(t);
}

/** Called from the UI's animation loop. Returns the current position. */
export function tick() {
  if (!state.playing) return state.playhead;
  const p = position();
  if (p >= endTime) {
    stop();
    state.playhead = Math.min(endTime, projectDuration());
    return state.playhead;
  }
  state.playhead = p;
  return p;
}

/** Rebuild one track's voice in place at the current position (keeps the others running). */
const rebuildTimers = new Map();
function rebuildVoice(trackId, delay = 0) {
  clearTimeout(rebuildTimers.get(trackId));
  rebuildTimers.set(trackId, setTimeout(async () => {
    if (!state.playing) return;
    const track = getTrack(trackId);
    const token = playToken;
    const old = voices.get(trackId);
    if (!track) { old?.stop(); voices.delete(trackId); return; }
    const v = await buildVoice(ctx, track, master.gain, { when: 0, offset: 0, duration: track.channels[0].length / state.sampleRate }, loopRange);
    if (token !== playToken || !state.playing) { v?.stop(); return; }
    // Re-sync to the transport clock after the (possibly async) render.
    const now = ctx.currentTime + 0.02;
    let off = startOffset + (now - startCtxTime);
    if (loopRange && off >= loopRange.end) off = loopRange.start + ((off - loopRange.start) % (loopRange.end - loopRange.start));
    if (v) {
      v.start(now, off);
      voices.set(trackId, v);
    } else voices.delete(trackId);
    if (old) old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    setTimeout(() => old?.stop(), 60);
  }, delay));
}

export function updateTrackMix() {
  if (!ctx) return;
  const anySolo = state.tracks.some((t) => t.solo);
  voices.forEach((v, id) => {
    const t = getTrack(id);
    if (!t) return;
    v.gain.gain.setTargetAtTime(audible(t, anySolo) ? dbToGain(t.gainDb) : 0, ctx.currentTime, 0.01);
    v.panner.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
  });
}

on('trackprops', updateTrackMix);
on('tracks', () => { if (state.playing) play(position()); });
on('audio', (id) => { if (state.playing) rebuildVoice(id); });
on('effects', ({ id, fxId, structural }) => {
  schedulePreview(id);
  if (!state.playing) return;
  const v = voices.get(id);
  const track = getTrack(id);
  const fx = track?.effects.find((e) => e.id === fxId);
  if (!structural && v && fx && fx.enabled && v.liveIds.has(fxId)) {
    const item = v.chain.items.find((it) => it.id === fxId);
    item?.inst.update?.(fx.params);
    return;
  }
  rebuildVoice(id, structural ? 0 : 120);
});

// ---- Processed-waveform previews (the "modifier result" shown in the timeline) ----

export const previews = new Map();
const previewTimers = new Map();
export function schedulePreview(trackId, delay = 250) {
  clearTimeout(previewTimers.get(trackId));
  previewTimers.set(trackId, setTimeout(() => refreshPreview(trackId), delay));
}

async function refreshPreview(trackId) {
  const track = getTrack(trackId);
  if (!track) { previews.delete(trackId); return; }
  const fx = enabledEffects(track);
  if (!fx.length || !track.channels[0]?.length) {
    if (previews.delete(trackId)) emit('preview', trackId);
    return;
  }
  const key = audioKey(track.channels) + fxKey(fx);
  if (previews.get(trackId)?.key === key) return;
  getCtx();
  const channels = await renderChain(track.channels, fx);
  if (getTrack(trackId) && audioKey(track.channels) + fxKey(enabledEffects(track)) === key) {
    previews.set(trackId, { key, channels });
    emit('preview', trackId);
  }
}
on('audio', (id) => schedulePreview(id, 50));
on('tracks', () => state.tracks.forEach((t) => schedulePreview(t.id, 50)));

// ---- Destructive operations --------------------------------------------------

/** Bakes `effects` into the track audio. With a [s,e) frame range, only that region changes. */
export async function bakeEffects(track, effects, range = null) {
  getCtx();
  const rendered = await renderChain(track.channels, effects);
  if (!range) return rendered;
  return spliceProcessed(track.channels, rendered, range[0], range[1]);
}

/** Full mixdown of audible tracks between start/end (seconds). */
export async function renderMix({ start = 0, end = projectDuration(), channels = 2 } = {}) {
  getCtx();
  const sr = state.sampleRate;
  const len = Math.max(1, Math.round((end - start) * sr));
  const off = new OfflineAudioContext(channels, len, sr);
  const anySolo = state.tracks.some((t) => t.solo);
  for (const t of state.tracks) {
    if (!audible(t, anySolo)) continue;
    const v = await buildVoice(off, t, off.destination, { when: 0, offset: start, duration: t.channels[0].length / sr }, null);
    v?.start(0, start);
  }
  const out = await off.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => new Float32Array(out.getChannelData(i)));
}

export async function decodeFile(file) {
  const c = getCtx();
  const data = await file.arrayBuffer();
  const buf = await c.decodeAudioData(data);
  return Array.from({ length: buf.numberOfChannels }, (_, i) => new Float32Array(buf.getChannelData(i)));
}

/** Resample channels to the project rate (used when loading projects saved at another rate). */
export async function resample(channels, fromRate) {
  const c = getCtx();
  if (fromRate === c.sampleRate || !channels[0]?.length) return channels;
  const len = Math.ceil((channels[0].length * c.sampleRate) / fromRate);
  const off = new OfflineAudioContext(channels.length, len, c.sampleRate);
  const src = new AudioBufferSourceNode(off, { buffer: toAudioBuffer(channels, fromRate) });
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => new Float32Array(out.getChannelData(i)));
}
