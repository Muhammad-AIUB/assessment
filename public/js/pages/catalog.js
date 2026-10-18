import { api, html, render, money, $ } from '../core.js';
import { pageHeader, icon, toast, openDialog } from '../ui.js';

export async function render_(el) {
  const [products, suppliers] = await Promise.all([api('/products'), api('/suppliers')]);
  render(el, html`
    ${pageHeader('Products & suppliers', 'What you sell and who you buy it from.',
      html`<button class="btn" id="add-supplier">${icon('plus')}Supplier</button><button class="btn btn-primary" id="add-product">${icon('plus')}Product</button>`)}
    <div class="split">
      <section class="card flush"><div class="card-head"><h2>Products</h2></div><div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Supplier</th><th class="num">Lead</th><th class="num">Min level</th><th class="num">Price</th></tr></thead>
        <tbody>${products.map((p) => html`<tr><td><span class="cell-strong">${p.name}</span><span class="sub mono">${p.sku} · ${p.unit}</span></td>
          <td>${p.supplier_name}</td><td class="num">${p.lead_time_days}d</td><td class="num">${p.min_level}</td><td class="num">${money(p.sell_price)}</td></tr>`)}</tbody></table></div></section>
      <section class="card flush"><div class="card-head"><h2>Suppliers</h2></div><div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th class="num">Lead time</th></tr></thead>
        <tbody>${suppliers.map((s) => html`<tr><td><span class="cell-strong">${s.name}</span><span class="sub">${s.phone ?? ''}</span></td><td class="num">${s.lead_time_days} days</td></tr>`)}</tbody></table></div></section>
    </div>`);

  $('#add-product', el).addEventListener('click', async () => {
    const ok = await openDialog({
      title: 'Add product', submitLabel: 'Add product',
      body: html`<div class="form-grid">
        <label class="field span-2"><span>Name</span><input name="name" required placeholder="e.g. Paracetamol 500mg (strip)"></label>
        <label class="field"><span>SKU / code</span><input name="sku" required></label>
        <label class="field"><span>Unit</span><input name="unit" value="strip"></label>
        <label class="field span-2"><span>Supplier</span><select name="supplierId" id="sup">${suppliers.map((s) => html`<option value="${s.id}" data-lead="${s.lead_time_days}">${s.name}</option>`)}</select></label>
        <label class="field"><span>Lead time (days)</span><input name="leadTimeDays" type="number" min="0" value="${suppliers[0]?.lead_time_days ?? 3}" required></label>
        <label class="field"><span>Minimum level</span><input name="minLevel" type="number" min="0" value="0"></label>
        <label class="field"><span>Sell price ৳</span><input name="sellPrice" type="number" min="0" step="0.01" required></label></div>`,
      onOpen: (dlg) => dlg.querySelector('#sup').addEventListener('change', (e) => {
        e.target.form.leadTimeDays.value = e.target.selectedOptions[0].dataset.lead; // default to the supplier's lead time
      }),
      onSubmit: (fd) => api('/products', { method: 'POST', body: Object.fromEntries(fd) }),
    });
    if (ok) { toast('Product added'); render_(el); }
  });
  $('#add-supplier', el).addEventListener('click', async () => {
    const ok = await openDialog({
      title: 'Add supplier', submitLabel: 'Add supplier',
      body: html`<label class="field"><span>Name</span><input name="name" required></label><div class="form-grid">
        <label class="field"><span>Phone</span><input name="phone" type="tel"></label>
        <label class="field"><span>Lead time (days)</span><input name="leadTimeDays" type="number" min="0" value="3"></label></div>`,
      onSubmit: (fd) => api('/suppliers', { method: 'POST', body: Object.fromEntries(fd) }),
    });
    if (ok) { toast('Supplier added'); render_(el); }
  });
}
export { render_ as render };
