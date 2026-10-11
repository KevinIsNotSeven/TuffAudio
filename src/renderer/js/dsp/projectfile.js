// .tuff project format: "TUFF" magic, u32 version, u32 JSON byte length, JSON, then
// raw little-endian float32 channel data in the order listed in the JSON.
// Effects are stored as parameters, so the stack stays non-destructive across saves.

const MAGIC = 'TUFF';
const VERSION = 1;

export function serializeProject({ sampleRate, tracks }) {
  const meta = {
    app: 'TuffAudio',
    sampleRate,
    tracks: tracks.map((t) => ({
      name: t.name, color: t.color, gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo, width: t.width ?? null,
      frames: t.channels[0]?.length ?? 0, channels: t.channels.length,
      effects: t.effects.map(({ type, enabled, params, collapsed }) => ({ type, enabled, params, collapsed })),
    })),
  };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const dataBytes = tracks.reduce((a, t) => a + t.channels.length * (t.channels[0]?.length ?? 0) * 4, 0);
  const pad = (4 - ((12 + json.length) % 4)) % 4; // keep float data 4-byte aligned
  const buf = new ArrayBuffer(12 + json.length + pad + dataBytes);
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  for (let i = 0; i < 4; i++) u8[i] = MAGIC.charCodeAt(i);
  v.setUint32(4, VERSION, true);
  v.setUint32(8, json.length + pad, true);
  u8.set(json, 12);
  u8.fill(0x20, 12 + json.length, 12 + json.length + pad);
  let o = 12 + json.length + pad;
  for (const t of tracks) for (const c of t.channels) {
    new Float32Array(buf, o, c.length).set(c);
    o += c.length * 4;
  }
  return buf;
}

export function deserializeProject(buf) {
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== MAGIC) throw new Error('Not a TuffAudio project file');
  const jsonLen = v.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jsonLen)));
  let o = 12 + jsonLen;
  const tracks = meta.tracks.map((t) => {
    const channels = [];
    for (let c = 0; c < t.channels; c++) {
      channels.push(new Float32Array(buf.slice(o, o + t.frames * 4)));
      o += t.frames * 4;
    }
    return { ...t, channels };
  });
  return { sampleRate: meta.sampleRate, tracks };
}
