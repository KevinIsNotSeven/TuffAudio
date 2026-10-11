// TuffAudio renderer entry: wires toolbar, shortcuts, recording source picker,
// status bar, drag-and-drop and the command palette.

import { state, on, hasRange, projectDuration } from './state.js';
import { actions, run, importFiles, recorder } from './actions.js';
import { masterLevels } from './audio/engine.js';
import { listSources } from './audio/recorder.js';
import { initTimeline } from './ui/timeline.js';
import { initInspector } from './ui/inspector.js';
import { $, $$, h, iconEl, popover, closeMenu, modal, segmented, formatTime, toast } from './ui/dom.js';
import { icon } from './ui/icons.js';

const isMac = /Mac/.test(navigator.platform) || window.tuffNative?.platform === 'darwin';

function boot() {
  if (window.tuffNative) document.body.classList.add('native', `os-${window.tuffNative.platform}`);

  // Inject icons declared in markup.
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  for (const k of $$('kbd')) if (isMac) k.textContent = k.textContent.replace('Ctrl', '⌘');

  // Toolbar buttons → actions
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    run(b.dataset.action);
  });

  initTimeline();
  initInspector();
  setupSourcePicker();
  setupKeyboard();
  setupDragDrop();

  for (const evt of ['selection', 'tracks', 'history', 'active', 'transport', 'effects-ui', 'effects', 'audio']) on(evt, refreshUi);
  on('project', () => { $('#projectName').textContent = state.projectName; document.title = `${state.projectName} — TuffAudio`; });
  on('frame', onFrame);
  on('palette', openPalette);
  on('shortcuts', showShortcuts);
  refreshUi();
}

// ---- Toolbar state ---------------------------------------------------------------

function refreshUi() {
  for (const b of $$('[data-action]')) {
    const a = actions[b.dataset.action];
    if (a) b.disabled = !a.enabled();
  }
  const play = $('#playBtn');
  play.innerHTML = icon(state.playing ? 'pause' : 'play');
  play.classList.toggle('on', state.playing);
  $('#recBtn').classList.toggle('recording', state.recording);
  $('#recBtn').classList.toggle('arming', recorder.busy && !state.recording);
  $('#recBtn').disabled = false;
  $('#loopBtn').classList.toggle('on', state.loop);
  for (const id of ['undo', 'redo']) {
    const b = $(`[data-action="${id}"]`);
    b.title = `${actions[id].dynamicLabel()} (${id === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z'})`;
  }
  document.body.classList.toggle('is-recording', state.recording);
  document.body.classList.toggle('is-playing', state.playing || state.recording);

  const { start, end } = state.selection;
  $('#sbSel').textContent = hasRange()
    ? `Selection ${formatTime(start)} → ${formatTime(end)}  (${formatTime(end - start)})`
    : `Cursor ${formatTime(start)}`;
  $('#clockSub').textContent = hasRange() ? `sel ${formatTime(end - start)}` : `of ${formatTime(projectDuration())}`;
  $('#sbInfo').textContent = state.tracks.length
    ? `${state.tracks.length} track${state.tracks.length > 1 ? 's' : ''} · ${(state.sampleRate / 1000).toFixed(1)} kHz · 32-bit float`
    : '';
}

// ---- Per-frame: clock + meters ------------------------------------------------------

const meterState = [{ peak: 0, hold: 0 }, { peak: 0, hold: 0 }];
function onFrame(pos) {
  $('#clock').textContent = formatTime(pos);
  const lv = state.playing ? masterLevels() : [0, 0];
  const bars = $$('.master-meter .mbar');
  lv.forEach((l, i) => {
    const db = 20 * Math.log10(Math.max(l, 1e-5));
    const pct = Math.max(0, Math.min(1, (db + 60) / 60));
    const m = meterState[i];
    m.peak = Math.max(pct, m.peak - 0.02);
    m.hold = pct >= m.hold ? pct : Math.max(0, m.hold - 0.004);
    bars[i].querySelector('i').style.transform = `scaleX(${m.peak})`;
    bars[i].querySelector('b').style.left = `${m.hold * 100}%`;
    bars[i].classList.toggle('clip', l >= 0.999);
  });
}

// ---- Record source picker ------------------------------------------------------------

const KIND_ICON = { input: 'mic', desktop: 'monitor', mix: 'layers' };
let sources = [];

function shortLabel(s) {
  if (!s) return 'Microphone';
  if (s.id === 'desktop') return 'Desktop audio';
  if (s.id === 'mix') return 'Desktop + mic';
  return s.label.replace(/\s*\(.*?\)\s*$/, '').replace(/^Default - /, '');
}

function updateSourceButton() {
  const s = sources.find((x) => x.id === state.recordSource) || { id: state.recordSource, label: 'Default microphone', kind: 'input' };
  $('#srcIcon').innerHTML = icon(KIND_ICON[s.kind]);
  $('#srcLabel').textContent = `${shortLabel(s)} · ${state.recordChannels === 1 ? 'Mono' : 'Stereo'}`;
}

function setupSourcePicker() {
  const btn = $('#sourceBtn');
  listSources().then((s) => { sources = s; updateSourceButton(); });
  updateSourceButton();
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => { sources = await listSources(); updateSourceButton(); });

  btn.addEventListener('click', async () => {
    sources = await listSources({ askPermission: true });
    updateSourceButton();
    const groups = [
      ['input', 'Microphone & line-in'],
      ['desktop', 'Desktop audio'],
      ['mix', 'Mix'],
    ];
    const panel = h('div.source-panel');
    for (const [kind, title] of groups) {
      const items = sources.filter((s) => s.kind === kind);
      if (!items.length) continue;
      panel.append(h('div.menu-heading', {}, title));
      for (const s of items) {
        panel.append(h('button.menu-item', {
          class: s.id === state.recordSource ? 'checked' : '',
          onclick: () => { state.recordSource = s.id; if (kind !== 'input') state.recordChannels = 2; updateSourceButton(); closeMenu(); },
        }, iconEl(KIND_ICON[s.kind]), h('span.menu-label', {}, s.label), s.id === state.recordSource ? iconEl('check') : null));
      }
    }
    if (window.tuffNative?.platform === 'linux' || /Linux/.test(navigator.platform)) {
      panel.append(h('p.source-note', {}, 'Linux tip: if “System audio” is silent, choose a “Monitor of …” input — that is your desktop output.'));
    }
    panel.append(h('div.menu-sep'), h('div.source-ch', {}, h('span', {}, 'Record as'),
      segmented([[1, 'Mono', 'mono'], [2, 'Stereo', 'stereo']], state.recordChannels, (v) => { state.recordChannels = v; updateSourceButton(); }, 'sm')));
    popover(btn, panel);
  });
}

// ---- Keyboard ---------------------------------------------------------------------------

function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key === '+') key = '=';
  else if (key === '_') key = '-';
  else if (key.length === 1) key = key.toUpperCase();
  if (e.shiftKey && key.length > 1 || (e.shiftKey && /^[A-Z0-9]$/.test(key))) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function setupKeyboard() {
  const map = new Map();
  for (const a of Object.values(actions)) if (a.keys) map.set(a.keys, a.id);
  map.set('Backspace', 'delete');
  map.set('Mod+Y', 'redo');
  map.set('Mod+Shift+E', 'export');

  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]') && e.target.type !== 'range';
    if (typing && e.key !== 'Escape') return;
    if (e.target.type === 'range' && e.key.startsWith('Arrow')) return;
    const combo = comboOf(e);
    const id = map.get(combo);
    if (!id) return;
    e.preventDefault();
    if (e.repeat && !['zoomIn', 'zoomOut'].includes(id)) return;
    const a = actions[id];
    if (!a.enabled()) {
      if (['trim', 'delete', 'silence', 'cut', 'copy'].includes(id)) toast('Select a region first — drag across a waveform', { type: 'warn' });
      return;
    }
    a.run();
  });
}

// ---- Drag & drop -----------------------------------------------------------------------

function setupDragDrop() {
  const overlay = $('#dropOverlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; overlay.classList.add('show'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; overlay.classList.remove('show'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
    importFiles([...e.dataTransfer.files]);
  });
}

// ---- Command palette ---------------------------------------------------------------------

const prettyKeys = (k) => k?.replace('Mod', isMac ? '⌘' : 'Ctrl').replace(/\+/g, ' ');

function openPalette() {
  if ($('.palette')) return;
  const input = h('input.palette-input', { placeholder: 'Type a command — trim, mono, reverb, export…', spellcheck: false });
  const list = h('div.palette-list');
  let items = [], sel = 0;
  const all = Object.values(actions).filter((a) => a.id !== 'palette' && a.label);
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    items = all.filter((a) => {
      const hay = `${a.dynamicLabel?.() || a.label} ${a.group} ${a.description || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).sort((a, b) => Number(b.enabled()) - Number(a.enabled()));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.slice(0, 60).map((a, i) => h('button.palette-item', {
      class: [i === sel ? 'sel' : '', a.enabled() ? '' : 'disabled'].join(' '),
      onclick: () => exec(a),
      onpointermove: () => { if (sel !== i) { sel = i; draw(); } },
    }, iconEl(a.icon || 'command'), h('span.pl-label', {}, a.dynamicLabel?.() || a.label, a.description ? h('small', {}, a.description) : null), h('span.pl-group', {}, a.group), a.keys ? h('kbd', {}, prettyKeys(a.keys)) : null)));
    if (!items.length) list.append(h('div.palette-empty', {}, 'No matching commands'));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { input.blur(); back.classList.remove('show'); setTimeout(() => back.remove(), 150); };
  const exec = (a) => { if (!a.enabled()) return; close(); setTimeout(() => a.run(), 10); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[sel]) exec(items[sel]); }
    else if (e.key === 'Escape') close();
  });
  const back = h('div.palette-back', { onpointerdown: (e) => { if (e.target === back) close(); } },
    h('div.palette', {}, h('div.palette-search', {}, iconEl('search'), input), list));
  document.body.append(back);
  draw();
  requestAnimationFrame(() => { back.classList.add('show'); input.focus(); });
}

function showShortcuts() {
  const groups = {};
  for (const a of Object.values(actions)) if (a.keys) (groups[a.group] ||= []).push(a);
  const body = h('div.shortcuts', {}, ...Object.entries(groups).map(([g, list]) => h('div.sc-group', {},
    h('h4', {}, g), ...list.map((a) => h('div.sc-row', {}, h('span', {}, a.label), h('kbd', {}, prettyKeys(a.keys)))))),
  h('div.sc-group', {}, h('h4', {}, 'Mouse'),
    h('div.sc-row', {}, h('span', {}, 'Select region'), h('kbd', {}, 'Drag')),
    h('div.sc-row', {}, h('span', {}, 'Select whole track'), h('kbd', {}, 'Double-click')),
    h('div.sc-row', {}, h('span', {}, 'Extend selection'), h('kbd', {}, 'Shift Click')),
    h('div.sc-row', {}, h('span', {}, 'Zoom'), h('kbd', {}, `${isMac ? '⌘' : 'Ctrl'} Scroll`)),
    h('div.sc-row', {}, h('span', {}, 'Pan'), h('kbd', {}, 'Shift Scroll')),
    h('div.sc-row', {}, h('span', {}, 'Reset a slider'), h('kbd', {}, 'Double-click'))));
  modal({ title: 'Keyboard shortcuts', body, width: 620, actions: [{ label: 'Done', primary: true }] });
}

boot();
