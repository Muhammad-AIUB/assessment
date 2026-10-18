// Forecast & reorder: a planner across all products, and a per-product explanation page.
import { api, html, render, n2, num, pct, fmtDate, plural, state, $ } from '../core.js';
import { pageHeader, icon, badge, callout, toast, busy, emptyState, confirmDialog } from '../ui.js';

const daysTo = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${state.today}T00:00:00Z`)) / 86_400_000);
const weekdayDate = (iso) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${fmtDate(iso).replace(/ \d{4}$/, '')}`;

export async function render_(el, [productId]) {
  return productId ? renderProduct(el, Number(productId)) : renderPlanner(el);
}
export { render_ as render };

// ---------- planner ----------
async function renderPlanner(el) {
  render(el, html`${pageHeader('Reorder planner', 'Every product, most urgent first. Tick what to buy and create the draft orders in one go.')}
    <section class="card">${icon('trend')} Forecasting all products…<div class="skeleton-wrap">${Array.from({ length: 6 }, () => html`<div class="skeleton"></div>`)}</div></section>`);
  const plan = await api('/reorder-plan');
  const need = plan.filter((r) => r.quantity > 0);
  const urgent = need.filter((r) => r.orderNow);
  const qty = new Map(need.map((r) => [r.productId, r.quantity]));
  const picked = new Set(need.map((r) => r.productId));

  render(el, html`
    ${pageHeader('Reorder planner', 'Every product, most urgent first. Tick what to buy and create the draft orders in one go.')}
    ${urgent.length ? callout('bad', 'alert', html`<b>${plural(urgent.length, 'product')} will run out before a new delivery could arrive</b> — order today: ${urgent.map((r) => r.name).join(', ')}.`)
      : need.length ? callout('info', 'info', html`${plural(need.length, 'product')} should be reordered this cycle. Nothing is critical yet.`)
      : callout('ok', 'check', 'Stock and open orders cover the forecast for every product. Nothing to buy right now.')}
    <section class="card flush"><div class="table-wrap"><table class="planner">
      <thead><tr><th><input type="checkbox" id="all" aria-label="Select all suggested" ${need.length ? 'checked' : 'disabled'}></th><th>Product</th><th>Runs out</th><th>Order by</th>
        <th class="num">Stock · on order</th><th class="num">Next 14 days</th><th class="num">Buy</th><th>Confidence</th></tr></thead>
      <tbody>${plan.map((r) => {
        const d = r.runsOutOn ? daysTo(r.runsOutOn) : null;
        const tone = r.orderNow ? 'bad' : r.quantity > 0 ? 'warn' : 'ok';
        return html`<tr class="${r.quantity > 0 ? '' : 'is-quiet'}" data-row="${r.productId}">
          <td>${r.quantity > 0 ? html`<input type="checkbox" data-pick="${r.productId}" checked aria-label="Order ${r.name}">` : ''}</td>
          <td><a class="cell-strong" href="#/forecast/${r.productId}">${r.name}</a><span class="sub">${r.supplierName} · ${r.leadTimeDays}-day lead</span></td>
          <td>${r.runsOutOn ? html`<span class="hint-${tone}">${d <= 0 ? 'today' : weekdayDate(r.runsOutOn)}</span><span class="sub">${d <= 0 ? 'out of stock' : `in ${plural(d, 'day')}`}</span>` : html`<span class="muted">not within a year</span>`}</td>
          <td>${r.quantity > 0 && r.orderBy ? html`<span class="${r.orderNow ? 'hint-bad' : ''}">${r.orderNow ? 'Today' : weekdayDate(r.orderBy)}</span>` : html`<span class="muted">–</span>`}</td>
          <td class="num">${num(r.usable)}${r.onOrder ? html` <span class="muted">· ${num(r.onOrder)}</span>` : ''}</td>
          <td class="num">${n2(r.next14)}</td>
          <td class="num">${r.quantity > 0 ? html`<input class="input qty-input" type="number" min="1" step="1" value="${r.quantity}" data-qty="${r.productId}" aria-label="Quantity of ${r.name}">` : html`<span class="muted">0</span>`}</td>
          <td>${r.confidence === 'low' ? badge('low', 'Low · new item') : r.beatsBaselines === false ? badge('low', 'Rough guide') : badge('good')}</td></tr>`;
      })}</tbody></table></div></section>
    <div class="action-bar" id="bar"></div>`);

  const drawBar = () => {
    const lines = need.filter((r) => picked.has(r.productId));
    const suppliers = new Set(lines.map((r) => r.supplierId));
    render($('#bar', el), lines.length ? html`<span><b>${plural(lines.length, 'product')}</b> from ${plural(suppliers.size, 'supplier')}</span>
      <button class="btn btn-primary" id="create">${icon('truck')}Create ${plural(suppliers.size, 'draft order')}</button>` : '');
    const btn = $('#create', el);
    btn?.addEventListener('click', busy(btn, async () => {
      const ok = await confirmDialog({ title: `Create ${plural(suppliers.size, 'draft order')}?`, message: `One draft per supplier with ${plural(lines.length, 'product')}. Nothing is sent until you review and place each order.`, confirmLabel: 'Create drafts' });
      if (!ok) return;
      try {
        const pos = await api('/reorder-plan/draft-pos', { method: 'POST', body: { items: lines.map((r) => ({ productId: r.productId, qty: qty.get(r.productId) })) } });
        toast(`Created ${plural(pos.length, 'draft order')}: ${pos.map((p) => `#${p.id}`).join(', ')}`);
        location.hash = pos.length === 1 ? `#/purchase/${pos[0].id}` : '#/purchase';
      } catch (e) { toast(e.message, 'bad'); }
    }));
  };
  el.addEventListener('change', (e) => {
    if (e.target.id === 'all') { el.querySelectorAll('[data-pick]').forEach((c) => { c.checked = e.target.checked; }); need.forEach((r) => (e.target.checked ? picked.add(r.productId) : picked.delete(r.productId))); }
    if (e.target.dataset.pick) { const id = Number(e.target.dataset.pick); e.target.checked ? picked.add(id) : picked.delete(id); }
    if (e.target.dataset.qty) {
      const id = Number(e.target.dataset.qty);
      const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
      e.target.value = v; qty.set(id, v);
    }
    drawBar();
  });
  drawBar();
}

// ---------- one product ----------
async function renderProduct(el, pid) {
  const [products, f] = await Promise.all([api('/products'), api(`/forecast/${pid}`)]);
  const r = f.reorder, m = f.model, bt = f.backtest, o = f.outlook;
  const unit = f.product.unit;
  const headline = r.quantity > 0
    ? html`Buy <b>${num(r.quantity)} ${unit}</b> ${o.orderNow ? html`<b class="hint-bad">today</b>` : o.orderBy ? html`by <b>${weekdayDate(o.orderBy)}</b>` : 'this cycle'}.`
    : html`<b>No order needed.</b> Stock and open orders cover the next ${r.coverDays} days.`;
  const runway = o.runsOutOn ? html`At the forecast rate, usable stock runs out around <b>${weekdayDate(o.runsOutOn)}</b> (${plural(o.daysOfCover, 'day')}).` : 'Usable stock lasts beyond a year at the forecast rate.';

  render(el, html`
    <a class="back" href="#/forecast">${icon('back')}Reorder planner</a>
    ${pageHeader(f.product.name, `${f.product.supplierName} · ${f.product.leadTimeDays}-day lead time`,
      html`<label class="field" style="min-width:240px"><span class="sr-only">Switch product</span><select id="fc-product">${products.map((p) =>
        html`<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${p.name}</option>`)}</select></label>`)}
    ${m.confidence === 'low' ? callout('warn', 'info', html`<b>Low confidence.</b> Only ${m.historyDays} days of sales history (under 28), so this uses the plain average instead of the weekly model.`) : ''}
    ${bt && !bt.beatsBaselines ? callout('warn', 'info', html`<b>Rough guide only.</b> In backtesting the model did not beat the simple baselines for this product — typical for slow or irregular sellers.`) : ''}
    <section class="card headline"><div><p class="headline-text">${headline}</p><p class="muted">${runway}</p></div>
      ${r.quantity > 0 ? html`<button class="btn btn-primary btn-lg" id="draft-po">${icon('truck')}Draft PO বানাও</button>` : ''}</section>
    <div class="split">
      <section class="card"><div class="card-head"><div><h2>Daily demand</h2><p>Last 90 days sold, next 14 days forecast, shaded band = likely range</p></div></div>
        <div style="position:relative;height:300px"><canvas id="fc-chart" role="img" aria-label="Chart of daily sales for the last 90 days and the forecast for the next 14 days"></canvas></div></section>
      <section class="card stack"><h2>Why ${num(r.quantity)}?</h2>
        <table class="calc"><tbody>
          <tr><td>Forecast demand for ${r.coverDays} days<span class="sub">lead time ${f.product.leadTimeDays} + until next order ${f.product.reviewPeriodDays}</span></td><td class="num">${n2(r.demandOverCover)}</td></tr>
          <tr><td>+ Safety stock<span class="sub">covers forecast error 95% of the time</span></td><td class="num">${n2(r.safetyStock)}</td></tr>
          <tr><td>− Usable stock<span class="sub">${f.stock.expired ? `${f.stock.expired} expired units not counted` : 'expired stock never counted'}</span></td><td class="num">${num(r.usableStock)}</td></tr>
          <tr><td>− Already on order</td><td class="num">${num(r.onOrder)}</td></tr>
          <tr class="calc-total"><td>= Buy${r.minLevel ? html`<span class="sub">never below min level ${r.minLevel}</span>` : ''}</td><td class="num">${num(r.quantity)}</td></tr>
        </tbody></table>
        <details class="small"><summary>How is safety stock calculated?</summary>
          <p style="margin-top:8px">z × σ × √(lead time) = ${r.z} × ${n2(r.errorSigma)} × √${f.product.leadTimeDays}. σ is how far the forecast was off per day in the backtest, so a product that's harder to predict automatically gets a bigger buffer.</p></details>
      </section>
    </div>
    <div class="grid cols-2">
      <section class="card flush"><div class="card-head"><div><h2>Expiry risk</h2><p>Selling the forecast day by day, first-expiry-first — what's left when each batch expires?</p></div></div>
        ${f.risk.length ? html`<div class="table-wrap"><table><thead><tr><th>Batch</th><th>Expiry</th><th class="num">On hand</th><th class="num">Won't sell</th><th>Suggestion</th></tr></thead>
          <tbody>${f.risk.map((x) => html`<tr><td><span class="batch-no">${x.batchNo}</span></td><td>${fmtDate(x.expiryDate)}</td><td class="num">${x.qtyOnHand}</td>
            <td class="num cell-strong ${x.atRisk ? 'hint-bad' : ''}">${x.atRisk}</td><td>${badge(x.suggestion)}</td></tr>`)}</tbody></table></div>` : emptyState('box', 'No sellable batches')}</section>
      <section class="card"><div class="card-head"><h2>Model</h2>${badge(m.confidence)}</div>
        <p>${m.method === 'seasonal_es' ? `Weekly exponential smoothing (α ${m.alpha}, γ ${m.gamma})` : 'Simple average'} · ${m.historyDays} days of history · ${pct(m.zeroDayShare)} days with no sales</p>
        <div class="weekdays" aria-label="Weekday pattern">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => html`<div><span style="height:${Math.min(100, m.season[i] * 55)}%"></span><b>${d}</b><small>${m.season[i].toFixed(2)}</small></div>`)}</div>
        ${bt ? html`<table class="small" style="margin-top:12px"><thead><tr><th>Backtest · ${bt.windows} weeks</th><th class="num">MAE</th><th class="num">WAPE</th></tr></thead><tbody>
          ${[['model', 'This model'], ['seasonal_naive', 'Same day last week'], ['mean_7', '7-day average']].map(([k, label]) =>
            html`<tr class="${k === bt.winner ? 'is-best' : ''}"><td>${label}${k === bt.winner ? html` <span class="pill pill-ok">best</span>` : ''}</td><td class="num">${n2(bt.metrics[k].mae)}</td><td class="num">${pct(bt.metrics[k].wape)}</td></tr>`)}</tbody></table>` : ''}
      </section>
    </div>`);

  $('#fc-product', el).addEventListener('change', (e) => { location.hash = `#/forecast/${e.target.value}`; });
  const btn = $('#draft-po', el);
  btn?.addEventListener('click', busy(btn, async () => {
    try { const po = await api(`/forecast/${pid}/draft-po`, { method: 'POST' }); toast(`Draft order #${po.id} created`); location.hash = `#/purchase/${po.id}`; }
    catch (e) { toast(e.message, 'bad'); }
  }));
  drawChart($('#fc-chart', el), f);
}

export function drawChart(canvas, f) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const c = (v) => css.getPropertyValue(v).trim();
  const sigma = f.reorder.errorSigma;
  const pad = f.history.map(() => null);
  const labels = [...f.history.map((h) => h.day), ...f.forecast.map((p) => p.day)];
  state.charts.push(new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Likely range', data: [...pad, ...f.forecast.map((p) => p.qty + sigma)], borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: `color-mix(in srgb, ${c('--brand')} 16%, transparent)` },
      { label: 'low', data: [...pad, ...f.forecast.map((p) => Math.max(0, p.qty - sigma))], borderWidth: 0, pointRadius: 0, fill: false },
      { label: 'Sold', data: [...f.history.map((h) => h.qty), ...f.forecast.map(() => null)], borderColor: c('--ink-3'), backgroundColor: c('--ink-3'), borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
      { label: 'Forecast', data: [...pad, ...f.forecast.map((p) => p.qty)], borderColor: c('--brand'), backgroundColor: c('--brand'), borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 5, tension: 0.25 },
    ] },
    options: {
      maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 7, color: c('--ink-3'), callback(v) { return fmtDate(this.getLabelForValue(v)).replace(/ \d{4}$/, ''); } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c('--ink-3') }, grid: { color: c('--line') } } },
      plugins: {
        legend: { position: 'bottom', labels: { color: c('--ink-2'), usePointStyle: true, filter: (i) => i.text !== 'low' } },
        tooltip: { filter: (i) => i.dataset.label !== 'low' && i.raw !== null, callbacks: { title: (items) => fmtDate(items[0].label), label: (i) => `${i.dataset.label}: ${n2(i.parsed.y)}` } },
      },
    },
  }));
}
