// Shell: auth, navigation, routing.
import { $, $$, api, state, html, render, isOwner, setUnauthorizedHandler, fmtDate } from './core.js';
import { icon, callout, skeleton } from './ui.js';
import * as dashboard from './pages/dashboard.js';
import * as sell from './pages/sell.js';
import * as stock from './pages/stock.js';
import * as purchases from './pages/purchases.js';
import * as forecast from './pages/forecast.js';
import * as model from './pages/model.js';
import * as history from './pages/history.js';
import * as catalog from './pages/catalog.js';
import * as staff from './pages/staff.js';

const view = $('#view');

const ROUTES = {
  dashboard: { title: 'Dashboard', icon: 'home', group: 'Counter', page: dashboard, tab: true },
  sell: { title: 'Sell', icon: 'cart', group: 'Counter', page: sell, tab: true },
  stock: { title: 'Stock & expiry', short: 'Stock', icon: 'box', group: 'Counter', page: stock, tab: true, countKey: 'expiry' },
  purchase: { title: 'Purchase orders', short: 'Orders', icon: 'truck', group: 'Purchasing', page: purchases, tab: true },
  forecast: { title: 'Forecast & reorder', short: 'Forecast', icon: 'trend', group: 'Insights', page: forecast, owner: true, tab: true },
  model: { title: 'Model report', icon: 'flask', group: 'Insights', page: model, owner: true },
  history: { title: 'Stock history', icon: 'history', group: 'Insights', page: history, owner: true },
  catalog: { title: 'Products & suppliers', icon: 'tag', group: 'Settings', page: catalog, owner: true },
  staff: { title: 'Staff', icon: 'users', group: 'Settings', page: staff, owner: true },
};
const allowed = ([, r]) => !r.owner || isOwner();
const counts = {};
let lastKey = null;

function renderNav(active) {
  const groups = {};
  for (const [key, r] of Object.entries(ROUTES).filter(allowed)) (groups[r.group] ??= []).push([key, r]);
  const initials = state.user.name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  render($('#sidebar'), html`
    <a class="logo" href="#/dashboard"><span class="logo-mark"><svg viewBox="0 0 32 32"><path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="currentColor"/></svg></span>PharmaStock</a>
    ${Object.entries(groups).map(([g, items]) => html`<div class="nav-group"><div class="nav-label">${g}</div>
      ${items.map(([key, r]) => html`<a class="nav-link" href="#/${key}" ${key === active ? html`aria-current="page"` : ''}>${icon(r.icon)}<span>${r.title}</span>
        ${r.countKey && counts[r.countKey] ? html`<span class="nav-count" title="Batches needing attention">${counts[r.countKey]}</span>` : ''}</a>`)}</div>`)}
    <div class="sidebar-foot"><span class="avatar">${initials}</span><div style="min-width:0;flex:1"><div class="who-name">${state.user.name}</div>
      <div class="who-meta">${isOwner() ? 'Owner' : 'Staff'} · ${fmtDate(state.today)}</div></div>
      <button class="icon-btn" id="logout" title="Log out" aria-label="Log out">${icon('logout')}</button></div>`);
  render($('#tabbar'), html`${Object.entries(ROUTES).filter(allowed).filter(([, r]) => r.tab).map(([key, r]) =>
    html`<a href="#/${key}" ${key === active ? html`aria-current="page"` : ''}>${icon(r.icon)}<span>${r.short ?? r.title}</span></a>`)}`);
  $('#logout').addEventListener('click', logout);
}

async function refreshCounts() {
  try {
    const alerts = await fetch('/api/alerts/expiry').then((r) => (r.ok ? r.json() : []));
    counts.expiry = alerts.filter((a) => a.status === 'expired').length || null;
  } catch { /* badge is optional */ }
}
window.addEventListener('stock-changed', async () => { await refreshCounts(); if (state.user) renderNav(currentKey()); });

function currentKey() {
  const [name] = location.hash.replace(/^#\/?/, '').split('/');
  return ROUTES[name] && allowed([name, ROUTES[name]]) ? name : 'dashboard';
}

async function route() {
  if (!state.user) return;
  const [, ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const key = currentKey();
  const r = ROUTES[key];
  closeNav();
  renderNav(key);
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  const seq = ++state.routeSeq;
  document.title = `${r.title} · PharmaStock`;
  const page = document.createElement('div');
  page.className = 'page';
  render(page, skeleton(6));
  view.replaceChildren(page);
  // Moving to a different page: start at the top and put keyboard/screen-reader focus on the content.
  if (key !== lastKey) { window.scrollTo(0, 0); if (lastKey) view.focus({ preventScroll: true }); }
  lastKey = key;
  try {
    await r.page.render(page, args.map(decodeURIComponent));
  } catch (e) {
    if (e.stale || seq !== state.routeSeq) return;
    render(page, callout('bad', 'alert', html`<b>Something went wrong.</b> ${e.message}`));
  }
}
window.addEventListener('hashchange', route);

// Skip link: focus the content without changing the route hash.
$('.skip').addEventListener('click', (e) => { e.preventDefault(); view.focus(); });

// ---------- mobile nav ----------
const closeNav = () => $('#shell').classList.remove('nav-open');
render($('#menu-btn'), icon('menu'));
$('#menu-btn').addEventListener('click', () => $('#shell').classList.add('nav-open'));
$('#scrim').addEventListener('click', closeNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });

// ---------- auth ----------
function showLogin() {
  state.user = null;
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
  setTimeout(() => $('#login-form [name=username]').focus(), 0);
}
setUnauthorizedHandler(showLogin);

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const btn = f.querySelector('[type=submit]');
  if (!f.username.value.trim() || !f.password.value) { $('#login-error').textContent = 'Enter your username and password.'; return; }
  btn.disabled = true; btn.classList.add('loading');
  try {
    await api('/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
    f.password.value = '';
    $('#login-error').textContent = '';
    await boot();
  } catch (e) {
    $('#login-error').textContent = e.message;
  } finally { btn.disabled = false; btn.classList.remove('loading'); }
});
$$('[data-demo]').forEach((b) => b.addEventListener('click', () => {
  const f = $('#login-form');
  f.username.value = b.dataset.demo;
  f.password.value = `${b.dataset.demo}123`;
  f.requestSubmit();
}));

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user;
    state.today = me.today;
  } catch { showLogin(); return; }
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  if (!location.hash) location.hash = isOwner() ? '#/dashboard' : '#/sell';
  await refreshCounts();
  route();
}

boot();
