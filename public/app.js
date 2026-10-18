// PharmaStock SPA — vanilla JS, hash routing, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { user: null, today: null, charts: [], routeSeq: 0 };

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i]?.__raw ?? esc(vals[i])) : ''), '');
const raw = (s) => ({ __raw: s });
const n2 = (x) => (x === null || x === undefined ? '–' : Number(x).toFixed(2));
const pct = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1)}%`);
const money = (x) => `৳${Number(x).toFixed(2)}`;
const LABEL = { active: 'Active', near_expiry: 'Near expiry', expired: 'Expired', written_off: 'Written off', depleted: 'Sold out',
  draft: 'Draft', ordered: 'Ordered', received: 'Received', cancelled: 'Cancelled', discount: 'Discount', return_to_supplier: 'Return to supplier',
  none: 'OK', low: 'Low confidence', normal: 'Normal' };
const badge = (k) => raw(`<span class="badge b-${esc(k)}">${esc(LABEL[k] ?? k)}</span>`);
const isOwner = () => state.user?.role === 'owner';

/**
 * fetch wrapper. If the user navigates while a request is in flight, the response is dropped
 * (throws a silent "stale" error) so a slow page can never overwrite the page now on screen.
 */
async function api(path, opts = {}) {
  const seq = state.routeSeq;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (seq !== state.routeSeq && !opts.method) throw Object.assign(new Error('stale'), { stale: true });
  if (res.status === 401 && path !== '/auth/login') { showLogin(); throw new Error('Session expired'); }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, details: data.details });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }

// ---------- routing ----------
const ROUTES = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  sell: { title: 'Sell', render: renderSell },
  stock: { title: 'Stock', render: renderStock },
  purchase: { title: 'Purchases', render: renderPurchases },
  forecast: { title: 'Forecast', render: renderForecast, owner: true },
  model: { title: 'Model report', render: renderModel, owner: true },
  history: { title: 'Stock history', render: renderHistory, owner: true },
  catalog: { title: 'Catalogue', render: renderCatalog, owner: true },
  staff: { title: 'Staff', render: renderStaff, owner: true },
};

function renderNav(active) {
  $('#nav').innerHTML = Object.entries(ROUTES)
    .filter(([, r]) => !r.owner || isOwner())
    .map(([k, r]) => `<a href="#/${k}" class="${k === active ? 'active' : ''}">${r.title}</a>`).join('');
}

async function route() {
  if (!state.user) return;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = ROUTES[name] && (!ROUTES[name].owner || isOwner()) ? name : 'dashboard';
  renderNav(key);
  destroyCharts();
  const seq = ++state.routeSeq;
  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await ROUTES[key].render(arg); } catch (e) {
    if (e.stale || seq !== state.routeSeq) return;
    view.innerHTML = html`<div class="notice err">${e.message}</div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- auth ----------
function showLogin() { state.user = null; $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function showShell() {
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('#who').textContent = `${state.user.name} · ${state.user.role}`;
  $('#today').textContent = state.today;
}
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  try {
    await api('/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    await boot();
  } catch (e) { $('#login-error').textContent = e.message; }
});
$('#logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user; state.today = me.today;
    showShell();
    route();
  } catch { showLogin(); }
}

// ---------- Dashboard ----------
async function renderDashboard() {
  const [products, alerts, pos] = await Promise.all([api('/products'), api('/alerts/expiry'), api('/purchase-orders?status=ordered')]);
  const below = products.filter((p) => p.below_min);
  const expired = alerts.filter((a) => a.status === 'expired');
  const near = alerts.filter((a) => a.status === 'near_expiry');
  view.innerHTML = html`
    <h1>Dashboard</h1><p class="muted">Business date ${state.today}</p>
    <div class="grid">
      <div class="card kpi"><div class="v">${below.length}</div><div class="l">Products below minimum level</div></div>
      <div class="card kpi"><div class="v" style="color:var(--danger)">${expired.length}</div><div class="l">Expired batches still on shelf</div></div>
      <div class="card kpi"><div class="v" style="color:var(--warn)">${near.length}</div><div class="l">Batches expiring within 60 days</div></div>
      <div class="card kpi"><div class="v">${pos.length}</div><div class="l">Purchase orders in transit</div></div>
    </div>
    <div class="card"><h2>Expiry watch</h2>${raw(alerts.length ? batchTable(alerts, { showProduct: true, writeOff: isOwner() }) : '<p class="muted">Nothing expiring soon.</p>')}</div>
    <div class="card"><h2>Below minimum level</h2>
      ${raw(below.length ? `<div class="table-wrap"><table><tr><th>Product</th><th class="num">Usable</th><th class="num">Min</th><th class="num">On order</th>${isOwner() ? '<th></th>' : ''}</tr>
        ${below.map((p) => html`<tr><td>${p.name}</td><td class="num">${p.usable}</td><td class="num">${p.min_level}</td><td class="num">${p.on_order}</td>
          ${raw(isOwner() ? html`<td><a href="#/forecast/${p.id}">Forecast →</a></td>` : '')}</tr>`).join('')}</table></div>` : '<p class="muted">All products above minimum.</p>')}
    </div>`;
  bindWriteOff();
}

function batchTable(batches, { showProduct = false, writeOff = false } = {}) {
  return `<div class="table-wrap"><table><tr>${showProduct ? '<th>Product</th>' : ''}<th>Batch</th><th>Expiry</th><th class="num">Days left</th>
    <th class="num">On hand</th>${isOwner() ? '<th class="num">Cost</th>' : ''}<th>Status</th>${writeOff ? '<th></th>' : ''}</tr>
    ${batches.map((b) => html`<tr>${raw(showProduct ? html`<td>${b.product_name}</td>` : '')}<td>${b.batch_no}</td><td>${b.expiry_date}</td>
      <td class="num">${b.days_left}</td><td class="num">${b.qty_on_hand}</td>${raw(isOwner() ? html`<td class="num">${n2(b.unit_cost)}</td>` : '')}
      <td>${badge(b.status)}</td>
      ${raw(writeOff ? (b.status === 'written_off' || b.qty_on_hand === 0 ? '<td></td>' : html`<td><button class="danger" data-writeoff="${b.id}" data-label="${b.product_name ?? ''} ${b.batch_no}">Write off</button></td>`) : '')}</tr>`).join('')}
  </table></div>`;
}

function bindWriteOff(after = route) {
  view.querySelectorAll('[data-writeoff]').forEach((btn) => btn.addEventListener('click', async () => {
    const reason = prompt(`Write off ${btn.dataset.label}?\nReason (required, kept in stock history):`, 'Expired');
    if (reason === null) return;
    try {
      const r = await api(`/batches/${btn.dataset.writeoff}/write-off`, { method: 'POST', body: { reason } });
      toast(`Written off ${r.writtenOffQty} units`);
      after();
    } catch (e) { toast(e.message); }
  }));
}

// ---------- Sell ----------
async function renderSell() {
  const [products, recent] = await Promise.all([api('/products'), api('/sales')]);
  const cart = [];
  const active = products.filter((p) => p.active);
  view.innerHTML = html`
    <h1>Sell</h1>
    <div class="grid-2">
      <div class="card">
        <form id="add" class="row">
          <label style="flex:2">Product <select name="productId" required>${raw(active.map((p) =>
            html`<option value="${p.id}">${p.name} — ${p.usable} sellable${p.expired ? ` (${p.expired} expired)` : ''}</option>`).join(''))}</select></label>
          <label style="width:90px">Qty <input name="qty" type="number" min="1" step="1" value="1" required></label>
          <button type="submit">Add</button>
        </form>
        <div id="cart" style="margin-top:12px"></div>
        <div id="sale-msg" style="margin-top:12px"></div>
      </div>
      <div class="card"><h3>How FEFO works</h3><p class="muted small">Units are taken from the batch that expires first, across several batches if needed.
        Expired batches are never sold. The whole sale is one database transaction with row locks, so two counters selling at once can't sell the same unit twice.</p></div>
    </div>
    <div class="card"><h2>Recent sales</h2><div class="table-wrap"><table><tr><th>#</th><th>Date</th><th>By</th><th>Lines (product · batch · qty)</th><th class="num">Total</th></tr>
      ${raw(recent.map((s) => html`<tr><td>${s.id}</td><td>${s.sale_date}</td><td>${s.sold_by}</td>
        <td>${raw(s.lines.slice(0, 6).map((l) => html`${l.product} · ${l.batchNo} · ${l.qty}`).join('<br>'))}${s.lines.length > 6 ? ` … +${s.lines.length - 6}` : ''}</td>
        <td class="num">${money(s.total)}</td></tr>`).join(''))}</table></div></div>`;

  const drawCart = () => {
    $('#cart').innerHTML = cart.length ? html`<table><tr><th>Product</th><th class="num">Qty</th><th></th></tr>
      ${raw(cart.map((c, i) => html`<tr><td>${c.name}</td><td class="num">${c.qty}</td><td><button class="ghost" data-rm="${i}">✕</button></td></tr>`).join(''))}
      </table><div class="row" style="margin-top:10px"><button class="primary" id="checkout">Complete sale</button></div>` : '<p class="muted">Cart is empty.</p>';
    view.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { cart.splice(Number(b.dataset.rm), 1); drawCart(); }));
    $('#checkout')?.addEventListener('click', checkout);
  };
  const checkout = async () => {
    const btn = $('#checkout'); btn.disabled = true;
    try {
      const s = await api('/sales', { method: 'POST', body: { items: cart.map((c) => ({ productId: c.productId, qty: c.qty })) } });
      $('#sale-msg').innerHTML = html`<div class="notice">Sale #${s.saleId} saved — ${money(s.total)}<br>
        ${raw(s.lines.map((l) => html`${l.productName}: ${l.qty} from batch <b>${l.batchNo}</b> (exp ${l.expiryDate})`).join('<br>'))}</div>`;
      cart.length = 0; drawCart();
      setTimeout(route, 2500);
    } catch (e) {
      $('#sale-msg').innerHTML = html`<div class="notice err">${e.message}</div>`;
      btn.disabled = false;
    }
  };
  $('#add').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const p = active.find((x) => x.id === Number(f.get('productId')));
    const qty = Number(f.get('qty'));
    if (!Number.isInteger(qty) || qty < 1) return toast('Quantity must be a whole number ≥ 1');
    const line = cart.find((c) => c.productId === p.id);
    if (line) line.qty += qty; else cart.push({ productId: p.id, name: p.name, qty });
    drawCart();
  });
  drawCart();
}

// ---------- Stock ----------
async function renderStock(productId) {
  const products = await api('/products');
  view.innerHTML = html`<h1>Stock</h1><div class="card"><div class="table-wrap"><table>
    <tr><th>SKU</th><th>Product</th><th>Supplier</th><th class="num">Usable</th><th class="num">Near expiry</th><th class="num">Expired</th>
      <th class="num">On order</th><th class="num">Min</th><th class="num">Price</th></tr>
    ${raw(products.map((p) => html`<tr class="clickable" data-pid="${p.id}"><td>${p.sku}</td><td>${p.name} ${raw(p.below_min ? '<span class="badge b-expired">below min</span>' : '')}</td>
      <td>${p.supplier_name}</td><td class="num">${p.usable}</td><td class="num">${p.near_expiry || ''}</td><td class="num">${p.expired || ''}</td>
      <td class="num">${p.on_order || ''}</td><td class="num">${p.min_level}</td><td class="num">${money(p.sell_price)}</td></tr>`).join(''))}
  </table></div></div><div id="batches"></div>`;
  view.querySelectorAll('[data-pid]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/stock/${tr.dataset.pid}`; }));
  if (productId) {
    const p = products.find((x) => x.id === Number(productId));
    const batches = await api(`/batches?productId=${productId}`);
    $('#batches').innerHTML = html`<div class="card"><h2>Batches — ${p?.name}</h2>${raw(batches.length ? batchTable(batches, { writeOff: isOwner() }) : '<p class="muted">No batches.</p>')}</div>`;
    bindWriteOff();
    $('#batches').scrollIntoView({ behavior: 'smooth' });
  }
}

// ---------- Purchases ----------
async function renderPurchases(poId) {
  const [orders, suppliers, products] = await Promise.all([api('/purchase-orders'), api('/suppliers'), api('/products')]);
  const owner = isOwner();
  view.innerHTML = html`<h1>Purchase orders</h1>
    ${raw(owner ? html`<div class="card"><h2>New draft order</h2><form id="new-po">
      <div class="row"><label>Supplier <select name="supplierId">${raw(suppliers.map((s) => html`<option value="${s.id}">${s.name} (lead ${s.lead_time_days}d)</option>`).join(''))}</select></label>
      <label style="flex:1">Note <input name="note"></label></div>
      <div id="po-lines" style="margin-top:8px"></div>
      <div class="row" style="margin-top:8px"><button type="button" id="add-line">+ Item</button><button class="primary" type="submit">Create draft</button></div></form></div>` : '')}
    <div id="po-detail"></div>
    <div class="card"><h2>Orders</h2><div class="table-wrap"><table><tr><th>#</th><th>Status</th><th>Supplier</th><th>Items</th><th>Created</th><th>Note</th></tr>
      ${raw(orders.map((o) => html`<tr class="clickable" data-po="${o.id}"><td>${o.id}</td><td>${badge(o.status)}</td><td>${o.supplier_name}</td>
        <td>${o.items.map((i) => `${i.productName} × ${i.qty}`).join(', ')}</td><td>${o.created_at.slice(0, 10)}</td><td class="muted">${o.note ?? ''}</td></tr>`).join(''))}
    </table></div></div>`;
  view.querySelectorAll('[data-po]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/purchase/${tr.dataset.po}`; }));

  if (owner) {
    const addLine = () => {
      const div = document.createElement('div');
      div.className = 'row'; div.style.marginTop = '6px';
      div.innerHTML = html`<label style="flex:2">Product <select name="productId">${raw(products.map((p) => html`<option value="${p.id}">${p.name}</option>`).join(''))}</select></label>
        <label>Qty <input name="qty" type="number" min="1" step="1" required></label><label>Unit cost <input name="unitCost" type="number" min="0" step="0.01"></label>
        <button type="button" class="ghost">✕</button>`;
      div.querySelector('button').addEventListener('click', () => div.remove());
      $('#po-lines').append(div);
    };
    $('#add-line').addEventListener('click', addLine);
    addLine();
    $('#new-po').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const items = [...$('#po-lines').children].map((d) => ({ productId: Number(d.querySelector('[name=productId]').value),
        qty: Number(d.querySelector('[name=qty]').value), unitCost: d.querySelector('[name=unitCost]').value }));
      try {
        const po = await api('/purchase-orders', { method: 'POST', body: { supplierId: Number(ev.target.supplierId.value), note: ev.target.note.value, items } });
        toast(`Draft PO #${po.id} created`); location.hash = `#/purchase/${po.id}`;
      } catch (e) { toast(e.message); }
    });
  }
  if (poId) await renderPoDetail(Number(poId));
}

async function renderPoDetail(id) {
  const po = await api(`/purchase-orders/${id}`);
  const owner = isOwner();
  const box = $('#po-detail');
  const actions = [];
  if (owner && po.status === 'draft') actions.push('<button class="primary" data-act="place">Place order</button>');
  if (owner && ['draft', 'ordered'].includes(po.status)) actions.push('<button class="danger" data-act="cancel">Cancel</button>');
  box.innerHTML = html`<div class="card"><h2>PO #${po.id} ${badge(po.status)}</h2><p class="muted">${po.supplier_name} · ${po.note ?? ''}</p>
    <table><tr><th>Product</th><th class="num">Qty</th>${raw(owner ? '<th class="num">Unit cost</th>' : '')}</tr>
    ${raw(po.items.map((i) => html`<tr><td>${i.productName}</td><td class="num">${i.qty}</td>${raw(owner ? html`<td class="num">${n2(i.unitCost)}</td>` : '')}</tr>`).join(''))}</table>
    <div class="row" style="margin-top:10px">${raw(actions.join(''))}</div>
    ${raw(po.status === 'ordered' ? receiveForm(po, owner) : '')}</div>`;
  box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/purchase-orders/${id}/${b.dataset.act}`, { method: 'POST' }); toast('Updated'); route(); } catch (e) { toast(e.message); }
  }));
  $('#receive')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const lines = [...ev.target.querySelectorAll('[data-item]')].map((r) => ({
      poItemId: Number(r.dataset.item), batchNo: r.querySelector('[name=batchNo]').value, expiry: r.querySelector('[name=expiry]').value,
      qty: Number(r.querySelector('[name=qty]').value), unitCost: r.querySelector('[name=unitCost]')?.value }));
    try {
      const res = await api(`/purchase-orders/${id}/receive`, { method: 'POST', body: { lines } });
      toast(`Received ${res.batches.length} batches`); route();
    } catch (e) { $('#receive-err').textContent = e.message; }
  });
  box.scrollIntoView({ behavior: 'smooth' });
}

function receiveForm(po, owner) {
  return html`<form id="receive" style="margin-top:16px"><h3>Receive goods</h3>
    <p class="muted small">Enter the batch number and the expiry printed on the pack (month/year — valid to the end of that month). Each line becomes its own batch.</p>
    ${raw(po.items.map((i) => html`<div class="row" data-item="${i.id}" style="margin-top:6px"><b style="min-width:180px">${i.productName}</b>
      <label>Batch no <input name="batchNo" required></label><label>Expiry <input name="expiry" type="month" required></label>
      <label>Qty <input name="qty" type="number" min="1" max="${i.qty}" value="${i.qty}" required></label>
      ${raw(owner ? html`<label>Unit cost <input name="unitCost" type="number" min="0" step="0.01" value="${i.unitCost ?? ''}"></label>` : '')}</div>`).join(''))}
    <div class="row" style="margin-top:10px"><button class="primary" type="submit">Receive into stock</button></div><p class="error" id="receive-err"></p></form>`;
}

// ---------- Forecast ----------
async function renderForecast(productId) {
  const products = await api('/products');
  const pid = Number(productId) || products[0]?.id;
  view.innerHTML = html`<h1>Forecast &amp; reorder</h1>
    <div class="card row"><label style="flex:1">Product <select id="fc-product">${raw(products.map((p) =>
      html`<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${p.name}</option>`).join(''))}</select></label></div>
    <div id="fc-body"><p class="muted">Computing…</p></div>`;
  $('#fc-product').addEventListener('change', (e) => { location.hash = `#/forecast/${e.target.value}`; });
  if (!pid) return;
  const f = await api(`/forecast/${pid}`);
  const r = f.reorder, m = f.model, bt = f.backtest;
  $('#fc-body').innerHTML = html`
    ${raw(m.confidence === 'low' ? html`<div class="notice warn">Low confidence: only ${m.historyDays} days of history (&lt; 28). Using the plain average instead of the seasonal model.</div>` : '')}
    ${raw(bt && !bt.beatsBaselines ? html`<div class="notice warn">On this product the model did <b>not</b> beat the simple baselines in backtest (best: ${bt.winner.replace('_', ' ')}). Typical for slow / intermittent items — treat the number as a rough guide.</div>` : '')}
    <div class="grid-2">
      <div class="card"><h2>Daily demand — last 90 days and next 14</h2><div class="chart-box"><canvas id="fc-chart"></canvas></div></div>
      <div class="card">
        <h2>Buy ${r.quantity} ${f.product.unit}</h2>
        <div class="formula">  forecast ${r.coverDays}d (lead ${f.product.leadTimeDays} + review ${f.product.reviewPeriodDays})  ${n2(r.demandOverCover)}
+ safety stock z·σ·√L = ${r.z}·${n2(r.errorSigma)}·√${f.product.leadTimeDays}  ${n2(r.safetyStock)}
− usable stock (expired excluded)    ${r.usableStock}
− on order (in transit)              ${r.onOrder}
= ${r.quantity}${r.minLevel ? `   (floor: min level ${r.minLevel})` : ''}</div>
        <p class="muted small">Expired on shelf (ignored): ${f.stock.expired}. Next 7 days ≈ ${n2(f.forecastTotals.next7)}, next 14 ≈ ${n2(f.forecastTotals.next14)}.</p>
        <button class="primary" id="draft-po" ${r.quantity > 0 ? '' : 'disabled'}>Draft PO বানাও</button>
      </div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Expiry risk (FEFO simulation)</h2>
        ${raw(f.risk.length ? html`<div class="table-wrap"><table><tr><th>Batch</th><th>Expiry</th><th class="num">On hand</th><th class="num">Expected sold</th><th class="num">At risk</th><th>Suggestion</th></tr>
          ${raw(f.risk.map((x) => html`<tr><td>${x.batchNo}</td><td>${x.expiryDate}</td><td class="num">${x.qtyOnHand}</td><td class="num">${x.expectedSold}</td>
            <td class="num">${x.atRisk}</td><td>${badge(x.suggestion)}</td></tr>`).join(''))}</table></div>
          <p class="muted small">Plays the forecast forward day by day, selling FEFO, and counts units still on hand when each batch expires. Long-range figures are approximate — the model is only evaluated 7 days ahead.</p>` : '<p class="muted">No sellable batches.</p>')}
      </div>
      <div class="card"><h2>Model</h2>
        <p>${badge(m.confidence)} ${raw(m.method === 'seasonal_es' ? html`Seasonal exponential smoothing — α=${m.alpha}, γ=${m.gamma}` : 'Simple mean (history &lt; 28 days)')}</p>
        <p class="muted small">Level ${m.level}/day · history ${m.historyDays} days · zero-sale days ${pct(m.zeroDayShare)}</p>
        <p class="muted small">Weekday index Mon…Sun: ${m.season.join(' · ')}</p>
        ${raw(bt ? html`<table><tr><th>Backtest (${bt.windows}×7d)</th><th class="num">MAE</th><th class="num">WAPE</th></tr>
          ${raw(['model', 'seasonal_naive', 'mean_7'].map((k) => html`<tr><td>${k.replace('_', ' ')}</td><td class="num">${n2(bt.metrics[k].mae)}</td><td class="num">${pct(bt.metrics[k].wape)}</td></tr>`).join(''))}</table>` : '<p class="muted small">Not enough history to backtest.</p>')}
      </div>
    </div>`;

  $('#draft-po').addEventListener('click', async () => {
    try {
      const po = await api(`/forecast/${pid}/draft-po`, { method: 'POST' });
      toast(`Draft PO #${po.id} created`); location.hash = `#/purchase/${po.id}`;
    } catch (e) { toast(e.message); }
  });

  if (window.Chart) {
    const labels = [...f.history.map((h) => h.day), ...f.forecast.map((p) => p.day)];
    const hist = [...f.history.map((h) => h.qty), ...f.forecast.map(() => null)];
    const fut = [...f.history.map(() => null), ...f.forecast.map((p) => p.qty)];
    const css = getComputedStyle(document.documentElement);
    state.charts.push(new Chart($('#fc-chart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Actual sales', data: hist, borderColor: css.getPropertyValue('--muted'), borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        { label: 'Forecast', data: fut, borderColor: css.getPropertyValue('--brand'), borderWidth: 2.5, borderDash: [5, 4], pointRadius: 2, tension: 0.2 },
      ] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, spanGaps: false,
        scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true } }, plugins: { legend: { position: 'bottom' } } },
    }));
  }
}

// ---------- Model report ----------
async function renderModel() {
  const r = await api('/model-report');
  const s = r.summary;
  const rows = r.products;
  view.innerHTML = html`<h1>Model report</h1>
    <div class="notice warn">All sales history is <b>synthetic</b> (generated by the seed script with noise, weekly pattern and random spikes). Results show the method works on plausible data — not that it is accurate for a real shop.</div>
    <div class="grid">
      <div class="card kpi"><div class="v">${s.modelBeatsBoth}/${s.productsScored}</div><div class="l">products where the model beats <i>both</i> baselines (MAE)</div></div>
      ${raw(['model', 'seasonal_naive', 'mean_7'].map((k) => html`<div class="card kpi"><div class="v">${pct(s.pooled[k].wape)}</div><div class="l">pooled WAPE — ${k.replace('_', ' ')} (MAE ${n2(s.pooled[k].mae)})</div></div>`).join(''))}
    </div>
    <div class="card"><h2>Per product</h2>
      <p class="muted small">Walk-forward: train on all days before the origin, forecast the next ${r.settings.horizon} days, move the origin ${r.settings.step} days, repeat (last ${r.settings.maxWindows} windows; α, γ re-tuned at each origin on a ${r.settings.validationDays}-day validation tail). Baselines: “same weekday last week” and “mean of last 7 days”. MAPE counts only days with sales &gt; 0.</p>
      <div class="table-wrap"><table><tr><th>Product</th><th>Segment</th><th class="num">Avg/day</th><th class="num">Zero days</th>
        <th class="num">MAE model</th><th class="num">MAE s-naive</th><th class="num">MAE mean-7</th><th class="num">WAPE model</th><th class="num">MAPE model</th><th>Beats both?</th></tr>
        ${raw(rows.map((p) => {
          const b = p.backtest;
          if (!b) return html`<tr><td>${p.name}</td><td>${p.segment}</td><td class="num">${n2(p.meanDaily)}</td><td></td><td colspan="6" class="muted">Not scored — ${p.historyDays} days of history</td></tr>`;
          const m = b.metrics;
          return html`<tr><td>${p.name}</td><td>${p.segment}</td><td class="num">${n2(p.meanDaily)}</td><td class="num">${pct(p.zeroDayShare)}</td>
            <td class="num"><b>${n2(m.model.mae)}</b></td><td class="num">${n2(m.seasonal_naive.mae)}</td><td class="num">${n2(m.mean_7.mae)}</td>
            <td class="num">${pct(m.model.wape)}</td><td class="num">${pct(m.model.mape)} <span class="muted small">(${m.model.mapeDays}d)</span></td>
            <td>${badge(b.beatsBaselines ? 'yes' : 'no')}</td></tr>`;
        }).join(''))}</table></div></div>
    <div class="card"><h2>Where it does not win — and why</h2><ul>
      <li><b>Slow / intermittent items</b> (many zero days): a weekday index can't be learned from mostly zeros; a flat 7-day mean is as good or better. Croston/SBA would be the next step.</li>
      <li><b>Spiky items</b>: random spikes are by construction unpredictable from history; any smoother lags them.</li>
      <li>Not modelled: promotions, annual seasonality (monsoon diarrhoea, winter flu), sudden demand shifts. Evaluation covers 7-day horizons only, so the expiry-risk projection months ahead is approximate.</li>
    </ul></div>`;
}

// ---------- History ----------
async function renderHistory() {
  const rows = await api('/stock-history');
  view.innerHTML = html`<h1>Stock history</h1><div class="card"><p class="muted small">Latest 200 movements. Every receipt, sale and write-off is recorded here and never edited.</p>
    <div class="table-wrap"><table><tr><th>Date</th><th>Type</th><th>Product</th><th>Batch</th><th class="num">Qty</th><th>By</th><th>Reason / ref</th></tr>
    ${raw(rows.map((m) => html`<tr><td>${m.movement_date}</td><td>${m.type}</td><td>${m.product_name}</td><td>${m.batch_no}</td>
      <td class="num" style="color:${m.qty < 0 ? 'var(--danger)' : 'var(--ok)'}">${m.qty > 0 ? '+' : ''}${m.qty}</td><td>${m.user_name ?? ''}</td>
      <td>${m.reason ?? (m.ref_id ? `${m.type === 'sale' ? 'sale' : 'PO'} #${m.ref_id}` : '')}</td></tr>`).join(''))}</table></div></div>`;
}

// ---------- Catalogue ----------
async function renderCatalog() {
  const suppliers = await api('/suppliers');
  view.innerHTML = html`<h1>Catalogue</h1><div class="grid-2">
    <div class="card"><h2>Add product</h2><form id="new-product" class="row">
      <label>SKU <input name="sku" required></label><label style="flex:1">Name <input name="name" required></label><label>Unit <input name="unit" value="strip"></label>
      <label>Supplier <select name="supplierId">${raw(suppliers.map((s) => html`<option value="${s.id}" data-lead="${s.lead_time_days}">${s.name}</option>`).join(''))}</select></label>
      <label>Lead time (days) <input name="leadTimeDays" type="number" min="0" value="${suppliers[0]?.lead_time_days ?? 3}" required></label>
      <label>Min level <input name="minLevel" type="number" min="0" value="0"></label>
      <label>Sell price <input name="sellPrice" type="number" min="0" step="0.01" required></label>
      <button class="primary">Add product</button></form></div>
    <div class="card"><h2>Add supplier</h2><form id="new-supplier" class="row">
      <label style="flex:1">Name <input name="name" required></label><label>Phone <input name="phone"></label>
      <label>Lead time (days) <input name="leadTimeDays" type="number" min="0" value="3"></label><button class="primary">Add supplier</button></form>
      <table style="margin-top:12px"><tr><th>Supplier</th><th class="num">Lead</th></tr>${raw(suppliers.map((s) => html`<tr><td>${s.name}</td><td class="num">${s.lead_time_days}d</td></tr>`).join(''))}</table></div></div>`;
  const form = (id, path, msg) => $(id).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    try { await api(path, { method: 'POST', body }); toast(msg); route(); } catch (e) { toast(e.message); }
  });
  $('#new-product [name=supplierId]').addEventListener('change', (e) => { $('#new-product [name=leadTimeDays]').value = e.target.selectedOptions[0].dataset.lead; });
  form('#new-product', '/products', 'Product added');
  form('#new-supplier', '/suppliers', 'Supplier added');
}

// ---------- Staff ----------
async function renderStaff() {
  const users = await api('/users');
  view.innerHTML = html`<h1>Staff</h1><div class="grid-2">
    <div class="card"><table><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr>
      ${raw(users.map((u) => html`<tr><td>${u.name}</td><td>${u.username}</td><td>${u.role}</td><td>${u.active ? 'active' : 'disabled'}</td>
        <td>${raw(u.id === state.user.id ? '' : html`<button data-toggle="${u.id}" data-active="${u.active ? '0' : '1'}">${u.active ? 'Disable' : 'Enable'}</button>`)}</td></tr>`).join(''))}</table></div>
    <div class="card"><h2>Add staff</h2><form id="new-user" class="row">
      <label>Name <input name="name" required></label><label>Username <input name="username" required></label>
      <label>Password <input name="password" type="password" minlength="6" required></label>
      <label>Role <select name="role"><option value="staff">staff</option><option value="owner">owner</option></select></label>
      <button class="primary">Add</button></form>
      <p class="muted small">Staff can sell and receive goods. They never see purchase prices, forecasts or reports.</p></div></div>`;
  view.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/users/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active === '1' } }); route(); } catch (e) { toast(e.message); }
  }));
  $('#new-user').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); toast('User added'); route(); } catch (e) { toast(e.message); }
  });
}

boot();
