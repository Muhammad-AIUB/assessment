// Stock & expiry: products with filters/sort, or every batch grouped by expiry month. Details open in a drawer.
import { api, html, render, money, num, fmtDate, fmtMonth, plural, isOwner, state, $ } from '../core.js';
import { pageHeader, icon, badge, emptyState, expiryMeter, openDrawer, callout } from '../ui.js';
import { batchTable, groupedBatchTable, bindWriteOff } from './shared.js';

const FILTERS = {
  all: ['All', () => true],
  low: ['Below minimum', (p) => p.below_min],
  out: ['Out of stock', (p) => p.usable === 0],
  expiring: ['Expiring soon', (p) => p.near_expiry > 0],
  expired: ['Has expired stock', (p) => p.expired > 0],
};
const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  usable: (a, b) => a.usable - b.usable,
  expiry: (a, b) => (a.next_expiry ?? '9999') < (b.next_expiry ?? '9999') ? -1 : 1,
  cover: (a, b) => cover(a) - cover(b),
};
const cover = (p) => (p.sold_30d ? p.usable / (p.sold_30d / 30) : Infinity); // days of stock at the recent sales rate
const daysTo = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${state.today}T00:00:00Z`)) / 86_400_000);
const prefs = { view: 'products', sort: 'name', dir: 1 };

export async function render_(el, [arg]) {
  let products = await api('/products');
  let filter = arg in FILTERS ? arg : 'all';
  let q = '';
  // Deep link to a product opens its drawer on top of the list.
  const openId = /^\d+$/.test(arg ?? '') ? Number(arg) : null;
  if (filter === 'expired' || filter === 'expiring') prefs.view = 'products';

  render(el, html`
    ${pageHeader('Stock & expiry', 'Everything on the shelf, batch by batch. Tap a product for its batches.',
      html`<div class="seg" role="group" aria-label="View"><button data-view="products">Products</button><button data-view="batches">Batches by expiry</button></div>`)}
    <div class="toolbar" id="tools">
      <div class="chips">${Object.entries(FILTERS).map(([k, [label, fn]]) => html`<button class="chip" data-filter="${k}">${label} <span class="count">${products.filter(fn).length}</span></button>`)}</div>
      <div class="search toolbar-search">${icon('search')}<input class="input" type="search" id="q" placeholder="Search product or code…" aria-label="Search stock"></div>
    </div>
    <section class="card flush" id="list"></section>`);

  async function draw() {
    el.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view)));
    el.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
    $('#tools .chips', el).hidden = prefs.view !== 'products';
    if (prefs.view === 'batches') return drawBatches();
    const needle = q.trim().toLowerCase();
    const list = products.filter(FILTERS[filter][1]).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle))
      .sort((a, b) => SORTS[prefs.sort](a, b) * prefs.dir);
    const th = (key, label, cls = '') => html`<th class="sortable ${cls}" data-sort="${key}" ${prefs.sort === key ? html`aria-sort="${prefs.dir > 0 ? 'ascending' : 'descending'}"` : ''} tabindex="0">${label}</th>`;
    render($('#list', el), list.length ? html`<div class="table-wrap"><table>
      <thead><tr>${th('name', 'Product')}${th('usable', 'Usable stock')}${th('cover', 'Lasts', 'num')}${th('expiry', 'Next expiry')}<th>Flags</th><th class="num">Price</th></tr></thead>
      <tbody>${list.map((p) => {
        const ratio = Math.min(1, p.usable / Math.max(1, p.min_level * 3));
        const c = cover(p);
        return html`<tr class="clickable" data-pid="${p.id}" tabindex="0">
          <td><span class="cell-strong">${p.name}</span><span class="sub mono">${p.sku} · ${p.supplier_name}</span></td>
          <td><div class="level ${p.usable === 0 ? 'out' : p.below_min ? 'low' : ''}"><b>${num(p.usable)} <span class="muted small">${p.unit}</span></b>
            <span class="level-bar" title="Minimum level ${p.min_level}"><span style="width:${ratio * 100}%"></span>${p.min_level ? html`<i style="left:33.3%"></i>` : ''}</span></div></td>
          <td class="num">${c === Infinity ? html`<span class="muted">no recent sales</span>` : c < 1 ? '< 1 day' : `${num(c)} days`}</td>
          <td>${p.next_expiry ? html`<div class="small cell-strong">${fmtDate(p.next_expiry)}</div>${expiryMeter(daysTo(p.next_expiry))}` : html`<span class="muted">–</span>`}</td>
          <td><div class="chips">${p.usable === 0 ? badge('expired', 'Out of stock') : p.below_min ? badge('near_expiry', 'Below min') : ''}
            ${p.expired ? badge('expired', `${p.expired} expired`) : ''}${p.on_order ? badge('ordered', `${p.on_order} on order`) : ''}</div></td>
          <td class="num">${money(p.sell_price)}</td></tr>`;
      })}</tbody></table></div>`
      : emptyState('search', 'Nothing matches', needle ? `No product matches “${q}”.` : `No products are “${FILTERS[filter][0].toLowerCase()}” — good news.`));
  }

  async function drawBatches() {
    render($('#list', el), html`<div style="padding:18px">${icon('clock')} Loading batches…</div>`);
    const batches = (await api('/batches')).filter((b) => b.status !== 'written_off');
    const needle = q.trim().toLowerCase();
    const list = batches.filter((b) => !needle || b.product_name.toLowerCase().includes(needle) || b.batch_no.toLowerCase().includes(needle));
    const groups = new Map();
    for (const b of list) {
      const key = b.status === 'expired' ? 'expired' : b.expiry_date.slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    render($('#list', el), list.length ? groupedBatchTable([...groups].map(([key, items]) => ({
      label: html`${key === 'expired' ? html`<span class="pill pill-bad">Expired — remove from shelf</span>` : fmtMonth(`${key}-01`)}<span class="count">${plural(items.length, 'batch', 'batches')} · ${num(items.reduce((s, b) => s + b.qty_on_hand, 0))} units</span>`,
      batches: items,
    })), { showProduct: true, writeOff: isOwner() })
      : emptyState('search', 'No batches match'));
    bindWriteOff($('#list', el), list, () => { refresh(); });
  }

  async function refresh() { products = await api('/products'); draw(); }

  async function openProduct(id) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    const drawer = openDrawer({ title: p.name, subtitle: `${p.sku} · ${p.supplier_name} · ${money(p.sell_price)} per ${p.unit}`, body: html`<div class="skeleton" style="height:120px"></div>` });
    const batches = (await api(`/batches?productId=${id}`)).map((b) => ({ ...b, product_name: p.name }));
    const live = batches.filter((b) => b.status !== 'written_off' && b.status !== 'depleted');
    render(drawer.querySelector('.drawer-body'), html`
      <div class="kv"><div><b>${num(p.usable)}</b><span>usable</span></div><div><b>${num(p.expired)}</b><span>expired</span></div><div><b>${num(p.on_order)}</b><span>on order</span></div></div>
      ${p.expired && isOwner() ? callout('bad', 'alert', html`${plural(p.expired, 'unit')} expired. Write the batch off below so it stops counting as stock.`) : ''}
      ${p.expired && !isOwner() ? callout('bad', 'alert', html`${plural(p.expired, 'unit')} expired. Keep them off the shelf and tell the owner — they can't be sold.`) : ''}
      <div class="row"><a class="btn btn-primary" href="#/sell">${icon('cart')}Sell</a>${isOwner() ? html`<a class="btn" href="#/forecast/${p.id}">${icon('trend')}Forecast & reorder</a>` : ''}</div>
      <div><h3 style="margin-bottom:8px">Batches in stock <span class="muted small">— sold in this order (first expiry first)</span></h3>
        ${live.length ? batchTable(live, { writeOff: isOwner(), compact: true }) : emptyState('box', 'No stock', 'Nothing of this product is on the shelf.')}</div>
      ${batches.length > live.length ? html`<details><summary class="muted small" style="cursor:pointer">Show ${plural(batches.length - live.length, 'past batch', 'past batches')} (sold out or written off)</summary>
        ${batchTable(batches.filter((b) => !live.includes(b)), { compact: true })}</details>` : ''}`);
    bindWriteOff(drawer, live, () => { drawer.close(); refresh(); });
  }

  el.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]'); if (v) { prefs.view = v.dataset.view; draw(); return; }
    const f = e.target.closest('[data-filter]'); if (f) { filter = f.dataset.filter; draw(); return; }
    const s = e.target.closest('[data-sort]');
    if (s) { prefs.dir = prefs.sort === s.dataset.sort ? -prefs.dir : 1; prefs.sort = s.dataset.sort; draw(); return; }
    const row = e.target.closest('[data-pid]'); if (row) openProduct(Number(row.dataset.pid));
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('[data-pid]'); if (row) openProduct(Number(row.dataset.pid));
    const s = e.target.closest('[data-sort]'); if (s) s.click();
  });
  $('#q', el).addEventListener('input', (e) => { q = e.target.value; draw(); });
  await draw();
  if (openId) openProduct(openId);
}
export { render_ as render };
