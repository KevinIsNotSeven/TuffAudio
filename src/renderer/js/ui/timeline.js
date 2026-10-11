// Timeline: ruler, track rows (header + waveform lane), playhead, scrollbar and
// all pointer interaction (select, drag edges, scrub, zoom).

import { state, on, emit, setSelection, setActive, hasRange, projectDuration, trackDuration, checkpoint, getTrack } from '../state.js';
import { peaks, PEAK_BLOCK } from '../dsp/analysis.js';
import { previews, seek, tick } from '../audio/engine.js';
import { run, recorder, zoomAround } from '../actions.js';
import { $, $$, h, iconEl, popover, formatTime } from './dom.js';

const HEAD_W = 236;
let area, scroller, rowsEl, rulerCv, playheadEl, hbar, hthumb, emptyEl;
const dpr = () => window.devicePixelRatio || 1;

const xToTime = (x) => state.view.scrollX + x / state.view.pps;
const timeToX = (t) => (t - state.view.scrollX) * state.view.pps;

export function initTimeline() {
  area = $('#timeline');
  scroller = $('#tracksScroll');
  rowsEl = $('#tracks');
  rulerCv = $('#ruler');
  playheadEl = $('#playhead');
  hbar = $('#hscroll');
  hthumb = $('#hscroll .thumb');
  emptyEl = $('#emptyState');

  new ResizeObserver(layout).observe(scroller);
  setupRuler();
  setupWheel();
  setupScrollbar();

  on('tracks', renderRows);
  on('audio', () => drawAll());
  on('preview', (id) => drawTrack(id));
  on('selection', () => { updateRowStates(); drawAll(); drawRuler(); });
  on('active', updateRowStates);
  on('trackprops', updateRowStates);
  on('effects', updateRowStates);
  on('effects-ui', updateRowStates);
  on('view', () => { clampScroll(); drawAll(); drawRuler(); updateScrollbar(); });
  on('transport', onTransport);

  renderRows();
  requestAnimationFrame(frame);
}

// ---- Layout -------------------------------------------------------------------

function layout() {
  const laneW = Math.max(100, scroller.clientWidth - HEAD_W);
  state.view.width = laneW;
  for (const cv of $$('canvas.wave', rowsEl)) sizeCanvas(cv);
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
  return Math.max(projectDuration() + 2, state.view.width / state.view.pps);
}

function clampScroll() {
  const max = Math.max(0, contentDuration() - state.view.width / state.view.pps);
  state.view.scrollX = Math.max(0, Math.min(max, state.view.scrollX));
}

// ---- Track rows -----------------------------------------------------------------

function renderRows() {
  rowsEl.replaceChildren(...state.tracks.map(rowFor));
  if (state.recording) rowsEl.append(recordingRow());
  emptyEl.hidden = state.tracks.length > 0 || state.recording;
  layout();
  updateRowStates();
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

function rowFor(t) {
  const name = h('input.track-name', { value: t.name, spellcheck: false, title: 'Rename track' });
  name.addEventListener('change', () => { checkpoint('Rename'); t.name = name.value.trim() || t.name; emit('trackprops', t.id); emit('effects-ui', { id: t.id }); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });

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

  const head = h('div.track-head', { onpointerdown: (e) => { if (!e.target.closest('input,button')) setActive(t.id, { additive: e.shiftKey || e.metaKey || e.ctrlKey }); } },
    h('div.color', { style: { background: t.color } }),
    h('div.th-row', {}, name,
      h('button.icon-btn.ghost.sm', { title: 'Track options', onclick: (e) => trackMenu(t, e.currentTarget) }, iconEl('more'))),
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
  return h('div.track-row', { 'data-id': t.id }, head, lane);
}

function recordingRow() {
  const cv = h('canvas.wave');
  return h('div.track-row.recording', { 'data-id': '__rec' },
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
    { label: 'Move up', icon: 'arrowUp', disabled: i === 0, run: () => run('moveTrack', t.id, -1) },
    { label: 'Move down', icon: 'arrowDown', disabled: i === state.tracks.length - 1, run: () => run('moveTrack', t.id, 1) },
    { separator: true },
    t.channels.length > 1
      ? { label: 'Convert to mono', icon: 'mono', run: () => run('toMono', 'mix') }
      : { label: 'Convert to stereo', icon: 'stereo', run: () => run('toStereo') },
    { label: 'Auto-trim silence', icon: 'wand', run: () => run('autoTrim') },
    { separator: true },
    { label: 'Delete track', icon: 'trash', danger: true, run: () => run('deleteTrack', t.id) },
  ], { align: 'end' });
}

function updateRowStates() {
  for (const row of $$('.track-row', rowsEl)) {
    const t = getTrack(row.dataset.id);
    if (!t) continue;
    row.classList.toggle('active', t.id === state.activeId);
    row.classList.toggle('selected', state.selectedIds.has(t.id));
    row.classList.toggle('muted', t.mute || (state.tracks.some((x) => x.solo) && !t.solo));
    row.querySelector('.mute').classList.toggle('on', t.mute);
    row.querySelector('.solo').classList.toggle('on', t.solo);
    const chan = row.querySelector('.chan');
    const stereo = t.channels.length > 1;
    chan.replaceChildren(iconEl(stereo ? 'stereo' : 'mono'), stereo ? 'Stereo' : 'Mono');
    const fx = row.querySelector('.chip.fx');
    const n = t.effects.length, on_ = t.effects.filter((e) => e.enabled).length;
    fx.replaceChildren(iconEl('sparkles'), n ? `${on_}/${n} fx` : 'Add fx');
    fx.classList.toggle('has', on_ > 0);
    const name = row.querySelector('.track-name');
    if (document.activeElement !== name) name.value = t.name;
  }
}

// ---- Drawing ----------------------------------------------------------------------

export function drawAll() {
  for (const row of $$('.track-row', rowsEl)) drawRow(row);
}

function drawTrack(id) {
  const row = rowsEl.querySelector(`.track-row[data-id="${id}"]`);
  if (row) drawRow(row);
}

function drawRow(row) {
  const cv = row.querySelector('canvas.wave');
  if (!cv || !cv.width) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height, k = dpr();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.scale(k, k);
  const w = W / k, hh = H / k;

  drawGrid(g, w, hh);

  if (row.dataset.id === '__rec') { drawRecording(g, w, hh); return; }
  const t = getTrack(row.dataset.id);
  if (!t) return;

  // Area past the end of this track.
  const endX = timeToX(trackDuration(t));
  if (endX < w) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(Math.max(0, endX), 0, w, hh); }

  // Selection
  const { start, end } = state.selection;
  const selected = state.selectedIds.has(t.id);
  if (end > start) {
    const x0 = timeToX(start), x1 = timeToX(end);
    g.fillStyle = selected ? 'rgba(139,123,255,0.22)' : 'rgba(255,255,255,0.035)';
    g.fillRect(x0, 0, x1 - x0, hh);
    if (selected) {
      g.fillStyle = 'rgba(167,155,255,0.9)';
      g.fillRect(Math.round(x0), 0, 1, hh);
      g.fillRect(Math.round(x1) - 1, 0, 1, hh);
    }
  }

  const pre = state.showProcessed ? previews.get(t.id) : null;
  const nCh = t.channels.length;
  const band = hh / nCh;
  for (let c = 0; c < nCh; c++) {
    const top = c * band;
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, top + band / 2, w, 1);
    if (pre) {
      drawWave(g, t.channels[c], w, top, band, t.color, 0.22, true);
      drawWave(g, pre.channels[Math.min(c, pre.channels.length - 1)], w, top, band, t.color, 1);
    } else drawWave(g, t.channels[c], w, top, band, t.color, t.mute ? 0.45 : 1);
    if (nCh > 1) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '600 9px var(--font-ui, system-ui)';
      g.fillText(c === 0 ? 'L' : 'R', 6, top + 12);
    }
  }
  if (nCh > 1) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, band, w, 1); }
  if (pre) {
    g.font = '600 9px system-ui';
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fillText('FX PREVIEW', w - 70, hh - 8);
  }
}

function drawGrid(g, w, hh) {
  const { step } = tickStep();
  g.fillStyle = 'rgba(255,255,255,0.035)';
  const t0 = Math.floor(state.view.scrollX / step) * step;
  for (let t = t0; ; t += step) {
    const x = timeToX(t);
    if (x > w) break;
    g.fillRect(Math.round(x), 0, 1, hh);
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

function drawWave(g, data, w, top, band, color, alpha, ghost = false) {
  if (!data?.length) return;
  const sr = state.sampleRate, pps = state.view.pps;
  const spp = sr / pps;
  const mid = top + band / 2;
  const amp = (band / 2) * 0.9;
  const startX = Math.max(0, Math.floor(timeToX(0)));
  const endX = Math.min(w, Math.ceil(timeToX(data.length / sr)));
  if (endX <= startX) return;

  if (spp < 2) {
    // Zoomed in to sample level: draw the actual waveform line.
    g.strokeStyle = withAlpha(color, alpha);
    g.lineWidth = ghost ? 1 : 1.5;
    g.beginPath();
    const s0 = Math.max(0, Math.floor(xToTime(startX) * sr) - 1);
    const s1 = Math.min(data.length, Math.ceil(xToTime(endX) * sr) + 1);
    for (let s = s0; s < s1; s++) {
      const x = timeToX(s / sr), y = mid - data[s] * amp;
      if (s === s0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    if (spp < 0.12 && !ghost) {
      g.fillStyle = withAlpha(color, alpha);
      for (let s = s0; s < s1; s++) { g.beginPath(); g.arc(timeToX(s / sr), mid - data[s] * amp, 2.2, 0, Math.PI * 2); g.fill(); }
    }
    return;
  }

  const pk = spp >= PEAK_BLOCK ? peaks(data) : null;
  const mins = new Float32Array(endX - startX);
  const maxs = new Float32Array(endX - startX);
  for (let x = startX; x < endX; x++) {
    const a = Math.floor(xToTime(x) * sr);
    const b = Math.max(a + 1, Math.floor(xToTime(x + 1) * sr));
    let mn = 1, mx = -1;
    if (pk) {
      const b0 = Math.floor(a / PEAK_BLOCK), b1 = Math.min(pk.length / 2, Math.ceil(b / PEAK_BLOCK));
      for (let i = b0; i < b1; i++) { if (pk[i * 2] < mn) mn = pk[i * 2]; if (pk[i * 2 + 1] > mx) mx = pk[i * 2 + 1]; }
    } else {
      const end = Math.min(b, data.length);
      for (let i = a; i < end; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    if (mn > mx) { mn = 0; mx = 0; }
    mins[x - startX] = mn;
    maxs[x - startX] = mx;
  }
  g.beginPath();
  for (let i = 0; i < maxs.length; i++) g.lineTo(startX + i, mid - Math.max(maxs[i] * amp, 0.5));
  for (let i = mins.length - 1; i >= 0; i--) g.lineTo(startX + i + 1, mid - Math.min(mins[i] * amp, -0.5));
  g.closePath();
  if (ghost) { g.fillStyle = withAlpha('#ffffff', 0.07); g.fill(); g.strokeStyle = withAlpha(color, alpha); g.lineWidth = 1; g.stroke(); }
  else { g.fillStyle = gradient(g, color, top, band, alpha); g.fill(); }
}

function drawRecording(g, w, hh) {
  const p = recorder.peaks;
  const sr = state.sampleRate;
  const mid = hh / 2, amp = hh / 2 * 0.9;
  g.fillStyle = 'rgba(255,77,109,0.85)';
  const blocks = p.length / 2;
  for (let x = 0; x < w; x++) {
    const t0 = xToTime(x) - state.recordStart, t1 = xToTime(x + 1) - state.recordStart;
    if (t1 < 0) continue;
    const b0 = Math.max(0, Math.floor((t0 * sr) / PEAK_BLOCK)), b1 = Math.min(blocks, Math.ceil((t1 * sr) / PEAK_BLOCK));
    if (b0 >= blocks) break;
    let mn = 0, mx = 0;
    for (let i = b0; i < b1; i++) { if (p[i * 2] < mn) mn = p[i * 2]; if (p[i * 2 + 1] > mx) mx = p[i * 2 + 1]; }
    g.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
  }
}

// ---- Ruler ----------------------------------------------------------------------------

const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
function tickStep() {
  const step = STEPS.find((s) => s * state.view.pps >= 90) ?? 3600;
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
  const w = cv.width / k, hh = cv.height / k;
  g.clearRect(0, 0, w, hh);

  const { start, end } = state.selection;
  if (end > start) {
    g.fillStyle = state.loop ? 'rgba(47,212,198,0.28)' : 'rgba(139,123,255,0.28)';
    g.fillRect(timeToX(start), 0, timeToX(end) - timeToX(start), hh);
  }
  const { step, minor } = tickStep();
  g.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.textBaseline = 'top';
  const t0 = Math.floor(state.view.scrollX / minor) * minor;
  for (let i = 0; ; i++) {
    const t = t0 + i * minor;
    const x = Math.round(timeToX(t));
    if (x > w) break;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    g.fillStyle = major ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)';
    g.fillRect(x, major ? hh - 12 : hh - 6, 1, major ? 12 : 6);
    if (major) { g.fillStyle = 'rgba(220,226,240,0.7)'; g.fillText(fmtTick(t, step), x + 4, 6); }
  }
  // Cursor marker
  const cx = timeToX(start);
  g.fillStyle = '#a79bff';
  g.beginPath(); g.moveTo(cx - 5, hh - 8); g.lineTo(cx + 5, hh - 8); g.lineTo(cx, hh - 1); g.fill();
}

function setupRuler() {
  rulerCv.addEventListener('pointerdown', (e) => {
    const rect = rulerCv.getBoundingClientRect();
    const t0 = Math.max(0, xToTime(e.clientX - rect.left));
    let dragged = false;
    rulerCv.setPointerCapture(e.pointerId);
    setSelection(t0);
    seek(t0);
    const move = (ev) => {
      const t = Math.max(0, xToTime(ev.clientX - rect.left));
      if (Math.abs(t - t0) * state.view.pps > 3) dragged = true;
      if (dragged) setSelection(t0, t);
    };
    const up = () => { rulerCv.removeEventListener('pointermove', move); rulerCv.removeEventListener('pointerup', up); };
    rulerCv.addEventListener('pointermove', move);
    rulerCv.addEventListener('pointerup', up);
  });
}

// ---- Lane interaction ---------------------------------------------------------------

function rowIndexAt(clientY) {
  const rows = $$('.track-row:not(.recording)', rowsEl);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY < r.bottom) return i;
  }
  return rows.length - 1;
}

function setupLane(lane, cv, id) {
  lane.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    lane.style.cursor = edgeAt(e, cv, id) ? 'ew-resize' : 'text';
  });
  lane.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = cv.getBoundingClientRect();
    const tAt = (ev) => Math.max(0, xToTime(ev.clientX - rect.left));
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
      if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return;
      moved = true;
      // Dragging across rows extends the selection to those tracks.
      if (!edge) {
        const i = rowIndexAt(ev.clientY);
        const [a, b] = [Math.min(startIdx, i), Math.max(startIdx, i)];
        const ids = state.tracks.slice(a, b + 1).map((x) => x.id);
        if (!(e.metaKey || e.ctrlKey)) state.selectedIds = new Set(ids); else ids.forEach((x) => state.selectedIds.add(x));
      }
      setSelection(anchor, tt);
      autoScrollEdge(ev.clientX - rect.left);
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
  const x = e.clientX - cv.getBoundingClientRect().left;
  if (Math.abs(x - timeToX(state.selection.start)) < 6) return 'start';
  if (Math.abs(x - timeToX(state.selection.end)) < 6) return 'end';
  return null;
}

function autoScrollEdge(x) {
  const w = state.view.width;
  if (x > w - 20) { state.view.scrollX += 20 / state.view.pps; emit('view'); }
  else if (x < 20 && state.view.scrollX > 0) { state.view.scrollX -= 20 / state.view.pps; emit('view'); }
}

function setupWheel() {
  area.addEventListener('wheel', (e) => {
    const rect = rulerCv.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const x = e.clientX - rect.left;
      zoomAround(Math.exp(-e.deltaY * 0.0025), x >= 0 ? xToTime(x) : null);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      state.view.scrollX += (e.shiftKey ? e.deltaY : e.deltaX) / state.view.pps;
      emit('view');
    }
  }, { passive: false });
}

// ---- Horizontal scrollbar ----------------------------------------------------------------

function updateScrollbar() {
  const total = contentDuration();
  const visible = state.view.width / state.view.pps;
  const bw = hbar.clientWidth;
  const tw = Math.max(36, (visible / total) * bw);
  hthumb.style.width = `${tw}px`;
  hthumb.style.transform = `translateX(${(state.view.scrollX / Math.max(1e-9, total - visible)) * (bw - tw) || 0}px)`;
  hbar.classList.toggle('hidden', visible >= total - 1e-6);
}

function setupScrollbar() {
  hthumb.addEventListener('pointerdown', (e) => {
    hthumb.setPointerCapture(e.pointerId);
    const x0 = e.clientX, s0 = state.view.scrollX;
    const move = (ev) => {
      const total = contentDuration(), visible = state.view.width / state.view.pps;
      const bw = hbar.clientWidth, tw = hthumb.clientWidth;
      state.view.scrollX = s0 + ((ev.clientX - x0) / (bw - tw)) * (total - visible);
      emit('view');
    };
    const up = () => { hthumb.removeEventListener('pointermove', move); hthumb.removeEventListener('pointerup', up); };
    hthumb.addEventListener('pointermove', move);
    hthumb.addEventListener('pointerup', up);
  });
}

// ---- Transport / animation ------------------------------------------------------------------

function onTransport() {
  const hasRecRow = !!rowsEl.querySelector('.recording');
  if (state.recording !== hasRecRow) renderRows();
}

let lastRecDraw = 0;
function frame(now) {
  const pos = state.recording ? state.recordStart + recorder.frames / state.sampleRate : tick();
  emit('frame', pos);

  // Playhead + follow
  const x = timeToX(pos);
  if ((state.playing || state.recording) && (x > state.view.width - 30 || x < 0)) {
    state.view.scrollX = Math.max(0, pos - (state.view.width * 0.1) / state.view.pps);
    emit('view');
  }
  const px = timeToX(pos);
  playheadEl.style.transform = `translateX(${HEAD_W + px}px)`;
  playheadEl.style.opacity = px < 0 || px > state.view.width ? 0 : 1;
  playheadEl.classList.toggle('live', state.playing || state.recording);
  playheadEl.classList.toggle('rec', state.recording);

  if (state.recording && now - lastRecDraw > 60) {
    lastRecDraw = now;
    const row = rowsEl.querySelector('.recording');
    if (row) {
      drawRow(row);
      row.querySelector('.rec-time').textContent = formatTime(recorder.frames / state.sampleRate);
      const lvl = recorder.inputLevel();
      row.querySelector('.rec-meter .fill').style.width = `${Math.min(100, Math.max(0, (1 + Math.log10(Math.max(lvl, 1e-4)) / 3) * 100))}%`;
    }
  }
  requestAnimationFrame(frame);
}

