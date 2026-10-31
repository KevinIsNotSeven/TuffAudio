// TuffAudio renderer entry: wires the title-bar menus, toolbar, shortcuts (customisable),
// themes, update check, recording source picker, status bar, drag-and-drop and the
// command palette.

import { state, on, emit, hasRange, projectDuration, prefs, setPref } from './state.js';
import { actions, run, importFiles, recorder } from './actions.js';
import { masterLevels } from './audio/engine.js';
import { listSources } from './audio/recorder.js';
import { initTimeline } from './ui/timeline.js';
import { initInspector } from './ui/inspector.js';
import { $, $$, h, iconEl, popover, closeMenu, modal, segmented, formatTime, toast } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { VERSION, RELEASES_API, DOWNLOAD_URL } from './version.js';

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

  applyTheme(prefs.theme);
  $('#appVersion').textContent = `ver. ${VERSION.replace(/\.0$/, '')}`;
  state.recordSource = prefs.recordSource || 'in:default';
  state.recordChannels = prefs.recordChannels || 2;

  initTimeline();
  initInspector();
  setupSourcePicker();
  setupKeyboard();
  setupDragDrop();
  setupInspectorResize();
  setupSettings();
  setupFileMenu();
  const applyMotion = () => document.body.classList.toggle('no-anim', !prefs.smooth);
  applyMotion();
  on('prefs', (k) => { if (k === 'smooth') applyMotion(); if (k === 'autoScroll') refreshUi(); });

  for (const evt of ['selection', 'tracks', 'history', 'active', 'transport', 'effects-ui', 'effects', 'audio']) on(evt, refreshUi);
  on('project', () => { document.title = `${state.projectName} — TuffAudio`; });
  on('frame', onFrame);
  on('palette', openPalette);
  on('shortcuts', openKeybinds);
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
  $('#recBtn').classList.toggle('arming', !!recorder.busy && !state.recording);
  $('#recBtn').disabled = false;
  $('#loopBtn').classList.toggle('on', state.loop);
  $('#followBtn').classList.toggle('on', prefs.autoScroll);
  $('#followBtn').title = `Auto-scroll is ${prefs.autoScroll ? 'on' : 'off'} — the view ${prefs.autoScroll ? 'follows' : "doesn't follow"} the playhead (F)`;
  for (const id of ['undo', 'redo']) {
    const b = $(`[data-action="${id}"]`);
    b.title = `${actions[id].dynamicLabel()} (${id === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z'})`;
  }
  document.body.classList.toggle('is-recording', state.recording);
  document.body.classList.toggle('is-playing', state.playing || state.recording);

  const { start, end } = state.selection;
  // Second clock line: the selection length when there is one, otherwise the total length.
  const sub = $('#clockSub');
  sub.textContent = formatTime(hasRange() ? end - start : projectDuration());
  sub.classList.toggle('sel', hasRange());
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
    bars[i].querySelector('i').style.clipPath = `inset(0 ${(1 - m.peak) * 100}% 0 0)`;
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
          onclick: () => {
            state.recordSource = s.id;
            if (kind !== 'input') state.recordChannels = 2;
            setPref('recordSource', s.id);
            setPref('recordChannels', state.recordChannels);
            updateSourceButton();
            closeMenu();
          },
        }, iconEl(KIND_ICON[s.kind]), h('span.menu-label', {}, s.label), s.id === state.recordSource ? iconEl('check') : null));
      }
    }
    if (window.tuffNative?.platform === 'linux' || /Linux/.test(navigator.platform)) {
      panel.append(h('p.source-note', {}, 'Linux tip: if “System audio” is silent, choose a “Monitor of …” input — that is your desktop output.'));
    }
    panel.append(h('div.menu-sep'), h('div.source-ch', {}, h('span', {}, 'Record as'),
      segmented([[1, 'Mono', 'mono'], [2, 'Stereo', 'stereo']], state.recordChannels, (v) => { state.recordChannels = v; setPref('recordChannels', v); updateSourceButton(); }, 'sm')));
    popover(btn, panel);
  });
}

// ---- Resizable inspector panel -----------------------------------------------------

const INSP_MIN = 260, INSP_DEFAULT = 360;
function applyInspectorWidth(w) {
  const max = Math.max(INSP_MIN, window.innerWidth - 420);
  const clamped = Math.round(Math.max(INSP_MIN, Math.min(max, w)));
  document.documentElement.style.setProperty('--insp-w', `${clamped}px`);
  return clamped;
}

function setupInspectorResize() {
  const split = $('#inspSplit');
  applyInspectorWidth(prefs.inspectorWidth);
  window.addEventListener('resize', () => applyInspectorWidth(prefs.inspectorWidth));
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-insp');
    let w = prefs.inspectorWidth;
    const move = (ev) => { w = applyInspectorWidth(window.innerWidth - ev.clientX - 3); };
    const up = () => {
      document.body.classList.remove('resizing-insp');
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      setPref('inspectorWidth', w);
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => setPref('inspectorWidth', applyInspectorWidth(INSP_DEFAULT)));
}

// ---- Title-bar menus -------------------------------------------------------------------------

const menuItem = (id, label, iconName) => {
  const a = actions[id];
  return { label, icon: iconName, hint: prettyKeys(effectiveKeys(a)), disabled: !a.enabled(), run: () => run(id) };
};

function setupFileMenu() {
  const btn = $('#fileMenuBtn');
  btn.addEventListener('click', () => popover(btn, [
    menuItem('new', 'New', 'file'),
    menuItem('open', 'Open…', 'folder'),
    { separator: true },
    menuItem('save', 'Save', 'save'),
    menuItem('saveAs', 'Save as…', 'save'),
  ]));
}

export const THEMES = [
  { id: 'tuff', name: 'Tuff', colors: ['#2b2bff', '#e86bff'] },
  { id: 'midnight', name: 'Midnight', colors: ['#3f7bff', '#2fd4c6'] },
  { id: 'oled', name: 'OLED Black', colors: ['#000000', '#9a8cff'] },
  { id: 'sunset', name: 'Sunset', colors: ['#ff6a3d', '#ffc14d'] },
  { id: 'forest', name: 'Forest', colors: ['#1f9d6b', '#a6e35b'] },
];

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ? id : 'tuff';
  document.documentElement.dataset.theme = theme;
  emit('theme', theme);
}

function setupSettings() {
  const btn = $('#settingsBtn');
  btn.addEventListener('click', () => {
    const row = (label, sub, key) => {
      const sw = h('button.switch', { class: prefs[key] ? 'on' : '', onclick: () => { setPref(key, !prefs[key]); sw.classList.toggle('on', prefs[key]); } }, h('span'));
      return h('label.setting-row', {}, h('span.menu-label', {}, label, h('small', {}, sub)), sw);
    };
    const below = () => { const r = btn.getBoundingClientRect(); return { x: r.left, y: r.bottom }; };
    popover(btn, h('div.settings-panel', {},
      row('Smooth animations', 'Eased scrolling, zooming and transitions', 'smooth'),
      h('button.menu-item', { onclick: () => { closeMenu(); openKeybinds(); } }, iconEl('keyboard'), h('span.menu-label', {}, 'Keybinds…')),
      h('button.menu-item', { onclick: () => openThemes(below()) }, iconEl('sparkles'), h('span.menu-label', {}, 'Themes'), h('span.menu-arrow', {}, '›')),
      h('button.menu-item', { onclick: () => { closeMenu(); checkForUpdates(); } }, iconEl('refresh'), h('span.menu-label', {}, 'Check for updates…')),
      h('div.menu-sep'),
      row('Quick presets', 'One-click effect stacks like “Voice Clean-up”', 'showPresets'),
    ));
  });
}

function openThemes(at) {
  popover(at, h('div.theme-panel', {},
    h('div.menu-heading', {}, 'Theme'),
    ...THEMES.map((t) => h('button.menu-item.theme-item', {
      class: (prefs.theme || 'tuff') === t.id ? 'checked' : '',
      onclick: () => { setPref('theme', t.id); applyTheme(t.id); closeMenu(); toast(`Theme: ${t.name}`); },
    }, h('span.theme-swatch', { style: { background: `linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})` } }), h('span.menu-label', {}, t.name),
    (prefs.theme || 'tuff') === t.id ? iconEl('check') : null))));
}

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkForUpdates() {
  const busy = toast('Checking for updates…', { type: 'busy', timeout: 0 });
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    const latest = (await res.json()).tag_name || '';
    busy.close();
    if (!newer(latest, VERSION)) { toast(`You're up to date (version ${VERSION})`); return; }
    modal({
      title: 'Update available', width: 420,
      body: h('p.confirm-text', {}, `TuffAudio ${latest.replace(/^v/, '')} is out — you have ${VERSION}. Download the new TuffAudio.exe and use it in place of this one.`),
      actions: [{ label: 'Later' }, { label: 'Download', primary: true, run: () => { window.open(DOWNLOAD_URL, '_blank'); } }],
    });
  } catch (e) {
    busy.close();
    toast(`Couldn't check for updates: ${e.message}`, { type: 'error', timeout: 5000 });
  }
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

/** The shortcut for an action: the user's own binding if they set one ('' = none), else the default. */
const effectiveKeys = (a) => (prefs.keybinds && a.id in prefs.keybinds ? prefs.keybinds[a.id] : a.keys) || '';
const bindable = () => Object.values(actions).filter((a) => a.label && !a.hidden?.() && a.group && !a.id.startsWith('fx:') && !a.id.startsWith('preset:'));

let keymap = new Map();
function buildKeymap() {
  keymap = new Map([['Backspace', 'delete'], ['Mod+Y', 'redo']]);
  for (const a of Object.values(actions)) { const k = effectiveKeys(a); if (k) keymap.set(k, a.id); }
}

function setupKeyboard() {
  buildKeymap();
  on('prefs', (k) => { if (k === 'keybinds') { buildKeymap(); refreshUi(); } });
  const map = { get: (k) => keymap.get(k) };

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

const prettyKeys = (k) => (k ? k.replace('Mod', isMac ? '⌘' : 'Ctrl').replace(/\+/g, ' ') : '');

function openPalette() {
  if ($('.palette')) return;
  const input = h('input.palette-input', { placeholder: 'Type a command — trim, mono, reverb, export…', spellcheck: false });
  const list = h('div.palette-list');
  let items = [], sel = 0;
  const all = Object.values(actions).filter((a) => a.id !== 'palette' && a.label && !a.hidden?.());
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    items = all.filter((a) => {
      const hay = `${a.dynamicLabel?.() || a.label} ${a.group} ${a.description || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // Rank: enabled first, then commands whose own name matches (not just e.g. "Undo <last edit>").
    const rank = (a) => (a.enabled() ? 0 : 2) + (words.every((w) => a.label.toLowerCase().includes(w)) ? 0 : 1);
    items.sort((a, b) => rank(a) - rank(b));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.slice(0, 60).map((a, i) => h('button.palette-item', {
      class: [i === sel ? 'sel' : '', a.enabled() ? '' : 'disabled'].join(' '),
      onclick: () => exec(a),
      onpointermove: () => { if (sel !== i) { sel = i; draw(); } },
    }, iconEl(a.icon || 'command'), h('span.pl-label', {}, a.dynamicLabel?.() || a.label, a.description ? h('small', {}, a.description) : null), h('span.pl-group', {}, a.group), effectiveKeys(a) ? h('kbd', {}, prettyKeys(effectiveKeys(a))) : null)));
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

/** Keybinds editor: click a shortcut, press the new keys. Saved between sessions. */
function openKeybinds() {
  const groups = {};
  for (const a of bindable()) (groups[a.group] ||= []).push(a);
  let capturing = null;
  const save = (binds) => setPref('keybinds', binds);
  const rowFor = (a) => {
    const key = h('button.kb-key', { title: 'Click, then press the new shortcut' });
    const clear = h('button.icon-btn.ghost.sm', { title: 'Remove shortcut' }, iconEl('x'));
    const paint = () => {
      const k = effectiveKeys(a);
      key.replaceChildren(k ? prettyKeys(k) : '—');
      key.classList.toggle('none', !k);
      key.classList.toggle('custom', !!(prefs.keybinds && a.id in prefs.keybinds));
      clear.disabled = !k;
    };
    key.addEventListener('click', () => {
      if (capturing) capturing.cancel();
      key.textContent = 'Press keys…';
      key.classList.add('capturing');
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        stop();
        if (e.key === 'Escape') { paint(); return; }
        const combo = comboOf(e);
        const binds = { ...(prefs.keybinds || {}) };
        // A shortcut can only do one thing: take it away from whatever had it.
        for (const other of Object.values(actions)) {
          if (other !== a && effectiveKeys(other) === combo) { binds[other.id] = ''; toast(`${prettyKeys(combo)} moved from “${other.label}”`); }
        }
        binds[a.id] = combo;
        save(binds);
        redraw();
      };
      const stop = () => { document.removeEventListener('keydown', onKey, true); key.classList.remove('capturing'); capturing = null; };
      document.addEventListener('keydown', onKey, true);
      capturing = { cancel: () => { stop(); paint(); } };
    });
    clear.addEventListener('click', () => { save({ ...(prefs.keybinds || {}), [a.id]: '' }); redraw(); });
    paint();
    return h('div.kb-row', {}, h('span', {}, a.label), key, clear);
  };
  const body = h('div.keybinds');
  const redraw = () => body.replaceChildren(
    h('p.kb-hint', {}, 'Click a shortcut and press the keys you want. Esc cancels.'),
    ...Object.entries(groups).map(([g, list]) => h('div.kb-group', {}, h('h4', {}, g), ...list.map(rowFor))),
    h('div.kb-group', {}, h('h4', {}, 'Mouse'),
      ...[['Select a region', 'Drag down a waveform'], ['Select a whole track', 'Double-click'], ['Add an effect', 'Right-click a waveform'],
        ['Track options', 'Right-click a track header'], ['Zoom', `${isMac ? '⌘' : 'Ctrl'} + Scroll`], ['Across tracks', 'Shift + Scroll'], ['Reset a slider', 'Double-click']]
        .map(([l, k]) => h('div.kb-row', {}, h('span', {}, l), h('span.kb-mouse', {}, k)))));
  redraw();
  modal({
    title: 'Keybinds', body, width: 560,
    onClose: () => capturing?.cancel(),
    actions: [{ label: 'Reset all', run: () => { save({}); redraw(); return false; } }, { label: 'Done', primary: true }],
  });
}

boot();
