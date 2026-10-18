import { api, html, render, isOwner, fmtDate, state } from '../core.js';
import { pageHeader, icon, emptyState } from '../ui.js';
import { batchTable, bindWriteOff } from './shared.js';

export async function render_(el) {
  const [products, alerts, pos] = await Promise.all([api('/products'), api('/alerts/expiry'), api('/purchase-orders?status=ordered')]);
  const below = products.filter((p) => p.below_min);
  const expired = alerts.filter((a) => a.status === 'expired');
  const near = alerts.filter((a) => a.status === 'near_expiry');
  render(el, html`
    ${pageHeader(`Good ${greeting()}, ${state.user.name.replace(/\s*\(.*\)/, '')}`, `Here's the shop on ${fmtDate(state.today)}.`,
      html`<a class="btn btn-primary" href="#/sell">${icon('cart')}New sale</a>`)}
    <div class="grid cols-4">
      <div class="card stat tone-${below.length ? 'warn' : 'ok'}"><div class="stat-top">Below minimum level ${icon('box')}</div><div class="stat-value">${below.length}</div><div class="stat-foot">products</div></div>
      <div class="card stat tone-${expired.length ? 'bad' : 'ok'}"><div class="stat-top">Expired on shelf ${icon('alert')}</div><div class="stat-value">${expired.length}</div><div class="stat-foot">batches to remove</div></div>
      <div class="card stat tone-${near.length ? 'warn' : 'ok'}"><div class="stat-top">Expiring in 60 days ${icon('clock')}</div><div class="stat-value">${near.length}</div><div class="stat-foot">batches</div></div>
      <div class="card stat tone-info"><div class="stat-top">In transit ${icon('truck')}</div><div class="stat-value">${pos.length}</div><div class="stat-foot">purchase orders</div></div>
    </div>
    <section class="card flush"><div class="card-head"><div><h2>Expiry watch</h2><p>Expired and soon-to-expire batches, earliest first.</p></div></div>
      ${alerts.length ? batchTable(alerts, { showProduct: true, writeOff: isOwner() }) : emptyState('check', 'Nothing expiring soon', 'No batch expires in the next 60 days.')}</section>
    <section class="card flush"><div class="card-head"><div><h2>Below minimum level</h2></div></div>
      ${below.length ? html`<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Usable</th><th class="num">Minimum</th><th class="num">On order</th>${isOwner() ? html`<th></th>` : ''}</tr></thead>
        <tbody>${below.map((p) => html`<tr><td class="cell-strong">${p.name}</td><td class="num">${p.usable}</td><td class="num">${p.min_level}</td><td class="num">${p.on_order}</td>
          ${isOwner() ? html`<td class="num"><a class="btn btn-sm" href="#/forecast/${p.id}">Plan reorder ${icon('arrow')}</a></td>` : ''}</tr>`)}</tbody></table></div>`
        : emptyState('check', 'All stocked up', 'Every product is above its minimum level.')}</section>`);
  bindWriteOff(el, alerts, () => render_(el));
}
export { render_ as render };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
