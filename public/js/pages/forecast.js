import { api, html, render, n2, pct, fmtDate, state, $ } from '../core.js';
import { pageHeader, icon, badge, callout, toast, busy, emptyState } from '../ui.js';

export async function render_(el, [productId]) {
  const products = await api('/products');
  const pid = Number(productId) || products[0]?.id;
  render(el, html`${pageHeader('Forecast & reorder', 'Demand for the next 14 days and how much to buy.',
    html`<label class="field" style="min-width:260px"><span class="sr-only">Product</span><select id="fc-product">${products.map((p) =>
      html`<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${p.name}</option>`)}</select></label>`)}<div id="fc-body"></div>`);
  $('#fc-product', el).addEventListener('change', (e) => { location.hash = `#/forecast/${e.target.value}`; });
  if (!pid) return;
  const f = await api(`/forecast/${pid}`);
  const r = f.reorder, m = f.model, bt = f.backtest;
  render($('#fc-body', el), html`
    ${m.confidence === 'low' ? callout('warn', 'info', html`<b>Low confidence.</b> Only ${m.historyDays} days of sales history (under 28), so this uses the plain average instead of the weekly model.`) : ''}
    ${bt && !bt.beatsBaselines ? callout('warn', 'info', html`<b>Rough guide only.</b> In backtesting, the model did not beat the simple baselines for this product — typical for slow or irregular sellers.`) : ''}
    <div class="split">
      <section class="card"><div class="card-head"><div><h2>Daily demand</h2><p>Last 90 days of sales and the next 14 days of forecast</p></div></div>
        <div style="position:relative;height:320px"><canvas id="fc-chart" aria-label="Sales history and forecast chart" role="img"></canvas></div></section>
      <section class="card stack">
        <div class="stat-top">Recommended order</div>
        <div class="stat-value">${r.quantity} <span style="font-size:18px;font-weight:500">${f.product.unit}</span></div>
        <table class="small"><tbody>
          <tr><td>Demand over ${r.coverDays} days <span class="sub">lead ${f.product.leadTimeDays} + review ${f.product.reviewPeriodDays} days</span></td><td class="num">${n2(r.demandOverCover)}</td></tr>
          <tr><td>+ Safety stock <span class="sub">${r.z} × σ ${n2(r.errorSigma)} × √${f.product.leadTimeDays}</span></td><td class="num">${n2(r.safetyStock)}</td></tr>
          <tr><td>− Usable stock <span class="sub">${f.stock.expired} expired not counted</span></td><td class="num">${r.usableStock}</td></tr>
          <tr><td>− Already on order</td><td class="num">${r.onOrder}</td></tr>
        </tbody></table>
        <button class="btn btn-primary btn-lg btn-block" id="draft-po" ${r.quantity > 0 ? '' : 'disabled'}>${icon('truck')}Draft PO বানাও</button>
        ${r.quantity > 0 ? '' : html`<p class="small muted">No purchase needed — current stock and open orders cover the forecast.</p>`}
      </section>
    </div>
    <div class="grid cols-2">
      <section class="card flush"><div class="card-head"><div><h2>Expiry risk</h2><p>Sell the forecast day by day (FEFO) — what will still be on the shelf at expiry?</p></div></div>
        ${f.risk.length ? html`<div class="table-wrap"><table><thead><tr><th>Batch</th><th>Expiry</th><th class="num">On hand</th><th class="num">At risk</th><th>Suggestion</th></tr></thead>
          <tbody>${f.risk.map((x) => html`<tr><td><span class="batch-no">${x.batchNo}</span></td><td>${fmtDate(x.expiryDate)}</td><td class="num">${x.qtyOnHand}</td>
            <td class="num cell-strong">${x.atRisk}</td><td>${badge(x.suggestion)}</td></tr>`)}</tbody></table></div>` : emptyState('box', 'No sellable batches')}</section>
      <section class="card"><div class="card-head"><h2>Model</h2>${badge(m.confidence)}</div>
        <p>${m.method === 'seasonal_es' ? `Weekly exponential smoothing (α ${m.alpha}, γ ${m.gamma})` : 'Simple average'} · ${m.historyDays} days of history · ${pct(m.zeroDayShare)} zero-sale days</p>
        ${bt ? html`<table class="small" style="margin-top:12px"><thead><tr><th>Backtest (${bt.windows} weeks)</th><th class="num">MAE</th><th class="num">WAPE</th></tr></thead><tbody>
          ${[['model', 'This model'], ['seasonal_naive', 'Same day last week'], ['mean_7', '7-day average']].map(([k, label]) =>
            html`<tr><td>${label}</td><td class="num">${n2(bt.metrics[k].mae)}</td><td class="num">${pct(bt.metrics[k].wape)}</td></tr>`)}</tbody></table>` : ''}
      </section>
    </div>`);

  const btn = $('#draft-po', el);
  btn.addEventListener('click', busy(btn, async () => {
    try { const po = await api(`/forecast/${pid}/draft-po`, { method: 'POST' }); toast(`Draft order #${po.id} created`); location.hash = `#/purchase/${po.id}`; }
    catch (e) { toast(e.message, 'bad'); }
  }));
  drawChart($('#fc-chart', el), f);
}
export { render_ as render };

export function drawChart(canvas, f) {
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement);
  const c = (v) => css.getPropertyValue(v).trim();
  const labels = [...f.history.map((h) => h.day), ...f.forecast.map((p) => p.day)];
  state.charts.push(new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Sold', data: [...f.history.map((h) => h.qty), ...f.forecast.map(() => null)], borderColor: c('--ink-3'), backgroundColor: c('--ink-3'), borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
      { label: 'Forecast', data: [...f.history.map(() => null), ...f.forecast.map((p) => p.qty)], borderColor: c('--brand'), backgroundColor: c('--brand'), borderWidth: 3, pointRadius: 3, tension: 0.25 },
    ] },
    options: {
      maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 7, color: c('--ink-3'), callback(v) { return fmtDate(this.getLabelForValue(v)).replace(/ \d{4}$/, ''); } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c('--ink-3') }, grid: { color: c('--line') } } },
      plugins: { legend: { position: 'bottom', labels: { color: c('--ink-2'), usePointStyle: true } },
        tooltip: { callbacks: { title: (items) => fmtDate(items[0].label), label: (i) => `${i.dataset.label}: ${n2(i.parsed.y)}` } } },
    },
  }));
}
