import { api, html, render, isOwner, n2, fmtDate, $ } from '../core.js';
import { pageHeader, icon, badge, emptyState, toast, openDialog, confirmDialog, busy } from '../ui.js';
import { stockChanged } from './shared.js';

export async function render_(el, [poId]) {
  const [orders, suppliers, products] = await Promise.all([api('/purchase-orders'), api('/suppliers'), api('/products')]);
  const owner = isOwner();
  render(el, html`
    ${pageHeader('Purchase orders', 'Draft → Ordered → Received.', owner ? html`<button class="btn btn-primary" id="new-po">${icon('plus')}New order</button>` : '')}
    <div id="po-detail"></div>
    <section class="card flush"><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Status</th><th>Supplier</th><th>Items</th><th>Created</th></tr></thead>
      <tbody>${orders.map((o) => html`<tr class="clickable ${String(o.id) === poId ? 'selected' : ''}" data-po="${o.id}"><td class="mono">${o.id}</td><td>${badge(o.status)}</td>
        <td class="cell-strong">${o.supplier_name}</td><td class="small">${o.items.map((i) => `${i.productName} × ${i.qty}`).join(', ')}</td><td>${fmtDate(o.created_at.slice(0, 10))}</td></tr>`)}</tbody>
    </table></div></section>`);
  el.querySelectorAll('[data-po]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/purchase/${tr.dataset.po}`; }));
  $('#new-po', el)?.addEventListener('click', () => newOrderDialog(suppliers, products));
  if (poId) await renderDetail($('#po-detail', el), Number(poId), () => render_(el, [poId]));
}
export { render_ as render };

async function newOrderDialog(suppliers, products) {
  const line = () => html`<div class="form-grid po-line" style="grid-template-columns:2fr 1fr 1fr auto;align-items:end">
    <label class="field"><span>Product</span><select name="productId">${products.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
    <label class="field"><span>Qty</span><input name="qty" type="number" min="1" step="1" required></label>
    <label class="field"><span>Unit cost ৳</span><input name="unitCost" type="number" min="0" step="0.01"></label>
    <button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button></div>`;
  const po = await openDialog({
    title: 'New purchase order', wide: true, submitLabel: 'Create draft',
    body: html`<div class="form-grid"><label class="field"><span>Supplier</span><select name="supplierId">${suppliers.map((s) => html`<option value="${s.id}">${s.name} (${s.lead_time_days}-day lead)</option>`)}</select></label>
      <label class="field"><span>Note</span><input name="note"></label></div><div id="po-lines" class="stack">${line()}</div>
      <button type="button" class="btn btn-sm" id="add-line" style="justify-self:start">${icon('plus')}Add item</button>`,
    onOpen: (dlg) => dlg.addEventListener('click', (e) => {
      if (e.target.closest('#add-line')) {
        const lines = dlg.querySelector('#po-lines');
        const clone = lines.firstElementChild.cloneNode(true);
        clone.querySelectorAll('input').forEach((i) => { i.value = ''; });
        lines.append(clone);
      }
      const rm = e.target.closest('[data-rm]');
      if (rm && dlg.querySelectorAll('.po-line').length > 1) rm.closest('.po-line').remove();
    }),
    onSubmit: async (_fd, dlg) => {
      const items = [...dlg.querySelectorAll('.po-line')].map((d) => ({ productId: Number(d.querySelector('[name=productId]').value),
        qty: Number(d.querySelector('[name=qty]').value), unitCost: d.querySelector('[name=unitCost]').value }));
      return api('/purchase-orders', { method: 'POST', body: { supplierId: Number(dlg.querySelector('[name=supplierId]').value), note: dlg.querySelector('[name=note]').value, items } });
    },
  });
  if (po) { toast(`Draft order #${po.id} created`); location.hash = `#/purchase/${po.id}`; }
}
async function renderDetail(box, id, reload) {
  const po = await api(`/purchase-orders/${id}`);
  const owner = isOwner();
  render(box, html`<section class="card">
    <div class="card-head"><div><h2>Order #${po.id} ${badge(po.status)}</h2><p>${po.supplier_name}${po.note ? ` · ${po.note}` : ''}</p></div>
      <div class="row">${owner && po.status === 'draft' ? html`<button class="btn btn-primary" data-act="place">Place order</button>` : ''}
        ${owner && ['draft', 'ordered'].includes(po.status) ? html`<button class="btn" data-act="cancel">Cancel order</button>` : ''}
        ${po.status === 'ordered' ? html`<button class="btn btn-primary" id="receive">${icon('box')}Receive goods</button>` : ''}</div></div>
    <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Qty</th>${owner ? html`<th class="num">Unit cost</th>` : ''}</tr></thead>
      <tbody>${po.items.map((i) => html`<tr><td class="cell-strong">${i.productName}</td><td class="num">${i.qty}</td>${owner ? html`<td class="num">${n2(i.unitCost)}</td>` : ''}</tr>`)}</tbody></table></div></section>`);
  box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    const act = b.dataset.act;
    if (act === 'cancel' && !(await confirmDialog({ title: 'Cancel this order?', message: 'A cancelled order cannot be reopened.', confirmLabel: 'Cancel order', tone: 'danger' }))) return;
    try { await api(`/purchase-orders/${id}/${act}`, { method: 'POST' }); toast(act === 'place' ? 'Order placed' : 'Order cancelled'); reload(); } catch (e) { toast(e.message, 'bad'); }
  })));
  $('#receive', box)?.addEventListener('click', async () => {
    const res = await openDialog({
      title: `Receive order #${po.id}`, wide: true, submitLabel: 'Receive into stock',
      body: html`<p class="muted small">Type the batch number and the expiry printed on the pack. Month/year is enough — it counts as valid to the end of that month.</p>
        ${po.items.map((i) => html`<div class="form-grid rcv-line" data-item="${i.id}" style="align-items:end"><div class="field"><span>Product</span><b>${i.productName}</b></div>
          <label class="field"><span>Batch no</span><input name="batchNo" required></label><label class="field"><span>Expiry</span><input name="expiry" type="month" min="${new Date().toISOString().slice(0, 7)}" required></label>
          <label class="field"><span>Qty (of ${i.qty})</span><input name="qty" type="number" min="1" max="${i.qty}" value="${i.qty}" required></label>
          ${owner ? html`<label class="field"><span>Unit cost ৳</span><input name="unitCost" type="number" min="0" step="0.01" value="${i.unitCost ?? ''}"></label>` : ''}</div>`)}`,
      onSubmit: async (_fd, dlg) => api(`/purchase-orders/${id}/receive`, { method: 'POST', body: { lines: [...dlg.querySelectorAll('.rcv-line')].map((r) => ({
        poItemId: Number(r.dataset.item), batchNo: r.querySelector('[name=batchNo]').value, expiry: r.querySelector('[name=expiry]').value,
        qty: Number(r.querySelector('[name=qty]').value), unitCost: r.querySelector('[name=unitCost]')?.value })) } }),
    });
    if (res) { toast(`Received ${res.batches.length} batches into stock`); stockChanged(); reload(); }
  });
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
