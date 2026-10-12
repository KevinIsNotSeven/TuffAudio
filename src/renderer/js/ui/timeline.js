// Timeline: time runs top → bottom, tracks are side-by-side columns.
// The scroll wheel moves through time; Shift+wheel scrolls across tracks;
// Ctrl/⌘+wheel zooms. Columns can be resized by dragging their right edge.

import { state, on, emit, setSelection, setActive, hasRange, projectDuration, trackDuration, checkpoint, getTrack, prefs, animateView } from '../state.js';
import { peaks, PEAK_BLOCK } from '../dsp/analysis.js';
import { previews, seek, tick } from '../audio/engine.js';
import { run, recorder, zoomAround } from '../actions.js';
import { $, $$, h, iconEl, popover, formatTime } from './dom.js';

export const HEAD_H = 138;
export const COL_W = 260;
const COL_MIN = 150, COL_MAX = 900;
let area, scroller, colsEl, rulerCv, playheadEl, vbar, vthumb, emptyEl;
const dpr = () => window.devicePixelRatio || 1;

// "pos" = pixels along the time axis (downwards from the top of the lanes).
const posToTime = (y) => state.view.scroll + y / state.view.pps;
const timeToPos = (t) => (t - state.view.scroll) * state.view.pps;

export function initTimeline() {
  area = $('#timeline');
  scroller = $('#tracksScroll');
  colsEl = $('#tracks');
  rulerCv = $('#ruler');
  playheadEl = $('#playhead');
  vbar = $('#vscroll');
  vthumb = $('#vscroll .thumb');
  emptyEl = $('#emptyState');

  new ResizeObserver(layout).observe(area);
  setupRuler();
  setupWheel();
  setupScrollbar();

  on('tracks', renderColumns);
  on('audio', () => drawAll());
  on('preview', (id) => drawTrack(id));
  on('selection', () => { updateColumnStates(); drawAll(); drawRuler(); });
  on('active', updateColumnStates);
  on('trackprops', updateColumnStates);
  on('effects', updateColumnStates);
  on('effects-ui', updateColumnStates);
  on('view', () => { clampScroll(); drawAll(); drawRuler(); updateScrollbar(); });
  on('transport', onTransport);

  renderColumns();
  requestAnimationFrame(frame);
}

// ---- Layout -------------------------------------------------------------------

function layout() {
  const lane = colsEl.querySelector('.lane');
  state.view.span = Math.max(100, lane ? lane.clientHeight : rulerCv.clientHeight);
  for (const cv of $$('canvas.wave', colsEl)) sizeCanvas(cv);
  sizeCanvas(rulerCv);
  clampScroll();
  drawAll();
  drawRuler();
  updateScrollbar();
}

function sizeCanvas(cv) {
  const w = cv.clientWidth, hgt = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr()) || cv.height !== Math.round(hgt * dpr())) {
    cv.width = Math.round(w * dpr());
    cv.height = Math.round(hgt * dpr());
  }
}

function contentDuration() {
  return Math.max(projectDuration() + 2, state.view.span / state.view.pps);
}

function clampScroll() {
  const max = Math.max(0, contentDuration() - state.view.span / state.view.pps);
  state.view.scroll = Math.max(0, Math.min(max, state.view.scroll));
}

// ---- Track columns ------------------------------------------------------------

function renderColumns() {
  const left = scroller.scrollLeft;
  colsEl.replaceChildren(...state.tracks.map(columnFor));
  if (state.recording) colsEl.append(recordingColumn());
  emptyEl.hidden = state.tracks.length > 0 || state.recording;
  layout();
  updateColumnStates();
  scroller.scrollLeft = left;
}

function slider({ min, max, step, value, onStart, onInput, onReset, cls = '' }) {
  const el = h(`input.mini-range${cls ? '.' + cls : ''}`, { type: 'range', min, max, step, value });
  el.addEventListener('pointerdown', onStart);
  el.addEventListener('input', () => onInput(Number(el.value)));
  el.addEventListener('dblclick', () => { onStart(); onReset(); });
  return el;
}

const fmtPan = (p) => (Math.abs(p) < 0.01 ? 'C' : `${Math.round(Math.abs(p) * 100)}${p < 0 ? 'L' : 'R'}`);
const fmtDb = (d) => (d <= -36 ? '−∞' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`);

function columnFor(t) {
  // The name is read-only until double-clicked, so a single click just selects the track.
  const name = h('input.track-name', { value: t.name, spellcheck: false, readOnly: true, tabIndex: -1, title: 'Double-click to rename · drag to move' });
  const finishRename = (commit) => {
    if (name.readOnly) return;
    const v = name.value.trim();
    name.readOnly = true;
    name.tabIndex = -1;
    if (commit && v && v !== t.name) { checkpoint('Rename'); t.name = v; emit('trackprops', t.id); emit('effects-ui', { id: t.id }); }
    else name.value = t.name;
    window.getSelection()?.removeAllRanges();
  };
  name.addEventListener('dblclick', () => {
    name.readOnly = false;
    name.tabIndex = 0;
    name.focus();
    name.select();
  });
  name.addEventListener('blur', () => finishRename(true));
  name.addEventListener('keydown', (e) => {
    if (!name.readOnly) {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') { finishRename(false); name.blur(); }
      e.stopPropagation();
    }
  });

  const volVal = h('span.val', {}, fmtDb(t.gainDb));
  const panVal = h('span.val', {}, fmtPan(t.pan));
  let marked = false;
  const mark = (label) => () => { if (!marked) { checkpoint(label); marked = true; } };
  const unmark = () => { marked = false; };
  const vol = slider({ min: -36, max: 12, step: 0.1, value: t.gainDb, onStart: mark('Volume'),
    onInput: (v) => { t.gainDb = v; volVal.textContent = fmtDb(v); emit('trackprops', t.id); },
    onReset: () => { t.gainDb = 0; vol.value = 0; volVal.textContent = fmtDb(0); emit('trackprops', t.id); } });
  const pan = slider({ min: -1, max: 1, step: 0.01, value: t.pan, cls: 'center', onStart: mark('Pan'),
    onInput: (v) => { t.pan = v; panVal.textContent = fmtPan(v); emit('trackprops', t.id); },
    onReset: () => { t.pan = 0; pan.value = 0; panVal.textContent = fmtPan(0); emit('trackprops', t.id); } });
  vol.addEventListener('change', unmark);
  pan.addEventListener('change', unmark);

  const chan = h('button.chip.chan', { title: 'Mono / stereo', onclick: (e) => channelMenu(t, e.currentTarget) });
  const fx = h('button.chip.fx', { title: 'Effects on this track', onclick: () => { setActive(t.id); emit('focus-inspector'); } });

  const head = h('div.track-head', {},
    h('div.color', { style: { background: t.color } }),
    h('div.th-row', {}, name,
      h('button.more-btn', { title: 'Track options', onclick: (e) => trackMenu(t, e.currentTarget) }, iconEl('more'))),
    h('div.th-row.btns', {},
      h('button.tog.mute', { title: 'Mute (M)', onclick: () => run('muteTrack', t.id) }, 'M'),
      h('button.tog.solo', { title: 'Solo (S)', onclick: () => run('soloTrack', t.id) }, 'S'),
      chan, fx),
    h('div.th-row.slider-row', {}, iconEl('gain'), vol, volVal),
    h('div.th-row.slider-row', {}, iconEl('pan'), pan, panVal),
  );
  const cv = h('canvas.wave');
  const lane = h('div.lane', {}, cv);
  setupLane(lane, cv, t.id);
  const col = h('div.track-col', { 'data-id': t.id, style: { width: `${t.width || COL_W}px` } }, head, lane);
  col.append(resizeHandle(col, t));
  setupColumnDrag(head, col, t);
  return col;
}

// Controls inside a header that should never start a track drag.
const HEAD_CONTROLS = 'button, input[type=range], input:not([readonly])';

/** Click a header to select the track; drag it sideways to move the track. */
function setupColumnDrag(head, col, t) {
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest(HEAD_CONTROLS)) return;
    setActive(t.id, { additive: e.shiftKey || e.metaKey || e.ctrlKey });
    const x0 = e.clientX;
    const from = state.tracks.indexOf(t);
    let dragging = false, to = from, scrollTimer = null;
    const others = () => $$('.track-col:not(.recording)', colsEl).filter((c) => c !== col);
    const clearMarks = () => others().forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!dragging) {
        if (Math.abs(dx) < 6) return;
        dragging = true;
        head.setPointerCapture(e.pointerId);
        col.classList.add('dragging');
        document.body.classList.add('dragging-track');
      }
      col.style.transform = `translateX(${dx + (scroller.scrollLeft - left0)}px)`;
      const cols = others();
      to = cols.filter((c) => { const r = c.getBoundingClientRect(); return r.left + r.width / 2 < ev.clientX; }).length;
      clearMarks();
      if (cols.length) {
        if (to < cols.length) cols[to].classList.add('drop-before');
        else cols.at(-1).classList.add('drop-after');
      }
      // Scroll the track strip when dragging near its edges.
      clearInterval(scrollTimer);
      const r = scroller.getBoundingClientRect();
      const edge = ev.clientX < r.left + 40 ? -12 : ev.clientX > r.right - 40 ? 12 : 0;
      if (edge) scrollTimer = setInterval(() => { scroller.scrollLeft += edge; }, 16);
    };
    const left0 = scroller.scrollLeft;
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      clearInterval(scrollTimer);
      if (!dragging) return;
      clearMarks();
      col.classList.remove('dragging');
      col.style.transform = '';
      document.body.classList.remove('dragging-track');
      if (to !== from) run('reorderTrack', t.id, to);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}

/** Drag the right edge of a column to resize it; double-click resets. */
function resizeHandle(col, t) {
  const grip = h('div.col-resize', { title: 'Drag to resize · double-click to reset' });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = col.offsetWidth;
    document.body.classList.add('resizing-col');
    const move = (ev) => {
      t.width = Math.max(COL_MIN, Math.min(COL_MAX, Math.round(w0 + ev.clientX - x0)));
      col.style.width = `${t.width}px`;
      const cv = col.querySelector('canvas.wave');
      sizeCanvas(cv);
      drawCol(col);
    };
    const up = () => {
      document.body.classList.remove('resizing-col');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => {
    t.width = null;
    col.style.width = `${COL_W}px`;
    sizeCanvas(col.querySelector('canvas.wave'));
    drawCol(col);
  });
  return grip;
}

function recordingColumn() {
  const cv = h('canvas.wave');
  return h('div.track-col.recording', { 'data-id': '__rec', style: { width: `${COL_W}px` } },
    h('div.track-head', {},
      h('div.color', { style: { background: 'var(--rec)' } }),
      h('div.th-row', {}, h('span.rec-dot'), h('span.rec-title', {}, 'Recording…')),
      h('div.th-row', {}, h('span.rec-time', {}, '00:00.000')),
      h('div.th-row', {}, h('div.meter.rec-meter', {}, h('div.fill')))),
    h('div.lane', {}, cv));
}

function channelMenu(t, anchor) {
  setActive(t.id);
  const stereo = t.channels.length > 1;
  popover(anchor, stereo ? [
    { heading: 'Stereo track' },
    { label: 'Make mono — mix both sides', icon: 'mono', run: () => run('toMono', 'mix') },
    { label: 'Make mono — keep left', icon: 'mono', run: () => run('toMono', 'left') },
    { label: 'Make mono — keep right', icon: 'mono', run: () => run('toMono', 'right') },
    { separator: true },
    { label: 'Swap left / right', icon: 'swap', run: () => run('swap') },
    { label: 'Split into two mono tracks', icon: 'split', run: () => run('splitStereo') },
  ] : [
    { heading: 'Mono track' },
    { label: 'Make stereo (copy to both sides)', icon: 'stereo', run: () => run('toStereo') },
  ]);
}

function trackMenu(t, anchor) {
  setActive(t.id);
  const i = state.tracks.indexOf(t);
  popover(anchor, [
    { label: 'Duplicate track', icon: 'copy', run: () => run('duplicateTrack', t.id) },
    { label: 'Move left', icon: 'arrowLeft', disabled: i === 0, run: () => run('moveTrack', t.id, -1) },
    { label: 'Move right', icon: 'arrowRight', disabled: i === state.tracks.length - 1, run: () => run('moveTrack', t.id, 1) },
    { separator: true },
    t.channels.length > 1
      ? { label: 'Convert to mono', icon: 'mono', run: () => run('toMono', 'mix') }
      : { label: 'Convert to stereo', icon: 'stereo', run: () => run('toStereo') },
    { label: 'Auto-trim silence', icon: 'wand', run: () => run('autoTrim') },
    { separator: true },
    { label: 'Delete track', icon: 'trash', danger: true, run: () => run('deleteTrack', t.id) },
  ], { align: 'end' });
}

function updateColumnStates() {
  for (const col of $$('.track-col', colsEl)) {
    const t = getTrack(col.dataset.id);
    if (!t) continue;
    col.classList.toggle('active', t.id === state.activeId);
    col.classList.toggle('selected', state.selectedIds.has(t.id));
    col.classList.toggle('muted', t.mute || (state.tracks.some((x) => x.solo) && !t.solo));
    col.querySelector('.mute').classList.toggle('on', t.mute);
    col.querySelector('.solo').classList.toggle('on', t.solo);
    const chan = col.querySelector('.chan');
    const stereo = t.channels.length > 1;
    chan.replaceChildren(iconEl(stereo ? 'stereo' : 'mono'), stereo ? 'Stereo' : 'Mono');
    const fx = col.querySelector('.chip.fx');
    const n = t.effects.length, on_ = t.effects.filter((e) => e.enabled).length;
    fx.replaceChildren(iconEl('sparkles'), n ? `${on_}/${n} fx` : 'Add fx');
    fx.classList.toggle('has', on_ > 0);
    const name = col.querySelector('.track-name');
    if (document.activeElement !== name) name.value = t.name;
  }
}

// ---- Drawing ----------------------------------------------------------------------
//
// Waveforms are drawn in "timeline space" (u = time pixels, v = across the lane)
// and transposed onto the canvas, so the drawing code reads like a normal
// left-to-right waveform while the result runs top to bottom.

export function drawAll() {
  for (const col of $$('.track-col', colsEl)) drawCol(col);
}

function drawTrack(id) {
  const col = colsEl.querySelector(`.track-col[data-id="${id}"]`);
  if (col) drawCol(col);
}

function drawCol(col) {
  const cv = col.querySelector('canvas.wave');
  if (!cv || !cv.width) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, k = dpr();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.setTransform(0, k, k, 0, 0, 0); // u → y, v → x
  const len = H / k, across = W / k; // time-axis length, cross-axis size

  drawGrid(g, len, across);

  if (col.dataset.id === '__rec') { drawRecording(g, len, across); return; }
  const t = getTrack(col.dataset.id);
  if (!t) return;

  // Area past the end of this track.
  const endU = timeToPos(trackDuration(t));
  if (endU < len) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(Math.max(0, endU), 0, len, across); }

  // Selection
  const { start, end } = state.selection;
  const selected = state.selectedIds.has(t.id);
  if (end > start) {
    const u0 = timeToPos(start), u1 = timeToPos(end);
    g.fillStyle = selected ? 'rgba(139,123,255,0.22)' : 'rgba(255,255,255,0.035)';
    g.fillRect(u0, 0, u1 - u0, across);
    if (selected) {
      g.fillStyle = 'rgba(167,155,255,0.9)';
      g.fillRect(Math.round(u0), 0, 1, across);
      g.fillRect(Math.round(u1) - 1, 0, 1, across);
    }
  }

  const pre = state.showProcessed ? previews.get(t.id) : null;
  const nCh = t.channels.length;
  const band = across / nCh;
  for (let c = 0; c < nCh; c++) {
    const top = c * band;
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, top + band / 2, len, 1);
    if (pre) {
      drawWave(g, t.channels[c], len, top, band, t.color, 0.22, true);
      drawWave(g, pre.channels[Math.min(c, pre.channels.length - 1)], len, top, band, t.color, 1);
    } else drawWave(g, t.channels[c], len, top, band, t.color, t.mute ? 0.45 : 1);
  }
  if (nCh > 1) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, band, len, 1); }

  // Labels are drawn upright, in normal screen space.
  g.setTransform(k, 0, 0, k, 0, 0);
  g.font = '600 9px system-ui';
  g.fillStyle = 'rgba(255,255,255,0.35)';
  if (nCh > 1) for (let c = 0; c < nCh; c++) g.fillText(c === 0 ? 'L' : 'R', c * band + 6, 12);
  if (pre) { g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillText('FX PREVIEW', across - 64, len - 8); }
}

function drawGrid(g, len, across) {
  const { step } = tickStep();
  g.fillStyle = 'rgba(255,255,255,0.035)';
  const t0 = Math.floor(state.view.scroll / step) * step;
  for (let t = t0; ; t += step) {
    const u = timeToPos(t);
    if (u > len) break;
    g.fillRect(Math.round(u), 0, 1, across);
  }
}

const colorCache = new Map();
function gradient(g, color, top, band, alpha) {
  const grd = g.createLinearGradient(0, top, 0, top + band);
  grd.addColorStop(0, withAlpha(color, alpha));
  grd.addColorStop(0.5, withAlpha(lighten(color), alpha));
  grd.addColorStop(1, withAlpha(color, alpha));
  return grd;
}
function withAlpha(hex, a) {
  const key = hex + a;
  if (colorCache.has(key)) return colorCache.get(key);
  const n = parseInt(hex.slice(1), 16);
  const v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  colorCache.set(key, v);
  return v;
}
function lighten(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(c + (255 - c) * 0.45);
  return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function drawWave(g, data, len, top, band, color, alpha, ghost = false) {
  if (!data?.length) return;
  const sr = state.sampleRate, pps = state.view.pps;
  const spp = sr / pps;
  const mid = top + band / 2;
  const amp = (band / 2) * 0.9;
  const startU = Math.max(0, Math.floor(timeToPos(0)));
  const endU = Math.min(len, Math.ceil(timeToPos(data.length / sr)));
  if (endU <= startU) return;

  if (spp < 2) {
    // Zoomed in to sample level: draw the actual waveform line.
    g.strokeStyle = withAlpha(color, alpha);
    g.lineWidth = ghost ? 1 : 1.5;
    g.beginPath();
    const s0 = Math.max(0, Math.floor(posToTime(startU) * sr) - 1);
    const s1 = Math.min(data.length, Math.ceil(posToTime(endU) * sr) + 1);
    for (let s = s0; s < s1; s++) {
      const u = timeToPos(s / sr), v = mid - data[s] * amp;
      if (s === s0) g.moveTo(u, v); else g.lineTo(u, v);
    }
    g.stroke();
    if (spp < 0.12 && !ghost) {
      g.fillStyle = withAlpha(color, alpha);
      for (let s = s0; s < s1; s++) { g.beginPath(); g.arc(timeToPos(s / sr), mid - data[s] * amp, 2.2, 0, Math.PI * 2); g.fill(); }
    }
    return;
  }

  const pk = spp >= PEAK_BLOCK ? peaks(data) : null;
  const mins = new Float32Array(endU - startU);
  const maxs = new Float32Array(endU - startU);
  for (let u = startU; u < endU; u++) {
    const a = Math.floor(posToTime(u) * sr);
    const b = Math.max(a + 1, Math.floor(posToTime(u + 1) * sr));
    let mn = 1, mx = -1;
    if (pk) {
      const b0 = Math.floor(a / PEAK_BLOCK), b1 = Math.min(pk.length / 2, Math.ceil(b / PEAK_BLOCK));
      for (let i = b0; i < b1; i++) { if (pk[i * 2] < mn) mn = pk[i * 2]; if (pk[i * 2 + 1] > mx) mx = pk[i * 2 + 1]; }
    } else {
      const end = Math.min(b, data.length);
      for (let i = a; i < end; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    if (mn > mx) { mn = 0; mx = 0; }
    mins[u - startU] = mn;
    maxs[u - startU] = mx;
  }
  g.beginPath();
  for (let i = 0; i < maxs.length; i++) g.lineTo(startU + i, mid - Math.max(maxs[i] * amp, 0.5));
  for (let i = mins.length - 1; i >= 0; i--) g.lineTo(startU + i + 1, mid - Math.min(mins[i] * amp, -0.5));
  g.closePath();
  if (ghost) { g.fillStyle = withAlpha('#ffffff', 0.07); g.fill(); g.strokeStyle = withAlpha(color, alpha); g.lineWidth = 1; g.stroke(); }
  else { g.fillStyle = gradient(g, color, top, band, alpha); g.fill(); }
}

function drawRecording(g, len, across) {
  const p = recorder.peaks;
  const sr = state.sampleRate;
  const mid = across / 2, amp = across / 2 * 0.9;
  g.fillStyle = 'rgba(255,77,109,0.85)';
  const blocks = p.length / 2;
  for (let u = 0; u < len; u++) {
    const t0 = posToTime(u) - state.recordStart, t1 = posToTime(u + 1) - state.recordStart;
    if (t1 < 0) continue;
    const b0 = Math.max(0, Math.floor((t0 * sr) / PEAK_BLOCK)), b1 = Math.min(blocks, Math.ceil((t1 * sr) / PEAK_BLOCK));
    if (b0 >= blocks) break;
    let mn = 0, mx = 0;
    for (let i = b0; i < b1; i++) { if (p[i * 2] < mn) mn = p[i * 2]; if (p[i * 2 + 1] > mx) mx = p[i * 2 + 1]; }
    g.fillRect(u, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
  }
}

// ---- Ruler (vertical, on the left) ---------------------------------------------------

const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
function tickStep() {
  const step = STEPS.find((s) => s * state.view.pps >= 70) ?? 3600;
  return { step, minor: step / 5 };
}
function fmtTick(t, step) {
  const m = Math.floor(t / 60), s = t % 60;
  if (step < 1) return `${m}:${s.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1).padStart(step < 0.01 ? 6 : step < 0.1 ? 5 : 4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

function drawRuler() {
  const cv = rulerCv;
  if (!cv.width) return;
  const g = cv.getContext('2d');
  const k = dpr();
  g.setTransform(k, 0, 0, k, 0, 0);
  const w = cv.width / k, len = cv.height / k;
  g.clearRect(0, 0, w, len);

  const { start, end } = state.selection;
  if (end > start) {
    g.fillStyle = state.loop ? 'rgba(47,212,198,0.28)' : 'rgba(139,123,255,0.28)';
    g.fillRect(0, timeToPos(start), w, timeToPos(end) - timeToPos(start));
  }
  const { step, minor } = tickStep();
  g.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.textBaseline = 'top';
  const t0 = Math.floor(state.view.scroll / minor) * minor;
  for (let i = 0; ; i++) {
    const t = t0 + i * minor;
    const y = Math.round(timeToPos(t));
    if (y > len) break;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    g.fillStyle = major ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)';
    g.fillRect(major ? w - 14 : w - 6, y, major ? 14 : 6, 1);
    if (major) { g.fillStyle = 'rgba(220,226,240,0.7)'; g.fillText(fmtTick(t, step), 6, y + 3); }
  }
  // Cursor marker (points into the tracks)
  const cy = timeToPos(start);
  g.fillStyle = '#a79bff';
  g.beginPath(); g.moveTo(w - 8, cy - 5); g.lineTo(w - 8, cy + 5); g.lineTo(w - 1, cy); g.fill();
}

function setupRuler() {
  rulerCv.addEventListener('pointerdown', (e) => {
    const rect = rulerCv.getBoundingClientRect();
    const t0 = Math.max(0, posToTime(e.clientY - rect.top));
    let dragged = false;
    rulerCv.setPointerCapture(e.pointerId);
    setSelection(t0);
    seek(t0);
    const move = (ev) => {
      const t = Math.max(0, posToTime(ev.clientY - rect.top));
      if (Math.abs(t - t0) * state.view.pps > 3) dragged = true;
      if (dragged) setSelection(t0, t);
    };
    const up = () => { rulerCv.removeEventListener('pointermove', move); rulerCv.removeEventListener('pointerup', up); };
    rulerCv.addEventListener('pointermove', move);
    rulerCv.addEventListener('pointerup', up);
  });
}

// ---- Lane interaction ---------------------------------------------------------------

function columnIndexAt(clientX) {
  const cols = $$('.track-col:not(.recording)', colsEl);
  for (let i = 0; i < cols.length; i++) {
    if (clientX < cols[i].getBoundingClientRect().right) return i;
  }
  return cols.length - 1;
}

function setupLane(lane, cv, id) {
  lane.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    lane.style.cursor = edgeAt(e, cv, id) ? 'ns-resize' : 'vertical-text';
  });
  lane.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = cv.getBoundingClientRect();
    const tAt = (ev) => Math.max(0, posToTime(ev.clientY - rect.top));
    const t = tAt(e);
    const edge = edgeAt(e, cv, id);
    const startIdx = state.tracks.findIndex((x) => x.id === id);
    let anchor = t;
    if (edge) anchor = edge === 'start' ? state.selection.end : state.selection.start;
    else if (e.shiftKey) {
      anchor = Math.abs(t - state.selection.start) < Math.abs(t - state.selection.end) ? state.selection.end : state.selection.start;
      state.selectedIds.add(id);
      setSelection(anchor, t);
    } else {
      setActive(id, { additive: e.metaKey || e.ctrlKey });
      setSelection(t);
    }
    let moved = !!edge || e.shiftKey;
    lane.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const tt = tAt(ev);
      if (!moved && Math.abs(ev.clientY - e.clientY) < 3) return;
      moved = true;
      // Dragging sideways across columns extends the selection to those tracks.
      if (!edge) {
        const i = columnIndexAt(ev.clientX);
        const [a, b] = [Math.min(startIdx, i), Math.max(startIdx, i)];
        const ids = state.tracks.slice(a, b + 1).map((x) => x.id);
        if (!(e.metaKey || e.ctrlKey)) state.selectedIds = new Set(ids); else ids.forEach((x) => state.selectedIds.add(x));
      }
      setSelection(anchor, tt);
      autoScrollEdge(ev.clientY - rect.top);
    };
    const up = () => {
      lane.removeEventListener('pointermove', move);
      lane.removeEventListener('pointerup', up);
      if (!moved && state.playing) seek(t);
      else if (!moved) { state.playhead = t; emit('playhead'); }
    };
    lane.addEventListener('pointermove', move);
    lane.addEventListener('pointerup', up);
  });
  lane.addEventListener('dblclick', () => {
    const t = getTrack(id);
    if (!t) return;
    setActive(id);
    setSelection(0, trackDuration(t));
  });
}

function edgeAt(e, cv, id) {
  if (!hasRange() || !state.selectedIds.has(id)) return null;
  const y = e.clientY - cv.getBoundingClientRect().top;
  if (Math.abs(y - timeToPos(state.selection.start)) < 6) return 'start';
  if (Math.abs(y - timeToPos(state.selection.end)) < 6) return 'end';
  return null;
}

function autoScrollEdge(y) {
  const span = state.view.span;
  state.view.target = null;
  if (y > span - 20) { state.view.scroll += 20 / state.view.pps; emit('view'); }
  else if (y < 20 && state.view.scroll > 0) { state.view.scroll -= 20 / state.view.pps; emit('view'); }
}

function setupWheel() {
  area.addEventListener('wheel', (e) => {
    if (e.target.closest('.track-head')) return; // let header sliders etc. behave normally
    const rect = rulerCv.getBoundingClientRect();
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? state.view.span : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const y = e.clientY - rect.top;
      zoomAround(Math.exp(-e.deltaY * px * 0.0025), y >= 0 ? posToTime(y) : null);
    } else if (e.shiftKey) {
      e.preventDefault();
      scroller.scrollLeft += (e.deltaY || e.deltaX) * px;
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Trackpad sideways swipe: native horizontal scroll across columns.
    } else {
      e.preventDefault();
      const base = state.view.target && !state.view.target.anchor ? state.view.target.scroll : state.view.scroll;
      const max = Math.max(0, contentDuration() - state.view.span / state.view.pps);
      animateView({ scroll: Math.max(0, Math.min(max, base + (e.deltaY * px) / state.view.pps)) });
    }
  }, { passive: false });
}

// ---- Time scrollbar (right edge) ------------------------------------------------------

function updateScrollbar() {
  const total = contentDuration();
  const visible = state.view.span / state.view.pps;
  const bh = vbar.clientHeight;
  const th = Math.max(36, (visible / total) * bh);
  vthumb.style.height = `${th}px`;
  vthumb.style.transform = `translateY(${(state.view.scroll / Math.max(1e-9, total - visible)) * (bh - th) || 0}px)`;
  vbar.classList.toggle('hidden', visible >= total - 1e-6);
}

function setupScrollbar() {
  vthumb.addEventListener('pointerdown', (e) => {
    vthumb.setPointerCapture(e.pointerId);
    state.view.target = null;
    const y0 = e.clientY, s0 = state.view.scroll;
    const move = (ev) => {
      const total = contentDuration(), visible = state.view.span / state.view.pps;
      const bh = vbar.clientHeight, th = vthumb.clientHeight;
      state.view.scroll = s0 + ((ev.clientY - y0) / (bh - th)) * (total - visible);
      emit('view');
    };
    const up = () => { vthumb.removeEventListener('pointermove', move); vthumb.removeEventListener('pointerup', up); };
    vthumb.addEventListener('pointermove', move);
    vthumb.addEventListener('pointerup', up);
  });
}

// ---- Transport / animation ------------------------------------------------------------------

function onTransport() {
  const hasRecCol = !!colsEl.querySelector('.recording');
  if (state.recording !== hasRecCol) renderColumns();
}

/** Eases the view toward state.view.target (set by animateView) when smooth animations are on. */
let lastStep = 0;
function stepViewAnimation(now) {
  const v = state.view;
  const tg = v.target;
  if (!tg) { lastStep = now; return; }
  const dt = Math.min(64, now - lastStep || 16);
  lastStep = now;
  const k = 1 - Math.exp(-dt / 70);
  const maxScroll = (pps) => Math.max(0, Math.max(projectDuration() + 2, v.span / pps) - v.span / pps);
  const endScroll = tg.anchor ? tg.anchor.time - tg.anchor.px / tg.pps : tg.scroll;
  const goal = Math.max(0, Math.min(maxScroll(tg.pps), endScroll));
  v.pps = Math.exp(Math.log(v.pps) + (Math.log(tg.pps) - Math.log(v.pps)) * k);
  v.scroll = tg.anchor && Math.abs(v.pps / tg.pps - 1) > 1e-3 ? tg.anchor.time - tg.anchor.px / v.pps : v.scroll + (goal - v.scroll) * k;
  if (Math.abs(v.pps / tg.pps - 1) < 2e-3 && Math.abs(goal - v.scroll) * v.pps < 0.5) {
    v.pps = tg.pps;
    v.scroll = goal;
    v.target = null;
  }
  emit('view');
}

let lastRecDraw = 0;
function frame(now) {
  const pos = state.recording ? state.recordStart + recorder.frames / state.sampleRate : tick();
  emit('frame', pos);

  stepViewAnimation(now);

  // Playhead + follow (page-flip when it reaches the bottom), unless auto-scroll is off.
  const p = timeToPos(pos);
  if (prefs.autoScroll && (state.playing || state.recording) && !state.view.target && (p > state.view.span - 30 || p < 0)) {
    animateView({ scroll: Math.max(0, pos - (state.view.span * 0.1) / state.view.pps) });
  }
  const y = timeToPos(pos);
  playheadEl.style.transform = `translateY(${HEAD_H + y}px)`;
  playheadEl.style.opacity = y < 0 || y > state.view.span ? 0 : 1;
  playheadEl.classList.toggle('live', state.playing || state.recording);
  playheadEl.classList.toggle('rec', state.recording);

  if (state.recording && now - lastRecDraw > 60) {
    lastRecDraw = now;
    const col = colsEl.querySelector('.recording');
    if (col) {
      drawCol(col);
      col.querySelector('.rec-time').textContent = formatTime(recorder.frames / state.sampleRate);
      const lvl = recorder.inputLevel();
      col.querySelector('.rec-meter .fill').style.width = `${Math.min(100, Math.max(0, (1 + Math.log10(Math.max(lvl, 1e-4)) / 3) * 100))}%`;
    }
  }
  requestAnimationFrame(frame);
}
