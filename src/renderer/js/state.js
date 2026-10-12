// Central project state, event bus and undo history.
// Track audio (Float32Array channels) is treated as immutable, so an undo
// snapshot is just a shallow copy that keeps references to the old arrays.

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  listeners.get(evt)?.forEach((fn) => fn(data));
}

const COLORS = ['#8b7bff', '#2fd4c6', '#ff7aa8', '#ffb547', '#59a8ff', '#a6e35b', '#ff8a5c', '#c77dff'];

export const state = {
  sampleRate: 48000,
  tracks: [],
  /** Time selection in seconds; start === end means "just a cursor". */
  selection: { start: 0, end: 0 },
  selectedIds: new Set(),
  activeId: null,
  /** Time axis runs top → bottom: pps = pixels per second, scroll = time at the top, span = visible pixels. */
  view: { pps: 80, scroll: 0, span: 600 },
  loop: false,
  playing: false,
  recording: false,
  playhead: 0,
  clipboard: null,
  showProcessed: true,
};

// ---- Preferences (remembered between sessions) -------------------------------

const PREFS_KEY = 'tuffaudio.prefs';
const DEFAULT_PREFS = { showPresets: false, inspectorWidth: 360, autoScroll: true, smooth: true, exportFormat: 'mp3', exportQuality: {} };
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
export const prefs = loadPrefs();
export function setPref(key, value) {
  prefs[key] = value;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  emit('prefs', key);
}

/**
 * Move/zoom the view. With smooth animations on, the timeline eases toward the
 * target; otherwise it jumps. `anchor` keeps a time pinned under a pixel while zooming.
 */
export function animateView({ scroll, pps, anchor } = {}) {
  const v = state.view;
  if (!prefs.smooth) {
    v.target = null;
    if (pps) v.pps = pps;
    if (anchor) v.scroll = Math.max(0, anchor.time - anchor.px / v.pps);
    else if (scroll != null) v.scroll = scroll;
    emit('view');
    return;
  }
  const cur = v.target || { pps: v.pps, scroll: v.scroll, anchor: null };
  v.target = {
    pps: pps ?? cur.pps,
    scroll: scroll ?? cur.scroll,
    anchor: anchor ?? (scroll != null ? null : cur.anchor),
  };
}

let trackSeq = 0;
export function createTrack({ name, channels, effects = [], gainDb = 0, pan = 0, mute = false, solo = false, color, width = null }) {
  const n = trackSeq++;
  return {
    id: `t${Date.now().toString(36)}${n}`,
    name: name || `Track ${state.tracks.length + 1}`,
    color: color || COLORS[n % COLORS.length],
    channels, effects, gainDb, pan, mute, solo,
    width, // column width in px (null = default)
  };
}

export const getTrack = (id) => state.tracks.find((t) => t.id === id);
export const activeTrack = () => getTrack(state.activeId);
export const trackDuration = (t) => (t.channels[0]?.length ?? 0) / state.sampleRate;
export const projectDuration = () => state.tracks.reduce((m, t) => Math.max(m, trackDuration(t)), 0);
export const hasRange = () => state.selection.end - state.selection.start > 1e-6;
/** Tracks an edit should apply to: the selected ones, else the active one. */
export const targetTracks = () => {
  const sel = state.tracks.filter((t) => state.selectedIds.has(t.id));
  if (sel.length) return sel;
  const a = activeTrack();
  return a ? [a] : [];
};

// ---- Undo ------------------------------------------------------------------

const undoStack = [];
const redoStack = [];
const LIMIT = 100;

const snapshot = (label) => ({
  label,
  tracks: state.tracks.map((t) => ({ ...t, channels: [...t.channels], effects: structuredClone(t.effects) })),
  activeId: state.activeId,
  selectedIds: new Set(state.selectedIds),
  selection: { ...state.selection },
});

function restore(s) {
  state.tracks = s.tracks.map((t) => ({ ...t, channels: [...t.channels], effects: structuredClone(t.effects) }));
  state.activeId = s.activeId;
  state.selectedIds = new Set(s.selectedIds);
  state.selection = { ...s.selection };
}

/** Call BEFORE mutating the project. */
export function checkpoint(label) {
  undoStack.push(snapshot(label));
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
  emit('history');
}

export function undo() {
  const s = undoStack.pop();
  if (!s) return null;
  redoStack.push(snapshot(s.label));
  restore(s);
  emit('tracks');
  emit('selection');
  emit('history');
  return s.label;
}

export function redo() {
  const s = redoStack.pop();
  if (!s) return null;
  undoStack.push(snapshot(s.label));
  restore(s);
  emit('tracks');
  emit('selection');
  emit('history');
  return s.label;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const undoLabel = () => undoStack.at(-1)?.label;
export const redoLabel = () => redoStack.at(-1)?.label;
export function clearHistory() { undoStack.length = 0; redoStack.length = 0; emit('history'); }

// ---- Common mutations -------------------------------------------------------

export function setSelection(start, end = start) {
  if (end < start) [start, end] = [end, start];
  const max = Math.max(projectDuration(), 0);
  state.selection = { start: Math.max(0, Math.min(start, max)), end: Math.max(0, Math.min(end, max)) };
  emit('selection');
}

export function setActive(id, { additive = false } = {}) {
  state.activeId = id;
  if (!additive) state.selectedIds = new Set(id ? [id] : []);
  else if (id) state.selectedIds.add(id);
  emit('selection');
  emit('active');
}

export function addTrack(track, { select = true } = {}) {
  state.tracks.push(track);
  if (select) setActive(track.id);
  emit('tracks');
  return track;
}

/** Replace a track's audio (new channel arrays) and notify listeners. */
export function setTrackAudio(track, channels) {
  track.channels = channels;
  emit('audio', track.id);
}

export function effectsChanged(track, structural = true) {
  emit('effects', { id: track.id, structural });
}
