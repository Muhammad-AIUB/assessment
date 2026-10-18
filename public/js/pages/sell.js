// Point-of-sale counter. Built for speed: search → tap/Enter → adjust qty → Complete sale.
import { api, html, render, money, fmtDate, num, plural, state, $ } from '../core.js';
import { pageHeader, icon, emptyState, callout, toast, badge, busy } from '../ui.js';
import { stockChanged } from './shared.js';

export async function render_(el) {
  const [products, recent] = await Promise.all([api('/products'), api('/sales')]);
  const active = products.filter((p) => p.active).sort((a, b) => b.sold_30d - a.sold_30d || a.name.localeCompare(b.name));
  const byId = new Map(active.map((p) => [p.id, p]));
  const batchCache = new Map(); // productId -> batches (for the FEFO preview)
  const cart = []; // { productId, qty }
  let query = '';
  let cursor = 0; // highlighted tile index for keyboard use
  let receipt = null;

  render(el, html`
    ${pageHeader('Sell', 'Search, tap to add, complete the sale. Stock comes from the batch that expires first.')}
    <div class="pos">
      <section class="pos-pick">
        <div class="search pos-search">${icon('search')}
          <input id="q" class="input" type="search" placeholder="Search medicine or code…" autocomplete="off" aria-label="Search products" aria-controls="tiles">
          <kbd class="kbd">/</kbd></div>
        <div id="tiles" class="tiles" role="listbox" aria-label="Products"></div>
      </section>
      <aside class="pos-cart card" aria-label="Cart" id="cart-panel"><div id="cart"></div></aside>
    </div>
    <div class="cart-bar" id="cart-bar" aria-live="polite"></div>
    <details class="card flush recent" id="recent"></details>`);
  drawRecent(recent);

  function drawRecent(list) {
    const todays = list.filter((s) => s.sale_date === state.today);
    render($('#recent', el), html`
      <summary class="card-head"><div><h2>Today's sales</h2><p>${plural(todays.length, 'sale')} · ${money(todays.reduce((s, x) => s + Number(x.total), 0))}</p></div>${icon('arrow', 'chev')}</summary>
      ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Sale</th><th>Items</th><th class="num">Total</th></tr></thead><tbody>${list.slice(0, 15).map((s) => html`<tr>
        <td><span class="cell-strong">#${s.id}</span><span class="sub">${fmtDate(s.sale_date)} · ${s.sold_by ?? ''}</span></td>
        <td class="small">${s.lines.slice(0, 3).map((l) => html`${l.product} × ${l.qty} <span class="batch-no">${l.batchNo}</span><br>`)}${s.lines.length > 3 ? html`<span class="muted">+${s.lines.length - 3} more</span>` : ''}</td>
        <td class="num cell-strong">${money(s.total)}</td></tr>`)}</tbody></table></div>` : emptyState('receipt', 'No sales yet')}`);
  }

  const qInput = $('#q', el);
  const visible = () => {
    const q = query.trim().toLowerCase();
    return q ? active.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) : active;
  };
  const inCart = (id) => cart.find((c) => c.productId === id)?.qty ?? 0;

  function drawTiles() {
    const list = visible();
    cursor = Math.min(cursor, Math.max(0, list.length - 1));
    render($('#tiles', el), list.length ? html`${list.map((p, i) => {
      const left = p.usable - inCart(p.id);
      const out = p.usable === 0;
      return html`<button type="button" class="tile ${i === cursor ? 'is-cursor' : ''} ${inCart(p.id) ? 'in-cart' : ''}" role="option" aria-selected="${i === cursor}"
        data-add="${p.id}" ${out ? 'disabled' : ''}>
        <span class="tile-name">${p.name}</span>
        <span class="tile-meta"><span class="mono">${p.sku}</span> · ${money(p.sell_price)}</span>
        <span class="tile-foot">${out ? badge('expired', 'Out of stock') : html`<span class="tile-stock ${left <= 0 ? 'none' : left < 10 ? 'low' : ''}">${num(left)} left</span>`}
          ${p.expired ? html`<span class="tile-flag" title="Expired units are never sold">${icon('alert')}${p.expired} expired</span>` : ''}
          ${inCart(p.id) ? html`<span class="tile-qty">×${inCart(p.id)}</span>` : ''}</span>
      </button>`;
    })}` : emptyState('search', `No product matches “${query}”`, 'Check the spelling, or search by product code.'));
    $('.tile.is-cursor', el)?.scrollIntoView({ block: 'nearest' });
  }

  async function batchesFor(id) {
    if (!batchCache.has(id)) batchCache.set(id, await api(`/batches?productId=${id}`).catch(() => []));
    return batchCache.get(id);
  }

  /** Same rule as the server: earliest expiry first, expired batches skipped. Preview only. */
  function fefoPreview(batches, qty) {
    const usable = batches.filter((b) => b.qty_on_hand > 0 && b.status !== 'expired' && b.status !== 'written_off')
      .sort((a, b) => (a.expiry_date === b.expiry_date ? a.id - b.id : a.expiry_date < b.expiry_date ? -1 : 1));
    const picks = [];
    let need = qty;
    for (const b of usable) { if (need <= 0) break; const t = Math.min(need, b.qty_on_hand); picks.push({ b, t }); need -= t; }
    return picks;
  }

  function add(id, n = 1) {
    const p = byId.get(id);
    if (!p || p.usable === 0) return;
    receipt = null;
    const line = cart.find((c) => c.productId === id);
    if (line) line.qty += n; else cart.push({ productId: id, qty: n });
    batchesFor(id).then(drawCart);
    drawCart(); drawTiles();
  }

  function setQty(id, qty) {
    const line = cart.find((c) => c.productId === id);
    if (!line) return;
    if (qty <= 0) cart.splice(cart.indexOf(line), 1); else line.qty = qty;
    drawCart(); drawTiles();
  }

  function drawCartBar() {
    const bar = $('#cart-bar', el);
    if (!cart.length || receipt) { bar.innerHTML = ''; return; }
    const units = cart.reduce((s, c) => s + c.qty, 0);
    const total = cart.reduce((s, c) => s + c.qty * byId.get(c.productId).sell_price, 0);
    render(bar, html`${icon('cart')}<span>${plural(units, 'item')} · ${money(total)}</span>
      <button class="btn btn-sm" type="button">Review ${icon('arrow')}</button>`);
    bar.querySelector('button').addEventListener('click', () => $('#cart-panel', el).scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function drawCart() {
    drawCartBar();
    const box = $('#cart', el);
    if (receipt) {
      render(box, html`<div class="receipt">
        <div class="receipt-head">${icon('check', 'icon-xl')}<div><h2>Sale #${receipt.saleId} saved</h2><p class="muted">${fmtDate(receipt.saleDate)}</p></div></div>
        <ul class="receipt-lines">${receipt.lines.map((l) => html`<li><div><b>${l.productName}</b><span class="sub">${l.qty} × ${money(l.unitPrice)} · batch <span class="batch-no">${l.batchNo}</span> · exp ${fmtDate(l.expiryDate)}</span></div><span class="num">${money(l.qty * l.unitPrice)}</span></li>`)}</ul>
        <div class="total-row"><span>Total</span><span>${money(receipt.total)}</span></div>
        <button class="btn btn-primary btn-lg btn-block" id="new-sale">${icon('plus')}New sale</button></div>`);
      $('#new-sale', box).addEventListener('click', () => { receipt = null; drawCart(); qInput.focus(); });
      return;
    }
    if (!cart.length) {
      render(box, html`<h2 class="cart-title">Cart</h2>${emptyState('cart', 'Cart is empty', 'Tap a product, or search and press Enter.')}`);
      return;
    }
    let total = 0, invalid = false;
    const lines = cart.map((c) => {
      const p = byId.get(c.productId);
      const over = c.qty > p.usable;
      invalid ||= over;
      total += c.qty * p.sell_price;
      const batches = batchCache.get(c.productId);
      const picks = batches && !over ? fefoPreview(batches, c.qty) : [];
      return html`<li class="cart-line ${over ? 'has-error' : ''}" data-line="${p.id}">
        <div class="cart-line-top"><b>${p.name}</b><button class="icon-btn" data-rm="${p.id}" aria-label="Remove ${p.name}">${icon('trash')}</button></div>
        <div class="cart-line-mid">
          <div class="stepper" role="group" aria-label="Quantity for ${p.name}">
            <button type="button" data-dec="${p.id}" aria-label="One less">${icon('minus')}</button>
            <input type="number" inputmode="numeric" min="1" value="${c.qty}" data-qty="${p.id}" aria-label="Quantity">
            <button type="button" data-inc="${p.id}" aria-label="One more">${icon('plus')}</button></div>
          <span class="muted small">× ${money(p.sell_price)}</span><span class="spacer"></span><b class="num">${money(c.qty * p.sell_price)}</b></div>
        ${over ? html`<div class="line-error">${icon('alert')}<span>Only <b>${p.usable}</b> sellable${p.expired ? ` (${p.expired} expired not counted)` : ''}.</span>
            ${p.usable ? html`<button class="btn btn-sm" data-set="${p.id}" data-to="${p.usable}">Set to ${p.usable}</button>` : ''}</div>`
          : picks.length ? html`<div class="fefo">${picks.map(({ b, t }) => html`<span>${t} from <span class="batch-no">${b.batch_no}</span> · exp ${fmtDate(b.expiry_date)}${b.status === 'near_expiry' ? html` <em>soon</em>` : ''}</span>`)}</div>` : ''}
      </li>`;
    });
    const units = cart.reduce((s, c) => s + c.qty, 0);
    render(box, html`<div class="cart-title row"><h2>Cart</h2><span class="muted small">${plural(units, 'unit')}</span><span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="clear">Clear</button></div>
      <ul class="cart-lines">${lines}</ul>
      <div id="sale-error"></div>
      <div class="checkout"><div class="total-row"><span>Total</span><span>${money(total)}</span></div>
        <button class="btn btn-primary btn-lg btn-block" id="checkout" ${invalid ? 'disabled' : ''}>${icon('check')}Complete sale</button>
        <p class="small muted center">${invalid ? 'Fix the highlighted line to continue.' : html`Press <kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">Enter</kbd> to complete`}</p></div>`);

    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => setQty(Number(b.dataset.rm), 0)));
    box.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => setQty(Number(b.dataset.inc), inCart(Number(b.dataset.inc)) + 1)));
    box.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => setQty(Number(b.dataset.dec), inCart(Number(b.dataset.dec)) - 1)));
    box.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => setQty(Number(b.dataset.set), Number(b.dataset.to))));
    box.querySelectorAll('[data-qty]').forEach((i) => i.addEventListener('change', () => {
      const v = Math.floor(Number(i.value));
      setQty(Number(i.dataset.qty), Number.isFinite(v) ? v : 1);
    }));
    $('#clear', box).addEventListener('click', () => { cart.length = 0; drawCart(); drawTiles(); qInput.focus(); });
    const btn = $('#checkout', box);
    btn.addEventListener('click', busy(btn, checkout));
  }

  async function checkout() {
    try {
      receipt = await api('/sales', { method: 'POST', body: { items: cart.map((c) => ({ productId: c.productId, qty: c.qty })) } });
      for (const l of receipt.lines) { const p = byId.get(l.productId); p.usable -= l.qty; }
      cart.length = 0;
      batchCache.clear();
      toast(`Sale #${receipt.saleId} saved · ${money(receipt.total)}`);
      stockChanged();
      drawCart(); drawTiles();
      api('/sales').then(drawRecent).catch(() => {}); // refresh today's total
    } catch (e) {
      // Someone else may have just sold the same stock: refresh numbers so the line turns red.
      if (e.details?.productId && byId.has(e.details.productId)) byId.get(e.details.productId).usable = e.details.sellable;
      batchCache.clear();
      drawCart(); drawTiles();
      render($('#sale-error', el), callout('bad', 'alert', html`<b>Sale not saved.</b> ${e.message}`));
    }
  }

  // ---------- events ----------
  $('#tiles', el).addEventListener('click', (e) => { const t = e.target.closest('[data-add]'); if (t) add(Number(t.dataset.add)); });
  qInput.addEventListener('input', () => { query = qInput.value; cursor = 0; drawTiles(); });
  qInput.addEventListener('keydown', (e) => {
    const list = visible();
    const cols = Math.max(1, Math.round($('#tiles', el).clientWidth / 200));
    const moves = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in moves && (e.key.startsWith('ArrowU') || e.key.startsWith('ArrowD') || !qInput.value)) {
      e.preventDefault(); cursor = Math.max(0, Math.min(list.length - 1, cursor + moves[e.key])); drawTiles();
    } else if (e.key === 'Enter' && list[cursor]) {
      e.preventDefault(); add(list[cursor].id); qInput.select();
    } else if (e.key === 'Escape') { qInput.value = ''; query = ''; drawTiles(); }
  });
  const onKey = (e) => {
    if (!el.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === '/' && document.activeElement !== qInput && !e.target.closest('input, textarea, select')) { e.preventDefault(); qInput.focus(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#checkout', el)?.click(); }
  };
  document.addEventListener('keydown', onKey);

  drawTiles(); drawCart();
  if (matchMedia('(min-width: 861px)').matches) qInput.focus();
}
export { render_ as render };
