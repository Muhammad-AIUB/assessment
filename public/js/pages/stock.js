import { api, html, render, money, $ } from '../core.js';
import { pageHeader, emptyState, badge } from '../ui.js';
import { batchTable, bindWriteOff } from './shared.js';
import { isOwner } from '../core.js';

export async function render_(el, [productId]) {
  const products = await api('/products');
  render(el, html`
    ${pageHeader('Stock & expiry', 'Tap a product to see its batches.')}
    <section class="card flush"><div class="table-wrap"><table>
      <thead><tr><th>Product</th><th>Supplier</th><th class="num">Usable</th><th class="num">Expiring</th><th class="num">Expired</th><th class="num">On order</th><th class="num">Price</th></tr></thead>
      <tbody>${products.map((p) => html`<tr class="clickable ${String(p.id) === productId ? 'selected' : ''}" data-pid="${p.id}">
        <td><span class="cell-strong">${p.name}</span> ${p.below_min ? badge('expired', 'Below min') : ''}<span class="sub mono">${p.sku}</span></td>
        <td>${p.supplier_name}</td><td class="num cell-strong">${p.usable}</td><td class="num">${p.near_expiry || ''}</td>
        <td class="num">${p.expired || ''}</td><td class="num">${p.on_order || ''}</td><td class="num">${money(p.sell_price)}</td></tr>`)}</tbody></table></div></section>
    <div id="batches"></div>`);
  el.querySelectorAll('[data-pid]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/stock/${tr.dataset.pid}`; }));
  if (productId) {
    const p = products.find((x) => x.id === Number(productId));
    const batches = await api(`/batches?productId=${productId}`);
    const box = $('#batches', el);
    render(box, html`<section class="card flush"><div class="card-head"><h2>Batches — ${p?.name}</h2></div>
      ${batches.length ? batchTable(batches.map((b) => ({ ...b, product_name: p?.name })), { writeOff: isOwner() }) : emptyState('box', 'No batches', 'This product has never been received.')}</section>`);
    bindWriteOff(box, batches.map((b) => ({ ...b, product_name: p?.name })), () => render_(el, [productId]));
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
export { render_ as render };
