// Reusable UI pieces: icons, badges, expiry meter, toasts, dialogs, empty/loading states.
import { $, html, raw, esc, render, relDays } from './core.js';

// ---------- icons (24px stroke icons, currentColor) ----------
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  cart: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1zm8 0a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  truck: 'M2 6h11v10H2zM13 10h4l4 4v2h-8M6 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  flask: 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  tag: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 18l-6-6 6-6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-4M12 8h.01',
  menu: 'M4 6h16M4 12h16M4 18h16',
  receipt: 'M5 3v18l2.5-1.5L10 21l2-1.5 2 1.5 2.5-1.5L19 21V3l-2.5 1.5L14 3l-2 1.5L10 3 7.5 4.5zM9 9h6M9 13h6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z',
};
export const icon = (name, cls = '') =>
  raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name] ?? ''}"/></svg>`);

// ---------- status ----------
export const STATUS = {
  active: ['Good', 'ok'], near_expiry: ['Expiring soon', 'warn'], expired: ['Expired', 'bad'], written_off: ['Written off', 'mute'],
  depleted: ['Sold out', 'mute'], draft: ['Draft', 'mute'], ordered: ['Ordered', 'info'], received: ['Received', 'ok'], cancelled: ['Cancelled', 'bad'],
  discount: ['Discount it', 'warn'], return_to_supplier: ['Return to supplier', 'bad'], none: ['Will sell in time', 'ok'],
  low: ['Low confidence', 'warn'], normal: ['Normal confidence', 'info'], yes: ['Beats both', 'ok'], no: ['Does not beat', 'bad'],
  owner: ['Owner', 'info'], staff: ['Staff', 'mute'], good: ['Good', 'ok'],
};
export const badge = (key, label) => {
  const [text, tone] = STATUS[key] ?? [key, 'mute'];
  return html`<span class="pill pill-${tone}">${label ?? text}</span>`;
};

/**
 * Expiry meter: a bar that empties as the expiry date approaches (full = 1 year or more left).
 * Colour and caption say the same thing, so it isn't colour-only.
 */
export function expiryMeter(daysLeft, nearDays = 60) {
  const tone = daysLeft < 0 ? 'bad' : daysLeft <= nearDays ? 'warn' : 'ok';
  const fill = daysLeft < 0 ? 100 : Math.max(4, Math.min(100, (daysLeft / 365) * 100));
  return html`<span class="meter meter-${tone}" title="${relDays(daysLeft)}"><span class="meter-bar"><span style="width:${fill}%"></span></span><span class="meter-text">${relDays(daysLeft)}</span></span>`;
}

// ---------- page scaffolding ----------
export const pageHeader = (title, subtitle = '', actions = '') =>
  html`<header class="page-head"><div><h1>${title}</h1>${subtitle ? html`<p class="lede">${subtitle}</p>` : ''}</div><div class="page-actions">${actions}</div></header>`;

export const emptyState = (iconName, title, text = '', action = '') =>
  html`<div class="empty">${icon(iconName, 'icon-xl')}<h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}${action}</div>`;

export const skeleton = (rows = 4) =>
  html`<div class="skeleton-wrap" aria-busy="true" aria-label="Loading">${Array.from({ length: rows }, (_, i) => html`<div class="skeleton" style="width:${92 - i * 9}%"></div>`)}</div>`;

export const callout = (tone, iconName, content) => html`<div class="callout callout-${tone}" role="${tone === 'bad' ? 'alert' : 'status'}">${icon(iconName)}<div>${content}</div></div>`;

// ---------- toasts ----------
export function toast(message, tone = 'ok') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  render(el, html`${icon(tone === 'bad' ? 'alert' : tone === 'warn' ? 'info' : 'check')}<span>${message}</span>`);
  host.append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, tone === 'bad' ? 6000 : 3500);
}

// ---------- dialogs (native <dialog>: focus trap + Esc for free) ----------
/**
 * Open a modal. `body` is html``; `onSubmit(formData, dialog)` may throw to show an inline error
 * and keep the dialog open. Resolves with onSubmit's result, or null if dismissed.
 */
export function openDialog({ title, body, submitLabel = 'Save', tone = 'primary', cancelLabel = 'Cancel', onSubmit, onOpen, wide = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = `dialog ${wide ? 'dialog-wide' : ''}`;
    render(dlg, html`<form method="dialog" class="dialog-form" novalidate>
      <header class="dialog-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="dialog-body">${body}<p class="field-error" data-error role="alert"></p></div>
      <footer class="dialog-foot"><button type="button" class="btn" data-close>${cancelLabel}</button>
        <button type="submit" class="btn btn-${tone}">${submitLabel}</button></footer></form>`);
    document.body.append(dlg);
    let result = null;
    const close = () => dlg.close();
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // backdrop click
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    const form = dlg.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; btn.classList.add('loading');
      try {
        result = onSubmit ? await onSubmit(new FormData(form), dlg) : true;
        if (result === undefined) result = true;
        close();
      } catch (err) {
        form.querySelector('[data-error]').textContent = err.message;
        btn.disabled = false; btn.classList.remove('loading');
      }
    });
    dlg.showModal();
    onOpen?.(dlg);
    dlg.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  });
}

export const confirmDialog = ({ title, message, confirmLabel = 'Confirm', tone = 'primary' }) =>
  openDialog({ title, body: html`<p>${message}</p>`, submitLabel: confirmLabel, tone });

/** Wrap a click handler: disable the button and show a spinner until it settles. */
export function busy(button, fn) {
  return async (...args) => {
    if (button.disabled) return;
    button.disabled = true; button.classList.add('loading');
    try { return await fn(...args); } finally { button.disabled = false; button.classList.remove('loading'); }
  };
}

export { esc };

/** Side drawer (native <dialog>). Returns the dialog element; `body` can be replaced later via render(). */
export function openDrawer({ title, subtitle = '', body, onClose }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'drawer';
  render(dlg, html`<header class="drawer-head"><div><h2>${title}</h2>${subtitle ? html`<p class="muted small">${subtitle}</p>` : ''}</div>
    <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header><div class="drawer-body">${body}</div>`);
  document.body.append(dlg);
  const close = () => dlg.close();
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.querySelector('[data-close]').addEventListener('click', close);
  // Close the drawer if the user navigates away with the browser's back button.
  window.addEventListener('hashchange', close, { once: true });
  dlg.showModal();
  return dlg;
}

/** Tiny bar chart as inline SVG — no library, scales to its container. */
export function barSpark(values, { labels = [], height = 64, highlightLast = true, format = (v) => v } = {}) {
  const max = Math.max(1, ...values);
  const w = 100 / values.length;
  return html`<svg class="spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none" role="img" aria-label="Trend chart">
    ${values.map((v, i) => {
      const h = Math.max(1.5, (v / max) * (height - 4));
      return html`<rect x="${i * w + w * 0.15}" y="${height - h}" width="${w * 0.7}" height="${h}" rx="1"
        class="${highlightLast && i === values.length - 1 ? 'is-last' : ''}"><title>${labels[i] ?? ''}: ${format(v)}</title></rect>`;
    })}</svg>`;
}
