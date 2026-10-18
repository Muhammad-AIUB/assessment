import { api, html, render, fmtDate } from '../core.js';
import { pageHeader, emptyState } from '../ui.js';

const TYPE = { receive: ['Received', 'ok'], sale: ['Sold', 'info'], write_off: ['Written off', 'bad'] };

export async function render_(el) {
  const rows = await api('/stock-history');
  render(el, html`${pageHeader('Stock history', 'Every receipt, sale and write-off — append-only, never edited. Latest 200 shown.')}
    <section class="card flush">${rows.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>What</th><th>Product</th><th>Batch</th><th class="num">Qty</th><th>By</th><th>Reason / reference</th></tr></thead>
      <tbody>${rows.map((m) => html`<tr><td>${fmtDate(m.movement_date)}</td><td><span class="pill pill-${TYPE[m.type][1]}">${TYPE[m.type][0]}</span></td>
        <td class="cell-strong">${m.product_name}</td><td><span class="batch-no">${m.batch_no}</span></td>
        <td class="num cell-strong" style="color:var(--${m.qty < 0 ? 'bad' : 'ok'})">${m.qty > 0 ? '+' : ''}${m.qty}</td><td>${m.user_name ?? ''}</td>
        <td class="small">${m.reason ?? (m.ref_id ? `${m.type === 'sale' ? 'Sale' : 'Order'} #${m.ref_id}` : '')}</td></tr>`)}</tbody></table></div>`
      : emptyState('history', 'No movements yet')}</section>`);
}
export { render_ as render };
