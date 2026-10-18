// Products & suppliers: add and edit (owner only).
import { api, html, render, money, $ } from '../core.js';
import { pageHeader, icon, toast, openDialog, badge } from '../ui.js';

export async function render_(el) {
  const [products, suppliers] = await Promise.all([api('/products'), api('/suppliers')]);
  render(el, html`
    ${pageHeader('Products & suppliers', 'What you sell and who you buy it from. Tap a row to edit it.',
      html`<button class="btn" id="add-supplier">${icon('plus')}Supplier</button><button class="btn btn-primary" id="add-product">${icon('plus')}Product</button>`)}
    <div class="split">
      <section class="card flush"><div class="card-head"><h2>Products</h2><p>${products.length} items</p></div><div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Supplier</th><th class="num">Lead</th><th class="num">Min level</th><th class="num">Price</th><th></th></tr></thead>
        <tbody>${products.map((p) => html`<tr class="clickable" data-product="${p.id}" tabindex="0">
          <td><span class="cell-strong">${p.name}</span> ${p.active ? '' : badge('written_off', 'Inactive')}<span class="sub mono">${p.sku} · ${p.unit}</span></td>
          <td>${p.supplier_name ?? html`<span class="hint-warn">none</span>`}</td><td class="num">${p.lead_time_days}d</td><td class="num">${p.min_level}</td>
          <td class="num">${money(p.sell_price)}</td><td class="num">${icon('arrow', 'muted')}</td></tr>`)}</tbody></table></div></section>
      <section class="card flush"><div class="card-head"><h2>Suppliers</h2></div><div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th class="num">Lead time</th></tr></thead>
        <tbody>${suppliers.map((s) => html`<tr class="clickable" data-supplier="${s.id}" tabindex="0"><td><span class="cell-strong">${s.name}</span><span class="sub">${s.phone ?? ''}</span></td>
          <td class="num">${s.lead_time_days} days</td></tr>`)}</tbody></table></div></section>
    </div>`);

  const productDialog = async (p = null) => {
    const ok = await openDialog({
      title: p ? `Edit ${p.name}` : 'Add product', submitLabel: p ? 'Save changes' : 'Add product',
      body: html`<div class="form-grid">
        <label class="field span-2"><span>Name</span><input name="name" required maxlength="120" value="${p?.name ?? ''}" placeholder="e.g. Paracetamol 500mg (strip)"></label>
        <label class="field"><span>SKU / code</span><input name="sku" required maxlength="40" value="${p?.sku ?? ''}"></label>
        <label class="field"><span>Unit</span><input name="unit" maxlength="20" value="${p?.unit ?? 'strip'}"></label>
        <label class="field span-2"><span>Supplier</span><select name="supplierId" id="sup">${suppliers.map((s) =>
          html`<option value="${s.id}" data-lead="${s.lead_time_days}" ${p?.supplier_id === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span>Lead time (days)</span><input name="leadTimeDays" type="number" min="0" max="365" required value="${p?.lead_time_days ?? suppliers[0]?.lead_time_days ?? 3}"></label>
        <label class="field"><span>Order every (days)</span><input name="reviewPeriodDays" type="number" min="1" max="365" required value="${p?.review_period_days ?? 7}"></label>
        <label class="field"><span>Minimum level</span><input name="minLevel" type="number" min="0" value="${p?.min_level ?? 0}"></label>
        <label class="field"><span>Sell price ৳</span><input name="sellPrice" type="number" min="0" step="0.01" required value="${p?.sell_price ?? ''}"></label>
        ${p ? html`<label class="row span-2"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Active — can be sold and appears on the Sell screen</label>` : ''}</div>`,
      onOpen: (dlg) => dlg.querySelector('#sup').addEventListener('change', (e) => {
        e.target.form.leadTimeDays.value = e.target.selectedOptions[0].dataset.lead; // default to the supplier's lead time
      }),
      onSubmit: (fd) => {
        const body = Object.fromEntries(fd);
        if (p) body.active = fd.has('active');
        return api(p ? `/products/${p.id}` : '/products', { method: p ? 'PATCH' : 'POST', body });
      },
    });
    if (ok) { toast(p ? 'Product saved' : 'Product added'); render_(el); }
  };

  const supplierDialog = async (s = null) => {
    const ok = await openDialog({
      title: s ? `Edit ${s.name}` : 'Add supplier', submitLabel: s ? 'Save changes' : 'Add supplier',
      body: html`<label class="field"><span>Name</span><input name="name" required maxlength="120" value="${s?.name ?? ''}"></label><div class="form-grid">
        <label class="field"><span>Phone</span><input name="phone" type="tel" maxlength="30" value="${s?.phone ?? ''}"></label>
        <label class="field"><span>Lead time (days)</span><input name="leadTimeDays" type="number" min="0" max="365" value="${s?.lead_time_days ?? 3}"></label></div>
        ${s ? html`<p class="small muted">Changing the lead time here doesn't change products — each product keeps its own lead time.</p>` : ''}`,
      onSubmit: (fd) => api(s ? `/suppliers/${s.id}` : '/suppliers', { method: s ? 'PATCH' : 'POST', body: Object.fromEntries(fd) }),
    });
    if (ok) { toast(s ? 'Supplier saved' : 'Supplier added'); render_(el); }
  };

  $('#add-product', el).addEventListener('click', () => productDialog());
  $('#add-supplier', el).addEventListener('click', () => supplierDialog());
  const open = (e) => {
    const pr = e.target.closest('[data-product]');
    if (pr) return productDialog(products.find((x) => x.id === Number(pr.dataset.product)));
    const sr = e.target.closest('[data-supplier]');
    if (sr) supplierDialog(suppliers.find((x) => x.id === Number(sr.dataset.supplier)));
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
}
export { render_ as render };
