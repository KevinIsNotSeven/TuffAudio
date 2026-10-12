// Export formats, in the order they're offered to the user.
// MP3 and Ogg Vorbis use the bundled WebAssembly encoders (vendor/),
// Opus uses the browser's built-in WebCodecs encoder, and the rest are
// written directly in JS.

import { encodeWav } from '../dsp/wav.js';
import { encodeFlac } from '../dsp/flac.js';
import { encodeAiff, oggMux, opusHeaders } from '../dsp/containers.js';
import { resampleTo } from './engine.js';

const bits = (allowFloat) => ({
  key: 'bits', label: 'Quality', default: 16,
  options: [[16, '16-bit'], [24, '24-bit'], ...(allowFloat ? [[32, '32-bit float']] : [])],
  hint: '16-bit is CD quality and works everywhere.',
});

export const FORMATS = [
  {
    id: 'mp3', label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', desc: 'Plays everywhere',
    quality: { key: 'kbps', label: 'Bitrate', default: 192, options: [[128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']], hint: '192 kbps sounds great for most things; 320 is the maximum.' },
  },
  { id: 'wav', label: 'WAV', ext: 'wav', mime: 'audio/wav', desc: 'Uncompressed', quality: bits(true) },
  {
    id: 'ogg', label: 'OGG', ext: 'ogg', mime: 'audio/ogg', desc: 'Ogg Vorbis',
    quality: { key: 'q', label: 'Quality', default: 5, options: [[3, 'Low'], [5, 'Medium'], [7, 'High'], [9, 'Best']], hint: 'Medium is roughly 160 kbps.' },
  },
  { id: 'flac', label: 'FLAC', ext: 'flac', mime: 'audio/flac', desc: 'Lossless, smaller', quality: { ...bits(false), hint: 'Perfect quality at about half the size of WAV.' } },
  {
    id: 'opus', label: 'Opus', ext: 'opus', mime: 'audio/ogg', desc: 'Tiny & modern',
    quality: { key: 'kbps', label: 'Bitrate', default: 128, options: [[64, '64 kbps'], [96, '96 kbps'], [128, '128 kbps'], [192, '192 kbps']], hint: 'Opus at 96–128 kbps rivals MP3 at 192+. Great for voice and web.' },
  },
  { id: 'aiff', label: 'AIFF', ext: 'aiff', mime: 'audio/aiff', desc: 'Uncompressed (Apple)', quality: bits(false) },
];

export const formatById = (id) => FORMATS.find((f) => f.id === id) || FORMATS[0];

let wasmEncoders = null;
const loadWasm = () => (wasmEncoders ??= import('../../vendor/wasm-media-encoders.js'));
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/** Feed planar audio to a wasm encoder in chunks, collecting copies of its output. */
async function runWasmEncoder(enc, channels) {
  const parts = [];
  const n = channels[0].length;
  const CHUNK = 1152 * 64;
  for (let s = 0; s < n; s += CHUNK) {
    const out = enc.encode(channels.map((c) => c.subarray(s, Math.min(n, s + CHUNK))));
    if (out.length) parts.push(out.slice());
    if ((s / CHUNK) % 16 === 15) await yieldToUi();
  }
  const tail = enc.finalize();
  if (tail.length) parts.push(tail.slice());
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

async function encodeMp3(channels, sampleRate, { kbps }) {
  const { createMp3Encoder } = await loadWasm();
  const enc = await createMp3Encoder();
  enc.configure({
    channels: channels.length, sampleRate, bitrate: kbps,
    ...(MP3_RATES.includes(sampleRate) ? {} : { outputSampleRate: 48000 }),
  });
  return runWasmEncoder(enc, channels);
}

async function encodeOgg(channels, sampleRate, { q }) {
  const { createOggEncoder } = await loadWasm();
  const enc = await createOggEncoder();
  enc.configure({ channels: channels.length, sampleRate, vbrQuality: q });
  return runWasmEncoder(enc, channels);
}

async function encodeOpus(channels, sampleRate, { kbps }) {
  if (typeof AudioEncoder === 'undefined') throw new Error('Opus encoding is not available on this system');
  const RATE = 48000; // Opus always runs at 48 kHz internally
  const pcm = sampleRate === RATE ? channels : await resampleTo(channels, sampleRate, RATE);
  const nch = pcm.length, total = pcm[0].length;
  // The encoder holds back its look-ahead (~6.5 ms); feed a little extra silence so the
  // real end gets encoded, then the final granule position trims the padding away.
  const PAD = 1920;
  const padded = pcm.map((c) => { const o = new Float32Array(total + PAD); o.set(c); return o; });
  const config = { codec: 'opus', sampleRate: RATE, numberOfChannels: nch, bitrate: kbps * 1000 };
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error('Opus encoding is not supported here');

  const packets = [];
  let description = null, failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, frames: Math.round(((chunk.duration ?? 20000) * RATE) / 1e6) });
      if (meta?.decoderConfig?.description) description = new Uint8Array(meta.decoderConfig.description);
    },
    error: (e) => { failure = e; },
  });
  enc.configure(config);
  const BLOCK = RATE; // 1 s per AudioData
  for (let s = 0; s < total + PAD; s += BLOCK) {
    const n = Math.min(BLOCK, total + PAD - s);
    const data = new Float32Array(n * nch);
    padded.forEach((c, i) => data.set(c.subarray(s, s + n), i * n));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: nch, timestamp: Math.round((s / RATE) * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;

  // Pre-skip (encoder delay) comes from the encoder's own OpusHead when it provides one.
  let preSkip = 312;
  if (description?.length >= 12 && String.fromCharCode(...description.subarray(0, 8)) === 'OpusHead') {
    preSkip = description[10] | (description[11] << 8);
  }
  const [head, tags] = opusHeaders(nch, sampleRate, preSkip);
  // Granule = samples decoded so far, counting the pre-skip region from zero.
  let granule = 0;
  const audio = packets.map((p, i) => {
    granule += p.frames;
    // The last page's granule marks the true end so players trim the padding.
    return { data: p.data, granule: i === packets.length - 1 ? preSkip + total : Math.min(granule, preSkip + total) };
  });
  return oggMux([{ data: head, granule: 0, alone: true }, { data: tags, granule: 0, alone: true }, ...audio]);
}

/** Encode planar Float32 channels to the chosen format. Returns an ArrayBuffer. */
export async function encodeAudio(formatId, channels, sampleRate, opts = {}) {
  switch (formatId) {
    case 'mp3': return encodeMp3(channels, sampleRate, { kbps: 192, ...opts });
    case 'ogg': return encodeOgg(channels, sampleRate, { q: 5, ...opts });
    case 'flac': return encodeFlac(channels, sampleRate, opts.bits === 24 ? 24 : 16);
    case 'opus': return encodeOpus(channels, sampleRate, { kbps: 128, ...opts });
    case 'aiff': return encodeAiff(channels, sampleRate, opts.bits === 24 ? 24 : 16);
    default: return encodeWav(channels, sampleRate, opts.bits || 16);
  }
}
