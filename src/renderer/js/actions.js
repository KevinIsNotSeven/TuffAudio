// Every user-facing command lives here, so toolbar buttons, keyboard shortcuts,
// menus and the command palette all share one implementation.

import {
  state, emit, checkpoint, undo as undoState, redo as undoRedo, createTrack, addTrack, setSelection, setActive,
  targetTracks, hasRange, projectDuration, activeTrack, getTrack, effectsChanged, clearHistory, canUndo, canRedo, undoLabel, redoLabel,
} from './state.js';
import * as E from './dsp/edit.js';
import { detectSilenceBounds } from './dsp/analysis.js';
import { encodeWav } from './dsp/wav.js';
import { serializeProject, deserializeProject } from './dsp/projectfile.js';
import { play, stop, seek, getCtx, decodeFile, renderMix, bakeEffects, enabledEffects, resample } from './audio/engine.js';
import { Recorder } from './audio/recorder.js';
import { EFFECTS, createEffect, PRESETS } from './audio/effects.js';
import { toast, modal, h, segmented, formatTime } from './ui/dom.js';

const sr = () => state.sampleRate;
const fr = (t) => Math.round(t * sr());
const sel = () => state.selection;
const needTracks = () => state.tracks.length > 0;
const needRange = () => hasRange() && targetTracks().length > 0;

export const actions = {};
function def(id, spec) { actions[id] = { id, enabled: () => true, ...spec }; }
export function run(id, ...args) {
  const a = actions[id];
  if (!a || !a.enabled()) return;
  return a.run(...args);
}

/** Apply an edit function to each target track. fn(track) returns new channels or null to skip. */
function editTracks(label, fn, tracks = targetTracks()) {
  if (!tracks.length) { toast('Select a track first', { type: 'warn' }); return false; }
  checkpoint(label);
  for (const t of tracks) {
    const out = fn(t);
    if (out) t.channels = out;
  }
  emit('tracks');
  return true;
}

// ---- Transport ------------------------------------------------------------------

def('play', {
  label: 'Play / Pause', icon: 'play', keys: 'Space', group: 'Transport',
  enabled: needTracks,
  run() {
    if (state.recording) return run('record');
    if (state.playing) { stop(); return; }
    play(state.playhead > sel().start && state.playhead < projectDuration() - 0.01 && !hasRange() ? state.playhead : undefined);
  },
});
def('stop', { label: 'Stop', icon: 'stop', group: 'Transport', run() { if (state.recording) return run('record'); stop(); state.playhead = sel().start; emit('playhead'); } });
def('home', { label: 'Go to start', icon: 'skipBack', keys: 'Home', group: 'Transport', run() { setSelection(0); seek(0); emit('playhead'); } });
def('end', { label: 'Go to end', icon: 'skipEnd', keys: 'End', group: 'Transport', run() { const d = projectDuration(); setSelection(d); seek(d); emit('playhead'); } });
def('loop', {
  label: 'Toggle loop', icon: 'loop', keys: 'L', group: 'Transport',
  run() {
    state.loop = !state.loop;
    emit('transport');
    if (state.playing) play(state.playhead);
    toast(state.loop ? (hasRange() ? 'Looping the selection' : 'Looping the whole project') : 'Loop off');
  },
});

// ---- Recording -------------------------------------------------------------------

export const recorder = new Recorder();
state.recordSource = 'in:default';
state.recordChannels = 2;

def('record', {
  label: 'Record', icon: 'record', keys: 'R', group: 'Transport',
  async run() {
    // Pressing record again while the input is still opening cancels the take.
    if (recorder.busy) { recorder.cancelPending = !state.recording; return; }
    recorder.busy = true;
    recorder.cancelPending = false;
    emit('transport');
    try {
      await toggleRecording();
      if (recorder.cancelPending && state.recording) {
        state.recording = false;
        await recorder.stop();
        stop();
        toast('Recording cancelled');
      }
    } finally {
      recorder.busy = false;
      recorder.cancelPending = false;
      emit('transport');
    }
  },
});

async function toggleRecording() {
  if (state.recording) {
    state.recording = false;
    const chs = await recorder.stop();
    stop();
    emit('transport');
    if (!chs || !chs[0].length) return;
    checkpoint('Record');
    const n = state.tracks.filter((t) => t.name.startsWith('Recording')).length + 1;
    const t = createTrack({ name: `Recording ${n}`, channels: E.padStart(chs, fr(state.recordStart)) });
    addTrack(t);
    setSelection(state.recordStart, state.recordStart + chs[0].length / sr());
    toast(`Recorded ${formatTime(chs[0].length / sr())}`);
    return;
  }
  if (state.playing) stop();
  try {
    await recorder.start({ sourceId: state.recordSource, channels: state.recordChannels });
  } catch (err) {
    console.error(err);
    toast(err.name === 'NotAllowedError' ? 'Recording permission was denied' : `Couldn't start recording: ${err.message}`, { type: 'error', timeout: 6000 });
    return;
  }
  state.recordStart = sel().start;
  state.recording = true;
  emit('transport');
  // Overdub: play the existing tracks while recording.
  if (state.tracks.length && state.recordStart < projectDuration()) play(state.recordStart);
}

// ---- History -----------------------------------------------------------------------

def('undo', {
  label: 'Undo', icon: 'undo', keys: 'Mod+Z', group: 'Edit', enabled: canUndo,
  run() { const l = undoState(); if (l) toast(`Undid ${l}`); },
  dynamicLabel: () => (canUndo() ? `Undo ${undoLabel()}` : 'Undo'),
});
def('redo', {
  label: 'Redo', icon: 'redo', keys: 'Mod+Shift+Z', group: 'Edit', enabled: canRedo,
  run() { const l = undoRedo(); if (l) toast(`Redid ${l}`); },
  dynamicLabel: () => (canRedo() ? `Redo ${redoLabel()}` : 'Redo'),
});

// ---- Selection ---------------------------------------------------------------------

def('selectAll', {
  label: 'Select all', keys: 'Mod+A', group: 'Select', enabled: needTracks,
  run() { state.selectedIds = new Set(state.tracks.map((t) => t.id)); setSelection(0, projectDuration()); },
});
def('deselect', { label: 'Clear selection', keys: 'Escape', group: 'Select', run() { setSelection(sel().start); } });

// ---- Quick edits ---------------------------------------------------------------------

def('trim', {
  label: 'Trim to selection', icon: 'crop', keys: 'Mod+T', group: 'Edit', enabled: needRange,
  description: 'Keep only the selected part',
  run() {
    const { start, end } = sel();
    if (editTracks('Trim', (t) => E.slice(t.channels, fr(start), fr(end)))) {
      setSelection(0, end - start);
      toast('Trimmed to selection');
    }
  },
});
def('delete', {
  label: 'Delete selection', icon: 'trash', keys: 'Delete', group: 'Edit', enabled: needRange,
  run() {
    const { start, end } = sel();
    if (editTracks('Delete', (t) => E.remove(t.channels, fr(start), fr(end)))) setSelection(start);
  },
});
def('cut', {
  label: 'Cut', icon: 'scissors', keys: 'Mod+X', group: 'Edit', enabled: needRange,
  run() { run('copy', true); run('delete'); },
});
def('copy', {
  label: 'Copy', icon: 'copy', keys: 'Mod+C', group: 'Edit', enabled: needRange,
  run(quiet) {
    const t = targetTracks()[0];
    state.clipboard = E.slice(t.channels, fr(sel().start), fr(sel().end));
    if (!quiet) toast(`Copied ${formatTime(state.clipboard[0].length / sr())}`);
  },
});
def('paste', {
  label: 'Paste', icon: 'paste', keys: 'Mod+V', group: 'Edit', enabled: () => !!state.clipboard,
  run() {
    const clip = state.clipboard;
    const { start, end } = sel();
    if (!targetTracks().length) {
      checkpoint('Paste');
      addTrack(createTrack({ name: 'Pasted audio', channels: E.padStart(clip, fr(start)) }));
      return;
    }
    if (editTracks('Paste', (t) => {
      const padded = E.padEnd(t.channels, fr(start));
      return hasRange() ? E.replace(padded, fr(start), fr(end), clip) : E.insert(padded, fr(start), clip);
    })) setSelection(start, start + clip[0].length / sr());
  },
});
def('silence', {
  label: 'Silence selection', icon: 'silence', keys: 'Mod+L', group: 'Edit', enabled: needRange,
  run() { editTracks('Silence', (t) => E.silence(t.channels, fr(sel().start), fr(sel().end))); },
});
def('duplicate', {
  label: 'Copy selection to new track', icon: 'split', keys: 'Mod+D', group: 'Edit', enabled: needRange,
  run() {
    const t = targetTracks()[0];
    const { start, end } = sel();
    checkpoint('Selection to new track');
    const clip = E.slice(t.channels, fr(start), fr(end));
    addTrack(createTrack({ name: `${t.name} (part)`, channels: E.padStart(clip, fr(start)) }));
  },
});
def('fadeIn', {
  label: 'Fade in', icon: 'fadeIn', group: 'Edit', enabled: () => targetTracks().length > 0,
  description: 'Fades the selection, or adds a Fade In effect if nothing is selected',
  run() {
    if (hasRange()) return editTracks('Fade in', (t) => E.fade(t.channels, fr(sel().start), fr(sel().end), 'in'));
    addEffect('fadeIn');
  },
});
def('fadeOut', {
  label: 'Fade out', icon: 'fadeOut', group: 'Edit', enabled: () => targetTracks().length > 0,
  description: 'Fades the selection, or adds a Fade Out effect if nothing is selected',
  run() {
    if (hasRange()) return editTracks('Fade out', (t) => E.fade(t.channels, fr(sel().start), fr(sel().end), 'out'));
    addEffect('fadeOut');
  },
});
def('autoTrim', {
  label: 'Auto-trim silence', icon: 'wand', keys: 'Mod+Shift+T', group: 'Edit', enabled: () => targetTracks().length > 0,
  description: 'Cut silence from the start and end',
  run() {
    let cut = 0;
    editTracks('Auto-trim', (t) => {
      const b = detectSilenceBounds(t.channels, sr(), -48);
      if (!b) return null;
      cut += t.channels[0].length - (b[1] - b[0]);
      return E.slice(t.channels, b[0], b[1]);
    });
    setSelection(0);
    toast(cut ? `Removed ${formatTime(cut / sr())} of silence` : 'No silence found at the edges');
  },
});
def('reverseSel', {
  label: 'Reverse selection', icon: 'reverse', group: 'Edit', enabled: needRange,
  run() { editTracks('Reverse', (t) => E.reverse(t.channels, fr(sel().start), fr(sel().end))); },
});

// ---- Mono / stereo --------------------------------------------------------------------

def('toMono', {
  label: 'Convert to mono', icon: 'mono', group: 'Channels', enabled: () => targetTracks().some((t) => t.channels.length > 1),
  run(mode = 'mix') {
    const names = { mix: 'mixed both channels', left: 'kept left channel', right: 'kept right channel' };
    if (editTracks('Convert to mono', (t) => (t.channels.length > 1 ? E.toMono(t.channels, mode) : null))) toast(`Mono: ${names[mode]}`);
  },
});
def('toStereo', {
  label: 'Convert to stereo', icon: 'stereo', group: 'Channels', enabled: () => targetTracks().some((t) => t.channels.length === 1),
  run() { if (editTracks('Convert to stereo', (t) => (t.channels.length === 1 ? E.toStereo(t.channels) : null))) toast('Converted to stereo'); },
});
def('swap', {
  label: 'Swap left / right', icon: 'swap', group: 'Channels', enabled: () => targetTracks().some((t) => t.channels.length > 1),
  run() { editTracks('Swap channels', (t) => E.swapChannels(t.channels)); },
});
def('splitStereo', {
  label: 'Split stereo into two mono tracks', icon: 'split', group: 'Channels', enabled: () => activeTrack()?.channels.length > 1,
  run() {
    const t = activeTrack();
    checkpoint('Split stereo');
    const i = state.tracks.indexOf(t);
    const l = createTrack({ name: `${t.name} L`, channels: [t.channels[0]], effects: structuredClone(t.effects), pan: -1, gainDb: t.gainDb });
    const r = createTrack({ name: `${t.name} R`, channels: [t.channels[1]], effects: structuredClone(t.effects), pan: 1, gainDb: t.gainDb });
    state.tracks.splice(i, 1, l, r);
    setActive(l.id);
    emit('tracks');
  },
});
def('joinStereo', {
  label: 'Join two mono tracks into stereo', icon: 'layers', group: 'Channels',
  enabled: () => { const s = targetTracks(); return s.length === 2 && s.every((t) => t.channels.length === 1); },
  run() {
    const [a, b] = targetTracks();
    checkpoint('Join to stereo');
    const n = Math.max(a.channels[0].length, b.channels[0].length);
    const t = createTrack({ name: `${a.name} + ${b.name}`, channels: [...E.padEnd(a.channels, n), ...E.padEnd(b.channels, n)], effects: structuredClone(a.effects) });
    const i = state.tracks.indexOf(a);
    state.tracks = state.tracks.filter((x) => x !== a && x !== b);
    state.tracks.splice(i, 0, t);
    setActive(t.id);
    emit('tracks');
  },
});

// ---- Tracks ---------------------------------------------------------------------------

def('deleteTrack', {
  label: 'Delete track', icon: 'trash', keys: 'Mod+Backspace', group: 'Track', enabled: () => targetTracks().length > 0,
  run(id) {
    const ids = id ? [id] : targetTracks().map((t) => t.id);
    checkpoint(ids.length > 1 ? 'Delete tracks' : 'Delete track');
    state.tracks = state.tracks.filter((t) => !ids.includes(t.id));
    setActive(state.tracks.at(-1)?.id ?? null);
    emit('tracks');
  },
});
def('duplicateTrack', {
  label: 'Duplicate track', icon: 'copy', group: 'Track', enabled: () => !!activeTrack(),
  run(id) {
    const t = id ? getTrack(id) : activeTrack();
    checkpoint('Duplicate track');
    const copy = createTrack({ ...t, name: `${t.name} copy`, color: undefined, effects: t.effects.map((e) => createEffect(e.type, e.params)) });
    state.tracks.splice(state.tracks.indexOf(t) + 1, 0, copy);
    setActive(copy.id);
    emit('tracks');
  },
});
def('muteTrack', {
  label: 'Mute track', keys: 'M', group: 'Track', enabled: () => !!activeTrack(),
  run(id) { const t = id ? getTrack(id) : activeTrack(); t.mute = !t.mute; emit('trackprops', t.id); },
});
def('soloTrack', {
  label: 'Solo track', keys: 'S', group: 'Track', enabled: () => !!activeTrack(),
  run(id) { const t = id ? getTrack(id) : activeTrack(); t.solo = !t.solo; emit('trackprops', t.id); },
});
def('moveTrack', {
  label: 'Move track', group: 'Track', enabled: () => !!activeTrack(),
  run(id, dir) {
    const i = state.tracks.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.tracks.length) return;
    checkpoint('Move track');
    const [t] = state.tracks.splice(i, 1);
    state.tracks.splice(j, 0, t);
    emit('tracks');
  },
});

// ---- Effects (modifiers) -----------------------------------------------------------------

export function addEffect(type, params = {}, track = activeTrack()) {
  if (!track) { toast('Select a track first', { type: 'warn' }); return null; }
  checkpoint(`Add ${EFFECTS[type].name}`);
  const fx = createEffect(type, params);
  track.effects.push(fx);
  effectsChanged(track);
  emit('effects-ui', { id: track.id, focus: fx.id });
  return fx;
}

export function addPreset(preset, track = activeTrack()) {
  if (!track) return;
  checkpoint(`Preset ${preset.name}`);
  for (const [type, p] of preset.stack) track.effects.push(createEffect(type, p));
  effectsChanged(track);
  emit('effects-ui', { id: track.id });
  toast(`Added “${preset.name}” — tweak or disable any step`);
}

/** Bake one effect (Blender-style "Apply"): renders it into the audio and removes it from the stack. */
export async function applyEffect(track, fxId, { selectionOnly = false } = {}) {
  const fx = track.effects.find((e) => e.id === fxId);
  if (!fx) return;
  const first = track.effects[0] === fx;
  const range = selectionOnly && hasRange() ? [fr(sel().start), fr(sel().end)] : null;
  const busy = toast(`Applying ${EFFECTS[fx.type].name}…`, { type: 'busy', timeout: 0 });
  try {
    const out = await bakeEffects(track, [fx], range);
    checkpoint(`Apply ${EFFECTS[fx.type].name}`);
    track.channels = out;
    if (!range) track.effects = track.effects.filter((e) => e !== fx);
    emit('tracks');
    emit('effects-ui', { id: track.id });
    busy.close();
    toast(range ? `${EFFECTS[fx.type].name} applied to the selection` : `${EFFECTS[fx.type].name} applied${first ? '' : ' (out of stack order)'}`);
  } catch (e) {
    busy.close();
    toast(`Apply failed: ${e.message}`, { type: 'error' });
  }
}

def('applyAll', {
  label: 'Apply all effects on track', icon: 'check', group: 'Effects', enabled: () => !!activeTrack() && enabledEffects(activeTrack()).length > 0,
  async run() {
    const track = activeTrack();
    const fx = enabledEffects(track);
    const busy = toast('Rendering effect stack…', { type: 'busy', timeout: 0 });
    const out = await bakeEffects(track, fx);
    busy.close();
    checkpoint('Apply all effects');
    track.channels = out;
    track.effects = track.effects.filter((e) => !fx.includes(e));
    emit('tracks');
    emit('effects-ui', { id: track.id });
    toast(`Baked ${fx.length} effect${fx.length > 1 ? 's' : ''} into the audio`);
  },
});
def('toggleProcessed', {
  label: 'Show effect result in waveform', icon: 'eye', keys: 'V', group: 'View',
  run() { state.showProcessed = !state.showProcessed; emit('view'); toast(state.showProcessed ? 'Showing processed waveform' : 'Showing original waveform'); },
});
for (const [type, def_] of Object.entries(EFFECTS)) {
  def(`fx:${type}`, { label: `Add effect: ${def_.name}`, icon: def_.icon, group: 'Effects', enabled: () => !!activeTrack(), run: () => addEffect(type) });
}
for (const p of PRESETS) def(`preset:${p.name}`, { label: `Add preset: ${p.name}`, icon: 'sparkles', group: 'Effects', enabled: () => !!activeTrack(), run: () => addPreset(p) });

// ---- View ---------------------------------------------------------------------------------

export function zoomAround(factor, time = null) {
  const v = state.view;
  const t = time ?? (state.playing ? state.playhead : (sel().start + sel().end) / 2);
  const px = (t - v.scrollX) * v.pps;
  v.pps = Math.max(2, Math.min(sr() * 2, v.pps * factor));
  v.scrollX = Math.max(0, t - px / v.pps);
  emit('view');
}
def('zoomIn', { label: 'Zoom in', icon: 'zoomIn', keys: '=', group: 'View', run: () => zoomAround(1.5) });
def('zoomOut', { label: 'Zoom out', icon: 'zoomOut', keys: '-', group: 'View', run: () => zoomAround(1 / 1.5) });
def('zoomFit', {
  label: 'Zoom to fit', icon: 'fit', keys: 'Mod+0', group: 'View',
  run() {
    const d = projectDuration() || 10;
    state.view.pps = Math.max(2, (state.view.width - 24) / d);
    state.view.scrollX = 0;
    emit('view');
  },
});
def('zoomSel', {
  label: 'Zoom to selection', icon: 'zoomIn', keys: 'Mod+E', group: 'View', enabled: hasRange,
  run() {
    const { start, end } = sel();
    state.view.pps = Math.min(sr() * 2, (state.view.width - 24) / (end - start));
    state.view.scrollX = start;
    emit('view');
  },
});

// ---- Files -------------------------------------------------------------------------------

state.projectName = 'Untitled';

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

async function saveBinary(data, name, filters) {
  if (window.tuffNative?.saveFile) return window.tuffNative.saveFile({ defaultPath: name, filters, data });
  const url = URL.createObjectURL(new Blob([data]));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

const stripExt = (n) => n.replace(/\.[^.]+$/, '');

export async function importFiles(files) {
  getCtx();
  for (const f of files) {
    if (/\.tuff$/i.test(f.name)) { await openProjectFile(f); continue; }
    const busy = toast(`Importing ${f.name}…`, { type: 'busy', timeout: 0 });
    try {
      const channels = await decodeFile(f);
      checkpoint('Import');
      const first = !state.tracks.length;
      addTrack(createTrack({ name: stripExt(f.name), channels }));
      if (first) { state.projectName = stripExt(f.name); emit('project'); run('zoomFit'); }
      busy.close();
      toast(`Imported ${f.name} · ${channels.length === 1 ? 'mono' : 'stereo'} · ${formatTime(channels[0].length / sr())}`);
    } catch (e) {
      busy.close();
      toast(`Couldn't read ${f.name}: unsupported or damaged audio`, { type: 'error', timeout: 5000 });
    }
  }
}

def('import', {
  label: 'Import audio…', icon: 'import', keys: 'Mod+I', group: 'File',
  async run() { importFiles(await pickFiles('audio/*,video/*,.wav,.mp3,.flac,.ogg,.oga,.opus,.m4a,.aac,.webm,.tuff')); },
});

async function openProjectFile(file) {
  try {
    const proj = deserializeProject(await file.arrayBuffer());
    getCtx();
    stop();
    const tracks = [];
    for (const t of proj.tracks) {
      const channels = await resample(t.channels, proj.sampleRate);
      tracks.push(createTrack({ ...t, channels, effects: t.effects.filter((e) => EFFECTS[e.type]).map((e) => ({ ...createEffect(e.type, e.params), enabled: e.enabled, collapsed: e.collapsed })) }));
    }
    state.tracks = tracks;
    state.projectName = stripExt(file.name);
    clearHistory();
    setActive(tracks[0]?.id ?? null);
    setSelection(0);
    emit('tracks');
    emit('project');
    run('zoomFit');
    toast(`Opened ${file.name}`);
  } catch (e) {
    toast(`Couldn't open project: ${e.message}`, { type: 'error' });
  }
}

def('open', {
  label: 'Open project…', icon: 'folder', keys: 'Mod+O', group: 'File',
  async run() { const [f] = await pickFiles('.tuff', false); if (f) openProjectFile(f); },
});
def('save', {
  label: 'Save project…', icon: 'save', keys: 'Mod+S', group: 'File', enabled: needTracks,
  async run() {
    const data = serializeProject({ sampleRate: sr(), tracks: state.tracks });
    const where = await saveBinary(data, `${state.projectName}.tuff`, [{ name: 'TuffAudio project', extensions: ['tuff'] }]);
    if (where) toast('Project saved — effects stay editable');
  },
});
def('new', {
  label: 'New project', icon: 'file', keys: 'Mod+N', group: 'File',
  run() {
    stop();
    checkpoint('New project');
    state.tracks = [];
    state.projectName = 'Untitled';
    setActive(null);
    setSelection(0);
    emit('tracks');
    emit('project');
  },
});

def('export', {
  label: 'Export audio…', icon: 'export', keys: 'Mod+Shift+E', group: 'File', enabled: needTracks,
  run() {
    const opts = { bits: 16, channels: 2, range: hasRange() ? 'selection' : 'all' };
    const allMono = state.tracks.every((t) => t.channels.length === 1 && Math.abs(t.pan) < 0.01 && !t.effects.some((e) => e.enabled && ['pan', 'width', 'chorus'].includes(e.type)));
    if (allMono) opts.channels = 1;
    const nameInput = h('input.text', { value: state.projectName, spellcheck: false });
    const row = (label, ctrl, hint) => h('div.form-row', {}, h('label', {}, label), h('div', {}, ctrl, hint ? h('small.hint', {}, hint) : null));
    const body = h('div.form', {},
      row('File name', h('div.input-suffix', {}, nameInput, h('span', {}, '.wav'))),
      row('Channels', segmented([[2, 'Stereo', 'stereo'], [1, 'Mono', 'mono']], opts.channels, (v) => (opts.channels = v)), allMono ? 'All tracks are mono, so mono is pre-selected.' : 'Mono mixes left and right together.'),
      row('Quality', segmented([[16, '16-bit'], [24, '24-bit'], [32, '32-bit float']], opts.bits, (v) => (opts.bits = v)), '16-bit is CD quality and works everywhere.'),
      row('Range', segmented([['all', 'Whole project'], ['selection', 'Selection']], opts.range, (v) => (opts.range = v))),
      h('p.note', {}, 'All enabled effects, volume and pan are rendered into the file. Your project stays editable.'),
    );
    modal({
      title: 'Export audio', body,
      actions: [{ label: 'Cancel' }, { label: 'Export', primary: true, run: () => { doExport({ ...opts, name: nameInput.value.trim() || 'Untitled' }); } }],
    });
  },
});

async function doExport({ bits, channels, range, name }) {
  const s = range === 'selection' && hasRange() ? sel() : { start: 0, end: projectDuration() };
  const busy = toast('Rendering…', { type: 'busy', timeout: 0 });
  try {
    const out = await renderMix({ start: s.start, end: s.end, channels });
    const wav = encodeWav(out, sr(), bits);
    busy.close();
    const where = await saveBinary(wav, `${name}.wav`, [{ name: 'WAV audio', extensions: ['wav'] }]);
    if (where) toast(`Exported ${name}.wav · ${channels === 1 ? 'mono' : 'stereo'} · ${formatTime(s.end - s.start)}`);
  } catch (e) {
    busy.close();
    toast(`Export failed: ${e.message}`, { type: 'error' });
  }
}

def('palette', { label: 'Command palette', icon: 'command', keys: 'Mod+K', group: 'Help', run: () => emit('palette') });
def('shortcuts', { label: 'Keyboard shortcuts', icon: 'keyboard', keys: '?', group: 'Help', run: () => emit('shortcuts') });

// ---- Demo clip -------------------------------------------------------------------------------

/** Synthesises a short stereo groove (with silence at both ends, so Auto-trim has something to do). */
export function synthDemo(rate) {
  const lead = 0.6, tail = 0.8, bars = 4, beat = 0.5;
  const body = bars * 4 * beat;
  const n = Math.round((lead + body + tail) * rate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const add = (t0, dur, fn, pan = 0) => {
    const s0 = Math.round((lead + t0) * rate), len = Math.round(dur * rate);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < len && s0 + i < n; i++) { const v = fn(i / rate); L[s0 + i] += v * gl; R[s0 + i] += v * gr; }
  };
  const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66], [164.81, 207.65, 246.94]];
  chords.forEach((ch, bar) => {
    for (let step = 0; step < 8; step++) {
      const f = ch[step % 3] * (step % 4 === 3 ? 2 : 1);
      add(bar * 2 + step * 0.25, 0.6, (t) => 0.16 * Math.exp(-t * 7) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)), step % 2 ? 0.5 : -0.5);
    }
    add(bar * 2, 2, (t) => 0.07 * Math.min(1, t * 8) * Math.exp(-t * 0.8) * ch.reduce((a, f) => a + Math.sin(Math.PI * f * t), 0));
    for (let b = 0; b < 4; b++) {
      add(bar * 2 + b * beat, 0.35, (t) => 0.5 * Math.exp(-t * 14) * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 30)) * t));
      add(bar * 2 + b * beat + 0.25, 0.08, (t) => 0.06 * Math.exp(-t * 60) * (Math.random() * 2 - 1), 0.3);
    }
  });
  return [L, R];
}

def('demo', {
  label: 'Add demo clip', icon: 'sparkles', group: 'File',
  run() {
    getCtx();
    checkpoint('Demo clip');
    addTrack(createTrack({ name: 'Demo groove', channels: synthDemo(sr()) }));
    if (state.tracks.length === 1) { state.projectName = 'Demo'; emit('project'); }
    run('zoomFit');
    toast('Demo clip added — try selecting a region, Trim, or adding effects');
  },
});
