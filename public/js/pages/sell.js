import { api, html, render, money, fmtDate, $ } from '../core.js';
import { pageHeader, icon, emptyState, callout, toast, busy } from '../ui.js';
import { stockChanged } from './shared.js';

export async function render_(el) {
  const [products, recent] = await Promise.all([api('/products'), api('/sales')]);
  const active = products.filter((p) => p.active);
  const cart = [];
  render(el, html`
    ${pageHeader('Sell', 'Stock is taken from the batch that expires first. Expired batches are never sold.')}
    <div class="split">
      <section class="card">
        <form id="add" class="form-grid" style="grid-template-columns:1fr 110px auto;align-items:end">
          <label class="field"><span>Product</span><select name="productId">${active.map((p) =>
            html`<option value="${p.id}">${p.name} — ${p.usable} sellable${p.expired ? ` (${p.expired} expired)` : ''}</option>`)}</select></label>
          <label class="field"><span>Qty</span><input name="qty" type="number" min="1" step="1" value="1" inputmode="numeric"></label>
          <button class="btn" type="submit">${icon('plus')}Add</button>
        </form>
        <div id="cart" style="margin-top:16px"></div>
        <div id="sale-msg" style="margin-top:12px"></div>
      </section>
      <section class="card flush"><div class="card-head"><h2>Recent sales</h2></div>
        ${recent.length ? html`<div class="table-wrap"><table><tbody>${recent.slice(0, 12).map((s) => html`<tr>
          <td><span class="cell-strong">#${s.id}</span><span class="sub">${fmtDate(s.sale_date)} · ${s.sold_by ?? ''}</span></td>
          <td class="small">${s.lines.slice(0, 3).map((l) => html`${l.product} × ${l.qty}<br>`)}${s.lines.length > 3 ? html`<span class="muted">+${s.lines.length - 3} more</span>` : ''}</td>
          <td class="num cell-strong">${money(s.total)}</td></tr>`)}</tbody></table></div>` : emptyState('receipt', 'No sales yet')}
      </section>
    </div>`);

  const drawCart = () => {
    render($('#cart', el), cart.length ? html`<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Qty</th><th></th></tr></thead>
      <tbody>${cart.map((c, i) => html`<tr><td class="cell-strong">${c.name}</td><td class="num">${c.qty}</td>
        <td class="num"><button class="icon-btn" data-rm="${i}" aria-label="Remove ${c.name}">${icon('x')}</button></td></tr>`)}</tbody></table></div>
      <button class="btn btn-primary btn-lg btn-block" id="checkout" style="margin-top:14px">${icon('check')}Complete sale</button>`
      : emptyState('cart', 'Cart is empty', 'Pick a product and quantity above.'));
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { cart.splice(Number(b.dataset.rm), 1); drawCart(); }));
    const btn = $('#checkout', el);
    btn?.addEventListener('click', busy(btn, async () => {
      try {
        const s = await api('/sales', { method: 'POST', body: { items: cart.map((c) => ({ productId: c.productId, qty: c.qty })) } });
        render($('#sale-msg', el), callout('ok', 'check', html`<b>Sale #${s.saleId} saved — ${money(s.total)}</b><br>
          ${s.lines.map((l) => html`${l.productName}: ${l.qty} from batch <span class="batch-no">${l.batchNo}</span> (exp ${fmtDate(l.expiryDate)})<br>`)}`));
        toast(`Sale #${s.saleId} saved`);
        cart.length = 0; drawCart(); stockChanged();
      } catch (e) {
        render($('#sale-msg', el), callout('bad', 'alert', e.message));
      }
    }));
  };
  $('#add', el).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const p = active.find((x) => x.id === Number(f.productId.value));
    const qty = Number(f.qty.value);
    if (!Number.isInteger(qty) || qty < 1) return toast('Quantity must be a whole number of 1 or more', 'bad');
    const line = cart.find((c) => c.productId === p.id);
    if (line) line.qty += qty; else cart.push({ productId: p.id, name: p.name, qty });
    drawCart();
  });
  drawCart();
}
export { render_ as render };
