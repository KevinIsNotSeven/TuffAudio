// Right-hand inspector: the non-destructive effect ("modifier") stack for the active track.

import { state, on, emit, activeTrack, checkpoint, hasRange, prefs } from '../state.js';
import { EFFECTS, CATEGORIES, PRESETS, createEffect, defaultParams } from '../audio/effects.js';
import { run, addEffect, addPreset, applyEffect } from '../actions.js';
import { $, h, iconEl, popover, closeMenu, segmented } from './dom.js';

let root;

export function initInspector() {
  root = $('#inspector');
  const rerender = () => render();
  on('active', rerender);
  on('tracks', rerender);
  on('effects-ui', (e) => render(e?.focus));
  on('view', updatePreviewToggle);
  on('prefs', (k) => { if (k === 'showPresets') render(); });
  on('focus-inspector', () => root.querySelector('.add-fx')?.focus());
  render();
}

function render(focusId) {
  const scroll = root.scrollTop;
  const t = activeTrack();
  if (!t) {
    root.replaceChildren(h('div.insp-empty', {},
      h('div.insp-empty-icon', {}, iconEl('sparkles')),
      h('h3', {}, 'Effects live here'),
      h('p', {}, 'Select a track to stack effects on it. Every effect is non-destructive — tweak, reorder or switch it off any time, and only hit Apply when you want it baked in.')));
    return;
  }

  const enabledCount = t.effects.filter((e) => e.enabled).length;
  const stackHead = h('div.stack-head', {},
    h('div.stack-title', {}, h('h3', {}, 'Effects'), h('span.track-chip', { title: 'Effects for this track' }, h('span.dot', { style: { background: t.color } }), t.name)),
    h('div.stack-tools', {},
      h('button.icon-btn.ghost.preview-toggle', { title: 'Show effect result in the waveform (V)', onclick: () => run('toggleProcessed') }),
      h('button.btn.sm', { disabled: !enabledCount, title: 'Bake all active effects into the audio', onclick: () => run('applyAll') }, iconEl('check'), 'Apply all')));

  const list = h('div.fx-list');
  t.effects.forEach((fx, i) => list.append(card(t, fx, i, fx.id === focusId)));
  if (!t.effects.length) {
    list.append(h('div.fx-empty', {}, prefs.showPresets ? 'No effects yet. Add one below or start from a preset — you can always change your mind.' : 'No effects yet. Add one below — you can always change your mind.'));
  }

  const addBtn = h('button.add-fx', { onclick: (e) => browser(e.currentTarget) }, iconEl('plus'), 'Add effect');
  const presets = prefs.showPresets && h('div.presets', {},
    h('div.field-label', {}, 'Quick presets'),
    h('div.preset-chips', {}, ...PRESETS.map((p) => h('button.chip.preset', { title: p.description, onclick: () => addPreset(p) }, iconEl('sparkles'), p.name))));

  root.replaceChildren(h('section.insp-card.stack', {}, stackHead, list, addBtn, presets));
  updatePreviewToggle();
  root.scrollTop = scroll;
  if (focusId) list.querySelector(`[data-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updatePreviewToggle() {
  const b = root?.querySelector('.preview-toggle');
  if (!b) return;
  b.replaceChildren(iconEl(state.showProcessed ? 'eye' : 'eyeOff'));
  b.classList.toggle('on', state.showProcessed);
}

// ---- Effect card -----------------------------------------------------------------------

function card(t, fx, index, isNew) {
  const def = EFFECTS[fx.type];
  const sw = h('button.switch', {
    class: fx.enabled ? 'on' : '', title: fx.enabled ? 'Disable (bypass)' : 'Enable',
    onclick: () => { checkpoint(`${fx.enabled ? 'Disable' : 'Enable'} ${def.name}`); fx.enabled = !fx.enabled; emitFx(t, fx, true); render(); },
  }, h('span'));

  const body = h('div.fx-body');
  for (const p of def.params) body.append(paramControl(t, fx, p));
  if (!def.params.length) body.append(h('p.fx-note', {}, def.description));

  const el = h('div.fx-card', { 'data-id': fx.id, class: [fx.enabled ? '' : 'off', fx.collapsed ? 'collapsed' : '', isNew ? 'new' : ''].join(' ') },
    h('div.fx-head', {},
      h('span.grip', { title: 'Drag to reorder' }, iconEl('grip')),
      sw,
      h('span.fx-icon', {}, iconEl(def.icon)),
      h('button.fx-title', { onclick: () => { fx.collapsed = !fx.collapsed; el.classList.toggle('collapsed', fx.collapsed); }, title: def.description },
        h('span.chev', {}, iconEl('chevron')),
        h('span.fx-name', {}, def.name),
        h('small', { class: def.kind === 'node' ? 'live' : 'render', title: def.kind === 'node' ? 'Adjusts live while playing' : 'Re-rendered after you adjust it' }, def.kind === 'node' ? 'live' : 'render')),
      h('button.icon-btn.ghost.sm.apply-btn', { title: 'Apply — bake this effect into the audio', onclick: () => applyEffect(t, fx.id) }, iconEl('check')),
      h('button.icon-btn.ghost.sm', { title: 'More', onclick: (e) => cardMenu(t, fx, index, e.currentTarget) }, iconEl('more'))),
    body);
  setupDrag(el, t, fx);
  return el;
}

function emitFx(t, fx, structural) {
  emit('effects', { id: t.id, fxId: fx.id, structural });
  return true;
}

function cardMenu(t, fx, index, anchor) {
  const def = EFFECTS[fx.type];
  popover(anchor, [
    { label: 'Apply to whole track', icon: 'check', run: () => applyEffect(t, fx.id) },
    { label: 'Apply to selection only', icon: 'crop', disabled: !hasRange(), run: () => applyEffect(t, fx.id, { selectionOnly: true }) },
    { separator: true },
    { label: 'Duplicate', icon: 'copy', run: () => { checkpoint(`Duplicate ${def.name}`); t.effects.splice(index + 1, 0, createEffect(fx.type, fx.params)); emitFx(t, fx, true); render(); } },
    { label: 'Reset to defaults', icon: 'refresh', run: () => { checkpoint(`Reset ${def.name}`); fx.params = defaultParams(fx.type); emitFx(t, fx, true); render(); } },
    { label: 'Move up', icon: 'arrowUp', disabled: index === 0, run: () => move(t, index, index - 1) },
    { label: 'Move down', icon: 'arrowDown', disabled: index === t.effects.length - 1, run: () => move(t, index, index + 1) },
    { separator: true },
    { label: 'Remove', icon: 'trash', danger: true, run: () => { checkpoint(`Remove ${def.name}`); t.effects.splice(index, 1); emitFx(t, fx, true); render(); } },
  ], { align: 'end' });
}

function move(t, from, to) {
  if (to < 0 || to >= t.effects.length || from === to) return;
  checkpoint('Reorder effects');
  const [fx] = t.effects.splice(from, 1);
  t.effects.splice(to, 0, fx);
  emitFx(t, fx, true);
  render();
}

function setupDrag(el, t, fx) {
  const grip = el.querySelector('.grip');
  grip.addEventListener('pointerdown', () => { el.draggable = true; });
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-tuff-fx', fx.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
  el.addEventListener('dragend', () => { el.draggable = false; el.classList.remove('dragging'); });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-tuff-fx')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    el.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
    el.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('text/x-tuff-fx');
    const after = el.classList.contains('drop-after');
    el.classList.remove('drop-before', 'drop-after');
    if (!id || id === fx.id) return;
    e.preventDefault();
    const from = t.effects.findIndex((x) => x.id === id);
    let to = t.effects.findIndex((x) => x.id === fx.id) + (after ? 1 : 0);
    if (from < to) to--;
    move(t, from, to);
  });
}

// ---- Parameter controls -----------------------------------------------------------------

function paramControl(t, fx, p) {
  let gesture = false;
  const begin = () => { if (!gesture) { checkpoint(`Adjust ${EFFECTS[fx.type].name}`); gesture = true; } };
  const end = () => { gesture = false; };

  if (p.type === 'select') {
    return h('div.param.select', {},
      h('label', {}, p.label),
      segmented(p.options, fx.params[p.key], (v) => { begin(); end(); fx.params[p.key] = v; emitFx(t, fx, false); }, 'sm'));
  }

  const toPos = (v) => (p.log ? (Math.log(v / p.min) / Math.log(p.max / p.min)) * 1000 : v);
  const fromPos = (x) => {
    if (!p.log) return x;
    const v = p.min * Math.pow(p.max / p.min, x / 1000);
    const st = p.step || 0.01;
    return Math.min(p.max, Math.max(p.min, Math.round(v / st) * st));
  };
  const val = h('output', {}, fmt(p, fx.params[p.key]));
  const input = h('input.range', {
    type: 'range',
    min: p.log ? 0 : p.min, max: p.log ? 1000 : p.max, step: p.log ? 1 : p.step,
    value: toPos(fx.params[p.key]),
  });
  const paint = () => {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--pct', `${pct}%`);
  };
  const setVal = (v) => {
    fx.params[p.key] = v;
    val.textContent = fmt(p, v);
    paint();
    emitFx(t, fx, false);
  };
  input.addEventListener('pointerdown', begin);
  input.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown') begin(); e.stopPropagation(); });
  input.addEventListener('input', () => setVal(fromPos(Number(input.value))));
  input.addEventListener('change', end);
  input.addEventListener('dblclick', () => { begin(); end(); input.value = toPos(p.default); setVal(p.default); });
  paint();
  return h('div.param', { title: 'Double-click to reset' }, h('div.param-top', {}, h('label', {}, p.label), val), input);
}

const fmt = (p, v) => (p.format ? p.format(v) : String(v));

// ---- Effect browser ---------------------------------------------------------------------------

function browser(anchor) {
  const search = h('input.search', { placeholder: 'Search effects…', spellcheck: false });
  const grid = h('div.fx-browser-grid');
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    grid.replaceChildren();
    let first = null;
    for (const cat of CATEGORIES) {
      const items = Object.entries(EFFECTS).filter(([, d]) => d.category === cat && (!q || `${d.name} ${d.description} ${cat}`.toLowerCase().includes(q)));
      if (!items.length) continue;
      grid.append(h('div.fxb-cat', {}, cat));
      for (const [type, d] of items) {
        const b = h('button.fxb-item', { onclick: () => { closeMenu(); addEffect(type); } },
          h('span.fx-icon', {}, iconEl(d.icon)),
          h('span.fxb-text', {}, h('strong', {}, d.name), h('small', {}, d.description)));
        first ??= b;
        grid.append(b);
      }
    }
    const presets = prefs.showPresets ? PRESETS.filter((p) => !q || p.name.toLowerCase().includes(q)) : [];
    if (presets.length) {
      grid.append(h('div.fxb-cat', {}, 'Presets'));
      for (const p of presets) {
        const b = h('button.fxb-item', { onclick: () => { closeMenu(); addPreset(p); } },
          h('span.fx-icon.preset', {}, iconEl('sparkles')),
          h('span.fxb-text', {}, h('strong', {}, p.name), h('small', {}, p.description)));
        first ??= b;
        grid.append(b);
      }
    }
    if (!grid.children.length) grid.append(h('div.fxb-none', {}, 'No matching effects'));
    return first;
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') draw()?.click();
    if (e.key === 'Escape') closeMenu();
  });
  draw();
  popover(anchor, h('div.fx-browser', {}, search, grid), { className: 'wide' });
  search.focus();
}
