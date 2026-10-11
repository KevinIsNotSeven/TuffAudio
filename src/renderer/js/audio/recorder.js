// Recording from microphones, line inputs, desktop (system) audio, or desktop + mic.

import { getCtx } from './engine.js';
import { PEAK_BLOCK } from '../dsp/analysis.js';

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const isMonitor = (label) => /monitor|loopback|stereo mix|what u hear|blackhole|soundflower/i.test(label);

let permissionAsked = false;

/** Lists recordable sources grouped by kind. Asks for mic permission once so labels are visible. */
export async function listSources({ askPermission = false } = {}) {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return [];
  let devices = await md.enumerateDevices();
  const hidden = devices.some((d) => d.kind === 'audioinput' && !d.label);
  if (hidden && askPermission && !permissionAsked) {
    permissionAsked = true;
    try {
      const s = await md.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await md.enumerateDevices();
    } catch { /* user declined: we still offer the defaults */ }
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const sources = [];
  for (const d of inputs) {
    const label = d.label || (d.deviceId === 'default' ? 'Default input' : 'Audio input');
    sources.push({ id: `in:${d.deviceId}`, label, kind: isMonitor(label) ? 'desktop' : 'input' });
  }
  if (!sources.length) sources.push({ id: 'in:default', label: 'Default microphone', kind: 'input' });
  if (md.getDisplayMedia) {
    sources.unshift({ id: 'desktop', label: 'System audio (everything you hear)', kind: 'desktop' });
    sources.push({ id: 'mix', label: 'System audio + default microphone', kind: 'mix' });
  }
  return sources;
}

async function inputStream(deviceId, channels) {
  return navigator.mediaDevices.getUserMedia({
    audio: { ...RAW, deviceId: deviceId === 'default' ? undefined : { exact: deviceId }, channelCount: { ideal: channels } },
  });
}

async function desktopStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { ...RAW, suppressLocalAudioPlayback: false },
    systemAudio: 'include',
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) {
    throw new Error('No system audio was shared. On Linux, pick a "Monitor of …" input instead; in a browser, tick "Share system audio".');
  }
  return stream;
}

export class Recorder {
  constructor() {
    this.active = false;
    this.chunks = [];
    this.frames = 0;
    this.peaks = []; // [min, max] per PEAK_BLOCK frames (all channels combined) for the live waveform
    this.level = 0;
  }

  async start({ sourceId, channels = 2 }) {
    const ctx = getCtx();
    await ctx.resume();
    await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));

    const streams = [];
    if (sourceId === 'desktop') streams.push(await desktopStream());
    else if (sourceId === 'mix') {
      streams.push(await desktopStream());
      streams.push(await inputStream('default', channels));
    } else streams.push(await inputStream(sourceId.replace(/^in:/, ''), channels));
    this.streams = streams;

    const sum = new GainNode(ctx, { channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.nodes = streams.map((s) => {
      const n = ctx.createMediaStreamSource(s);
      n.connect(sum);
      return n;
    });
    this.analyser = new AnalyserNode(ctx, { fftSize: 1024 });
    this.worklet = new AudioWorkletNode(ctx, 'tuff-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.sink = new GainNode(ctx, { gain: 0 });
    sum.connect(this.analyser);
    sum.connect(this.worklet).connect(this.sink).connect(ctx.destination);
    this.sum = sum;

    this.chunks = [];
    this.frames = 0;
    this.peaks = [];
    this.pend = { mn: 1, mx: -1, n: 0 };
    this.channels = channels;
    this.done = new Promise((resolve) => {
      this.worklet.port.onmessage = (e) => {
        if (e.data.chunk) this.push(e.data.chunk);
        if (e.data.done) resolve();
      };
    });
    this.startedAt = ctx.currentTime;
    this.active = true;
  }

  push(chunk) {
    this.chunks.push(chunk);
    const n = chunk[0].length;
    const p = this.pend;
    for (let i = 0; i < n; i++) {
      for (const c of chunk) { const v = c[i]; if (v < p.mn) p.mn = v; if (v > p.mx) p.mx = v; }
      if (++p.n === PEAK_BLOCK) { this.peaks.push(p.mn, p.mx); p.mn = 1; p.mx = -1; p.n = 0; }
    }
    this.frames += n;
  }

  /** Current input peak level (linear), for the record meter. */
  inputLevel() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let m = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > m) m = a; }
    return m;
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    this.worklet.port.postMessage('stop');
    await Promise.race([this.done, new Promise((r) => setTimeout(r, 500))]);
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.nodes.forEach((n) => n.disconnect());
    this.sum.disconnect();
    this.worklet.disconnect();
    this.sink.disconnect();
    const out = Array.from({ length: this.channels }, () => new Float32Array(this.frames));
    let o = 0;
    for (const chunk of this.chunks) {
      for (let c = 0; c < this.channels; c++) out[c].set(chunk[c] ?? chunk[0], o);
      o += chunk[0].length;
    }
    this.chunks = [];
    return out;
  }
}
