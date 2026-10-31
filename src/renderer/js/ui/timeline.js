// Timeline: time runs top → bottom, tracks are columns placed freely left/right.
// The scroll wheel moves through time; Shift+wheel scrolls across tracks;
// Ctrl/⌘+wheel zooms. Columns resize from their right edge, and each track's
// effects appear as bars beside the waveform showing when they start and stop.

import { state, on, emit, setSelection, setActive, hasRange, projectDuration, trackDuration, checkpoint, getTrack, prefs, animateView } from '../state.js';
import { peaks, PEAK_BLOCK } from '../dsp/analysis.js';
import { previews, seek, tick } from '../audio/engine.js';
import { run, recorder, zoomAround, addEffect } from '../actions.js';
import { EFFECTS, effectRange } from '../audio/effects.js';
import { openFxEditor, effectPicker } from './inspector.js';
import { $, $$, h, iconEl, popover, formatTime } from './dom.js';

export const HEAD_H = 96;
export const COL_W = 260;
const COL_MIN = 150, COL_MAX = 900;
let area, scroller, colsEl, rulerCv, playheadEl, vbar, vthumb;
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
  on('view', () => { clampScroll(); drawAll(); drawRuler(); updateScrollbar(); layoutAllStrips(); });
  on('theme', () => { readPalette(); drawAll(); });
  readPalette();
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

/** Matches a canvas's backing store to its CSS size. Returns true if it changed. */
function sizeCanvas(cv) {
  const w = cv.clientWidth, hgt = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr()) || cv.height !== Math.round(hgt * dpr())) {
    cv.width = Math.round(w * dpr());
    cv.height = Math.round(hgt * dpr());
    return true;
  }
  return false;
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
  assignPositions();
  colsEl.replaceChildren(...state.tracks.map(columnFor));
  if (state.recording) colsEl.append(recordingColumn());
  sizeStrip();
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
  // Both sliders snap to their neutral point (0 dB / centre) when dragged close to it.
  const vol = slider({ min: -36, max: 12, step: 0.1, value: t.gainDb, onStart: mark('Volume'),
    onInput: (v) => { if (Math.abs(v) < 1) { v = 0; vol.value = 0; } t.gainDb = v; volVal.textContent = fmtDb(v); emit('trackprops', t.id); },
    onReset: () => { t.gainDb = 0; vol.value = 0; volVal.textContent = fmtDb(0); emit('trackprops', t.id); } });
  const pan = slider({ min: -1, max: 1, step: 0.01, value: t.pan, cls: 'center', onStart: mark('Pan'),
    onInput: (v) => { if (Math.abs(v) < 0.07) { v = 0; pan.value = 0; } t.pan = v; panVal.textContent = fmtPan(v); emit('trackprops', t.id); },
    onReset: () => { t.pan = 0; pan.value = 0; panVal.textContent = fmtPan(0); emit('trackprops', t.id); } });
  vol.addEventListener('change', unmark);
  pan.addEventListener('change', unmark);

  const more = h('button.more-btn', { title: 'Track options (or right-click the header)', onclick: (e) => trackMenu(t, e.currentTarget) }, iconEl('more'));
  const head = h('div.track-head', {},
    h('div.color', { style: { background: t.color } }),
    h('div.th-row.top', {}, name,
      h('button.del-btn', { title: 'Delete track', onclick: () => run('deleteTrack', t.id) }, iconEl('trash')),
      h('button.tog.mute', { title: 'Mute (M)', onclick: () => run('muteTrack', t.id) }, 'M'),
      h('button.tog.solo', { title: 'Solo (S)', onclick: () => run('soloTrack', t.id) }, 'S'),
      more),
    h('div.th-row.slider-row', { title: 'Volume' }, iconEl('gain'), vol, volVal),
    h('div.th-row.slider-row', { title: 'Pan' }, iconEl('pan'), pan, panVal),
  );
  // Right-clicking anywhere on the header opens the same menu as the ⋯ button.
  head.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.track-name:not([readonly])')) return; // normal text menu while renaming
    e.preventDefault();
    trackMenu(t, { x: e.clientX, y: e.clientY });
  });

  const cv = h('canvas.wave');
  const lane = h('div.lane', {}, cv);
  const strip = h('div.fx-strip');
  setupLane(lane, cv, t.id);
  const col = h('div.track-col', { 'data-id': t.id, style: { width: `${colWidth(t)}px`, left: `${t.x}px` } },
    head, h('div.col-body', {}, lane, strip));
  col.append(resizeHandle(col, t));
  setupColumnDrag(head, col, t);
  layoutStrip(col, t);
  return col;
}

const colWidth = (t) => t.width || COL_W;

/**
 * Tracks sit at free horizontal positions (t.x). New tracks without a position are
 * placed to the right of everything else. Keeps state.tracks ordered left → right.
 */
function assignPositions() {
  let right = 0;
  for (const t of state.tracks) if (t.x != null) right = Math.max(right, t.x + colWidth(t));
  for (const t of state.tracks) if (t.x == null) { t.x = right; right += colWidth(t); }
  state.tracks.sort((a, b) => a.x - b.x);
  return right;
}

const overlaps = (x, w, o) => x < o.x + colWidth(o) - 1 && x + w > o.x + 1;

/** Nearest x to `want` where a column of width `w` fits without overlapping the others. */
function freeSpot(want, w, others) {
  const candidates = [Math.max(0, want), 0];
  for (const o of others) candidates.push(o.x + colWidth(o), o.x - w);
  return candidates
    .filter((x) => x >= 0 && !others.some((o) => overlaps(x, w, o)))
    .sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] ?? 0;
}

/** After a column grows, push any columns it now overlaps further right. */
function pushRight(t) {
  const sorted = [...state.tracks].sort((a, b) => a.x - b.x);
  let edge = t.x + colWidth(t);
  for (const o of sorted) {
    if (o === t || o.x < t.x) continue;
    if (o.x < edge) o.x = edge;
    edge = Math.max(edge, o.x + colWidth(o));
  }
  for (const c of $$('.track-col', colsEl)) {
    const tr = getTrack(c.dataset.id);
    if (tr) c.style.left = `${tr.x}px`;
  }
  sizeStrip();
}

function sizeStrip() {
  let right = 0;
  for (const t of state.tracks) right = Math.max(right, (t.x ?? 0) + colWidth(t));
  colsEl.style.width = `${right + 320}px`; // room to drag tracks further right
}

// Controls inside a header that should never start a track drag.
const HEAD_CONTROLS = 'button, input[type=range], input:not([readonly])';

/** Click a header to select the track; drag it to place the track anywhere left or right. */
function setupColumnDrag(head, col, t) {
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest(HEAD_CONTROLS)) return;
    setActive(t.id, { additive: e.shiftKey || e.metaKey || e.ctrlKey });
    const x0 = e.clientX, left0 = scroller.scrollLeft, startX = t.x;
    let dragging = false, scrollTimer = null, x = startX;
    const place = (clientX) => {
      x = Math.max(0, Math.round((startX + clientX - x0 + scroller.scrollLeft - left0) / 4) * 4);
      col.style.left = `${x}px`;
      const others = state.tracks.filter((o) => o !== t);
      col.classList.toggle('blocked', others.some((o) => overlaps(x, colWidth(t), o)));
    };
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - x0) < 6) return;
        dragging = true;
        col.classList.add('dragging');
        document.body.classList.add('dragging-track');
      }
      place(ev.clientX);
      // Scroll the track strip when dragging near its edges.
      clearInterval(scrollTimer);
      const r = scroller.getBoundingClientRect();
      const edge = ev.clientX < r.left + 40 ? -12 : ev.clientX > r.right - 40 ? 12 : 0;
      if (edge) scrollTimer = setInterval(() => { scroller.scrollLeft += edge; place(ev.clientX); }, 16);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      clearInterval(scrollTimer);
      if (!dragging) return;
      col.classList.remove('dragging', 'blocked');
      document.body.classList.remove('dragging-track');
      // Settle in the nearest free spot so tracks never overlap.
      const finalX = freeSpot(x, colWidth(t), state.tracks.filter((o) => o !== t));
      if (finalX === startX) { col.style.left = `${startX}px`; return; }
      checkpoint('Move track');
      t.x = finalX;
      emit('tracks');
    };
    // Listen on the window so fast drags that leave the header are still followed.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/** Drag the right edge of a column to resize it; double-click resets. */
function resizeHandle(col, t) {
  const grip = h('div.col-resize', { title: 'Drag to resize · double-click to reset' });
  const apply = () => {
    col.style.width = `${colWidth(t)}px`;
    pushRight(t);
    sizeCanvas(col.querySelector('canvas.wave'));
    drawCol(col);
  };
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = col.offsetWidth;
    document.body.classList.add('resizing-col');
    const move = (ev) => {
      t.width = Math.max(COL_MIN, Math.min(COL_MAX, Math.round(w0 + ev.clientX - x0)));
      apply();
    };
    const up = () => {
      document.body.classList.remove('resizing-col');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { t.width = null; apply(); });
  return grip;
}

function recordingColumn() {
  const cv = h('canvas.wave');
  return h('div.track-col.recording', { 'data-id': '__rec', style: { width: `${COL_W}px`, left: `${assignPositions()}px` } },
    h('div.track-head', {},
      h('div.color', { style: { background: 'var(--rec)' } }),
      h('div.th-row', {}, h('span.rec-dot'), h('span.rec-title', {}, 'Recording…')),
      h('div.th-row', {}, h('span.rec-time', {}, '00:00.000')),
      h('div.th-row', {}, h('div.meter.rec-meter', {}, h('div.fill')))),
    h('div.col-body', {}, h('div.lane', {}, cv)));
}

function trackMenu(t, anchor) {
  setActive(t.id);
  const stereo = t.channels.length > 1;
  popover(anchor, [
    { label: 'Duplicate', icon: 'copy', run: () => run('duplicateTrack', t.id) },
    stereo && { label: 'Split tracks', sub: 'Left and right become two mono tracks', icon: 'split', run: () => run('splitStereo') },
    stereo && { label: 'Convert to mono', sub: 'Mixes left and right together', icon: 'mono', run: () => run('toMono', 'mix') },
    !stereo && { label: 'Convert to stereo', sub: 'Copies the sound to both sides', icon: 'stereo', run: () => run('toStereo') },
  ].filter(Boolean), { align: 'end' });
}

// ---- Effect bars (each effect's time range, beside the waveform) ------------------------

const LANE_W = 20;
const CATEGORY_COLORS = {
  Volume: '#f0606f', Dynamics: '#f59f45', Tone: '#2fc7b5', Space: '#4f9dff', Character: '#d36bff', Stereo: '#7bd65a', Time: '#e8c547',
};

/** Packs overlapping effect ranges into side-by-side lanes. */
function packLanes(t) {
  const dur = trackDuration(t);
  const items = t.effects.map((fx) => ({ fx, r: effectRange(fx.params, dur) })).sort((a, b) => a.r[0] - b.r[0]);
  const ends = [];
  for (const it of items) {
    let lane = ends.findIndex((e) => e <= it.r[0] + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = it.r[1];
    it.lane = lane;
  }
  return { items, lanes: ends.length };
}

function layoutStrip(col, t) {
  const strip = col.querySelector('.fx-strip');
  if (!strip) return;
  const { items, lanes } = packLanes(t);
  strip.style.width = `${lanes ? lanes * LANE_W + 4 : 0}px`;
  const existing = new Map($$('.fx-bar', strip).map((b) => [b.dataset.fx, b]));
  for (const { fx, r, lane } of items) {
    let bar = existing.get(fx.id);
    existing.delete(fx.id);
    if (!bar) { bar = fxBar(col, t, fx); strip.append(bar); }
    const def = EFFECTS[fx.type];
    const top = timeToPos(r[0]);
    const height = Math.max(22, (r[1] - r[0]) * state.view.pps);
    bar.style.cssText = `left:${2 + lane * LANE_W}px; top:${top}px; height:${height}px; --c:${CATEGORY_COLORS[def.category] || '#8b7bff'}`;
    bar.classList.toggle('off', !fx.enabled);
    bar.querySelector('.fx-bar-label').textContent = def.name;
  }
  existing.forEach((b) => b.remove());
  // The waveform canvas shrinks when the strip grows.
  const cv = col.querySelector('canvas.wave');
  if (cv && col.isConnected && sizeCanvas(cv)) drawCol(col);
}

function layoutAllStrips() {
  for (const col of $$('.track-col', colsEl)) {
    const t = getTrack(col.dataset.id);
    if (t) layoutStrip(col, t);
  }
}

function fxBar(col, t, fx) {
  const bar = h('div.fx-bar', { 'data-fx': fx.id, title: 'Click to edit · drag the ends to change when it starts and stops' },
    h('div.fx-h.top', { title: 'Drag to change the start · double-click: start of track' }),
    h('span.fx-bar-label'),
    h('div.fx-h.bottom', { title: 'Drag to change the end · double-click: end of track' }));
  const dur = () => trackDuration(t);
  const commit = () => { emit('effects', { id: t.id, fxId: fx.id, structural: false }); layoutStrip(col, t); };
  // Which part of the bar a pointer is over (by position, so it also works while the pointer is captured).
  const partAt = (clientY) => {
    const r = bar.getBoundingClientRect();
    if (clientY - r.top < 8) return 'start';
    if (r.bottom - clientY < 8) return 'end';
    return 'move';
  };

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setActive(t.id);
    const mode = partAt(e.clientY);
    const y0 = e.clientY;
    const [s0, e0] = effectRange(fx.params, dur());
    let moved = false;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dt = (ev.clientY - y0) / state.view.pps;
      if (!moved) {
        if (Math.abs(ev.clientY - y0) < 3) return;
        moved = true;
        checkpoint(`Adjust ${EFFECTS[fx.type].name} timing`);
        bar.classList.add('dragging');
      }
      const D = dur(), min = Math.min(0.02, D);
      if (mode === 'start') fx.params.start = Math.max(0, Math.min(e0 - min, s0 + dt));
      else if (mode === 'end') { const v = Math.max(s0 + min, Math.min(D, e0 + dt)); fx.params.end = v >= D - 1e-3 ? null : v; }
      else {
        const len = e0 - s0, ns = Math.max(0, Math.min(D - len, s0 + dt));
        fx.params.start = ns;
        fx.params.end = ns + len >= D - 1e-3 ? null : ns + len;
      }
      commit();
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.classList.remove('dragging');
      if (!moved && mode === 'move') openFxEditor(bar, t, fx);
      if (moved) emit('effects-ui', { id: t.id });
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', (e) => {
    const part = partAt(e.clientY);
    if (part === 'move') return;
    checkpoint(`Adjust ${EFFECTS[fx.type].name} timing`);
    if (part === 'start') fx.params.start = 0; else fx.params.end = null;
    commit();
    emit('effects-ui', { id: t.id });
  });
  bar.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openFxEditor(bar, t, fx); });
  return bar;
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
    const name = col.querySelector('.track-name');
    if (document.activeElement !== name) name.value = t.name;
    layoutStrip(col, t);
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

  // The audio's extent: a tinted background with glowing caps marking where it starts and ends.
  const startU = timeToPos(0), endU = timeToPos(trackDuration(t));
  if (endU > 0 && startU < len) {
    g.fillStyle = pal.laneFill;
    g.fillRect(startU, 0, endU - startU, across);
    const cap = Math.min(22, (endU - startU) / 3);
    const head = g.createLinearGradient(startU, 0, startU + cap, 0);
    head.addColorStop(0, pal.cap); head.addColorStop(1, pal.capFade);
    g.fillStyle = head;
    g.fillRect(startU, 0, cap, across);
    const tail = g.createLinearGradient(endU - cap, 0, endU, 0);
    tail.addColorStop(0, pal.capFade); tail.addColorStop(1, pal.cap);
    g.fillStyle = tail;
    g.fillRect(endU - cap, 0, cap, across);
  }

  // Selection
  const { start, end } = state.selection;
  const selected = state.selectedIds.has(t.id);
  if (end > start) {
    const u0 = timeToPos(start), u1 = timeToPos(end);
    g.fillStyle = selected ? pal.sel : 'rgba(255,255,255,0.035)';
    g.fillRect(u0, 0, u1 - u0, across);
    if (selected) {
      g.fillStyle = pal.selEdge;
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

// Theme colours for the canvases, read from CSS variables (refreshed when the theme changes).
const pal = {};
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  pal.laneFill = v('--lane-fill', 'rgba(20,20,110,0.55)');
  pal.cap = v('--lane-cap', 'rgba(232,107,255,0.85)');
  pal.capFade = v('--lane-cap-fade', 'rgba(232,107,255,0)');
  pal.sel = v('--sel-fill', 'rgba(110,130,255,0.35)');
  pal.selEdge = v('--sel-edge', 'rgba(180,190,255,0.95)');
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
  // Right-click the waveform to add an effect: over the selection if you clicked inside it,
  // otherwise over the whole track.
  lane.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = getTrack(id);
    if (!t) return;
    const time = posToTime(e.clientY - cv.getBoundingClientRect().top);
    const inSel = hasRange() && state.selectedIds.has(id) && time >= state.selection.start && time <= state.selection.end;
    if (!inSel) setActive(id);
    effectPicker({ x: e.clientX, y: e.clientY }, {
      title: inSel ? 'Add effect to the selection' : 'Add effect to this track',
      onPick: (type) => {
        const fx = addEffect(type, {}, t, { useSelection: inSel });
        if (fx) requestAnimationFrame(() => { const bar = colsEl.querySelector(`.fx-bar[data-fx="${fx.id}"]`); if (bar) openFxEditor(bar, t, fx); });
      },
    });
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
