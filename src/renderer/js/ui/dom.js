// Tiny DOM helpers + shared UI widgets (toasts, menus, modals).

import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.cls#id', {props/on*}, ...children) */
export function h(tag, props = {}, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]); else el.id = m[2];
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const iconEl = (name, cls) => {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
};

export function formatTime(t, { ms = true } = {}) {
  if (!isFinite(t)) t = 0;
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * 1000);
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  const base = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return sign + base + (ms ? `.${String(f).padStart(3, '0')}` : '');
}

// ---- Toasts -----------------------------------------------------------------

export function toast(msg, { type = 'info', timeout = 2600, action } = {}) {
  let host = $('#toasts');
  if (!host) document.body.append((host = h('div#toasts')));
  const ic = { info: 'check', error: 'x', warn: 'sparkles', busy: 'refresh' }[type] || 'check';
  const el = h(`div.toast.${type}`, {}, iconEl(ic), h('span', {}, msg));
  if (action) el.append(h('button.toast-action', { onclick: () => { action.run(); close(); } }, action.label));
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); };
  if (timeout) setTimeout(close, timeout);
  return { close, set: (m) => (el.querySelector('span').textContent = m) };
}

// ---- Popover menus ----------------------------------------------------------

let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.el.remove();
  m.onClose?.();
  document.removeEventListener('pointerdown', m.outside, true);
  document.removeEventListener('keydown', m.esc, true);
}

/**
 * Show a floating panel next to `anchor` (element or {x,y}).
 * `content` is either an array of menu items or a DOM node.
 * Items: {label, icon, hint, run, disabled, danger, checked} | {separator:true} | {heading:'...'}
 */
export function popover(anchor, content, { align = 'start', onClose, className = '' } = {}) {
  // Clicking the button that opened this popover toggles it closed.
  if (openMenu && anchor instanceof Element && openMenu.anchor === anchor) { closeMenu(); return null; }
  closeMenu();
  const el = h(`div.popover${className ? '.' + className : ''}`);
  if (Array.isArray(content)) {
    el.classList.add('menu');
    for (const it of content) {
      if (it.separator) { el.append(h('div.menu-sep')); continue; }
      if (it.heading) { el.append(h('div.menu-heading', {}, it.heading)); continue; }
      const b = h('button.menu-item', {
        disabled: !!it.disabled,
        class: [it.danger && 'danger', it.checked && 'checked'].filter(Boolean).join(' '),
        onclick: () => { closeMenu(); it.run?.(); },
      },
      it.icon ? iconEl(it.icon) : h('span.i'),
      h('span.menu-label', {}, it.label, it.sub ? h('small', {}, it.sub) : null),
      it.hint ? h('kbd', {}, it.hint) : null);
      el.append(b);
    }
  } else el.append(content);
  document.body.append(el);

  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const pr = el.getBoundingClientRect();
  let x = align === 'end' ? r.right - pr.width : r.left;
  let y = r.bottom + 6;
  if (y + pr.height > innerHeight - 8) y = Math.max(8, r.top - pr.height - 6);
  x = Math.max(8, Math.min(x, innerWidth - pr.width - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  requestAnimationFrame(() => el.classList.add('show'));

  const outside = (e) => {
    if (el.contains(e.target) || (anchor instanceof Element && anchor.contains(e.target))) return;
    closeMenu();
  };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', esc, true);
  openMenu = { el, onClose, outside, esc, anchor };
  return el;
}

// ---- Modal dialog -------------------------------------------------------------

export function modal({ title, body, actions = [], width = 460, onClose }) {
  const close = () => { back.classList.remove('show'); setTimeout(() => back.remove(), 200); onClose?.(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const back = h('div.modal-back', { onpointerdown: (e) => { if (e.target === back) close(); } },
    h('div.modal', { style: { width: `${width}px` } },
      h('div.modal-head', {}, h('h2', {}, title), h('button.icon-btn.ghost', { onclick: close, title: 'Close' }, iconEl('x'))),
      h('div.modal-body', {}, body),
      h('div.modal-foot', {}, ...actions.map((a) => h(`button.btn${a.primary ? '.primary' : ''}`, { onclick: () => { if (a.run?.() !== false) close(); } }, a.label)))));
  document.body.append(back);
  document.addEventListener('keydown', esc, true);
  requestAnimationFrame(() => back.classList.add('show'));
  return { close, el: back };
}

/** Segmented control. options: [[value,label,iconName?]] */
export function segmented(options, value, onChange, cls = '') {
  const el = h(`div.seg${cls ? '.' + cls : ''}`);
  const render = (v) => {
    el.replaceChildren(...options.map(([val, label, ic]) => h('button', {
      class: val === v ? 'on' : '',
      onclick: () => { render(val); onChange(val); },
    }, ic ? iconEl(ic) : null, label)));
  };
  render(value);
  el.set = render;
  return el;
}
