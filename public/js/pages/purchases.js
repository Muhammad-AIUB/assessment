// Purchase orders: list with status tabs, order page with timeline, draft editing and a guided receive form.
import { api, html, render, isOwner, n2, money, fmtDate, plural, state, $ } from '../core.js';
import { pageHeader, icon, badge, emptyState, toast, openDialog, confirmDialog, busy, callout } from '../ui.js';
import { stockChanged } from './shared.js';

const DAY = 86_400_000;
const isoAdd = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const orderTotal = (o) => o.items.reduce((s, i) => s + i.qty * (i.unitCost ?? 0), 0);
const expectedOn = (o) => (o.ordered_at ? isoAdd(o.ordered_at.slice(0, 10), o.lead_time_days) : null);

function arrivalHint(o) {
  if (o.status !== 'ordered') return '';
  const due = expectedOn(o);
  const d = daysBetween(due, state.today);
  if (d < 0) return html`<span class="hint-bad">${icon('alert')}Overdue by ${plural(-d, 'day')}</span>`;
  if (d === 0) return html`<span class="hint-warn">${icon('truck')}Due today</span>`;
  return html`<span class="muted">${icon('truck')}Due ${fmtDate(due)} (in ${plural(d, 'day')})</span>`;
}

let lastTab = null;

export async function render_(el, [poId]) {
  if (poId) return renderOrder(el, Number(poId));
  const [orders, suppliers, products] = await Promise.all([api('/purchase-orders'), api('/suppliers'), api('/products')]);
  const owner = isOwner();
  const TABS = [
    ['ordered', 'To receive', (o) => o.status === 'ordered'],
    ...(owner ? [['draft', 'Drafts', (o) => o.status === 'draft']] : []),
    ['received', 'Received', (o) => o.status === 'received'],
    ['cancelled', 'Cancelled', (o) => o.status === 'cancelled'],
    ['all', 'All', () => true],
  ];
  let tab = lastTab && TABS.some(([k]) => k === lastTab) ? lastTab
    : owner && orders.some((o) => o.status === 'draft') ? 'draft' : 'ordered';
  let q = '';

  render(el, html`
    ${pageHeader('Purchase orders', owner ? 'Draft → Ordered → Received. Received goods become batches in stock.' : 'Orders on the way. Open one to receive the goods into stock.',
      owner ? html`<button class="btn btn-primary" id="new-po">${icon('plus')}New order</button>` : '')}
    <div class="toolbar">
      <div class="chips" role="tablist">${TABS.map(([k, label, fn]) => html`<button class="chip" role="tab" data-tab="${k}">${label} <span class="count">${orders.filter(fn).length}</span></button>`)}</div>
      <div class="search toolbar-search">${icon('search')}<input class="input" type="search" id="q" placeholder="Supplier or product…" aria-label="Filter orders"></div>
    </div>
    <section class="card flush" id="list"></section>`);

  const draw = () => {
    el.querySelectorAll('[data-tab]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.tab === tab)));
    const fn = TABS.find(([k]) => k === tab)[2];
    const needle = q.trim().toLowerCase();
    const list = orders.filter(fn).filter((o) => !needle || o.supplier_name.toLowerCase().includes(needle) || o.items.some((i) => i.productName.toLowerCase().includes(needle)));
    render($('#list', el), list.length ? html`<div class="table-wrap"><table>
      <thead><tr><th>Order</th><th>Supplier</th><th>Items</th>${owner ? html`<th class="num">Value</th>` : ''}<th>Status</th><th></th></tr></thead>
      <tbody>${list.map((o) => html`<tr class="clickable" data-po="${o.id}" tabindex="0">
        <td><span class="cell-strong mono">#${o.id}</span><span class="sub">${fmtDate(o.created_at.slice(0, 10))}</span></td>
        <td class="cell-strong">${o.supplier_name}</td>
        <td class="small">${o.items.slice(0, 2).map((i) => html`${i.productName} × ${i.qty}<br>`)}${o.items.length > 2 ? html`<span class="muted">+${o.items.length - 2} more</span>` : ''}</td>
        ${owner ? html`<td class="num">${money(orderTotal(o))}</td>` : ''}
        <td>${badge(o.status)}<span class="sub">${arrivalHint(o)}</span></td>
        <td class="num">${o.status === 'ordered' ? html`<span class="btn btn-sm btn-primary">Receive</span>` : icon('arrow', 'muted')}</td></tr>`)}</tbody></table></div>`
      : emptyState('truck', tab === 'ordered' ? 'Nothing to receive' : 'No orders here', tab === 'ordered' ? 'Orders appear here once the owner places them with a supplier.' : needle ? 'Try a different search.' : ''));
  };
  el.querySelectorAll('[data-tab]').forEach((c) => c.addEventListener('click', () => { tab = lastTab = c.dataset.tab; draw(); }));
  $('#q', el).addEventListener('input', (e) => { q = e.target.value; draw(); });
  const open = (tr) => { location.hash = `#/purchase/${tr.dataset.po}`; };
  $('#list', el).addEventListener('click', (e) => { const tr = e.target.closest('[data-po]'); if (tr) open(tr); });
  $('#list', el).addEventListener('keydown', (e) => { const tr = e.target.closest('[data-po]'); if (tr && e.key === 'Enter') open(tr); });
  $('#new-po', el)?.addEventListener('click', () => orderDialog({ suppliers, products }));
  draw();
}
export { render_ as render };

// ---------- create / edit draft ----------
async function orderDialog({ suppliers, products, po = null }) {
  const lineHtml = (it = {}) => html`<div class="po-line">
    <label class="field"><span>Product</span><select name="productId">${products.map((p) => html`<option value="${p.id}" data-sup="${p.supplier_id}" ${p.id === it.productId ? 'selected' : ''}>${p.name}</option>`)}</select></label>
    <label class="field"><span>Qty</span><input name="qty" type="number" min="1" step="1" required value="${it.qty ?? ''}"></label>
    <label class="field"><span>Unit cost ৳</span><input name="unitCost" type="number" min="0" step="0.01" value="${it.unitCost ?? ''}" placeholder="required to order"></label>
    <span class="line-total num">–</span>
    <button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('trash')}</button></div>`;
  const items = po ? po.items : [{}];
  const result = await openDialog({
    title: po ? `Edit draft #${po.id}` : 'New purchase order', wide: true, submitLabel: po ? 'Save changes' : 'Create draft',
    body: html`${po ? '' : html`<div class="form-grid"><label class="field"><span>Supplier</span><select name="supplierId">${suppliers.map((s) => html`<option value="${s.id}">${s.name} · ${s.lead_time_days}-day lead</option>`)}</select></label>
        <label class="field"><span>Note <small>(optional)</small></span><input name="note" placeholder="e.g. monthly restock"></label></div>`}
      <div class="po-lines" id="po-lines">${items.map(lineHtml)}</div>
      <div class="row"><button type="button" class="btn btn-sm" id="add-line">${icon('plus')}Add item</button><span class="spacer"></span>
        <span class="muted">Order value</span><b class="num" id="po-total" style="font-size:18px">৳0.00</b></div>
      <p class="small muted">Tip: a product can appear once per order. Products from the chosen supplier are listed first.</p>`,
    onOpen: (dlg) => {
      const lines = dlg.querySelector('#po-lines');
      const recalc = () => {
        let total = 0;
        lines.querySelectorAll('.po-line').forEach((l) => {
          const v = Number(l.querySelector('[name=qty]').value) * Number(l.querySelector('[name=unitCost]').value);
          l.querySelector('.line-total').textContent = v ? money(v) : '–';
          total += v || 0;
        });
        dlg.querySelector('#po-total').textContent = money(total);
      };
      const sortBySupplier = () => {
        const sup = dlg.querySelector('[name=supplierId]')?.value;
        if (!sup) return;
        lines.querySelectorAll('select[name=productId]').forEach((sel) => {
          const opts = [...sel.options].sort((a, b) => (b.dataset.sup === sup) - (a.dataset.sup === sup) || a.text.localeCompare(b.text));
          const v = sel.value; sel.replaceChildren(...opts); sel.value = v;
        });
      };
      dlg.querySelector('[name=supplierId]')?.addEventListener('change', sortBySupplier);
      dlg.addEventListener('input', recalc);
      dlg.addEventListener('click', (e) => {
        if (e.target.closest('#add-line')) {
          const tmp = document.createElement('div');
          render(tmp, lineHtml());
          lines.append(tmp.firstElementChild);
          sortBySupplier();
          lines.lastElementChild.querySelector('select').focus();
        }
        const rm = e.target.closest('[data-rm]');
        if (rm && lines.children.length > 1) { rm.closest('.po-line').remove(); recalc(); }
      });
      sortBySupplier(); recalc();
    },
    onSubmit: async (_fd, dlg) => {
      const rows = [...dlg.querySelectorAll('.po-line')].map((d) => ({ productId: Number(d.querySelector('[name=productId]').value),
        qty: Number(d.querySelector('[name=qty]').value), unitCost: d.querySelector('[name=unitCost]').value }));
      if (new Set(rows.map((r) => r.productId)).size !== rows.length) throw new Error('The same product is listed twice — combine them into one line.');
      if (po) return api(`/purchase-orders/${po.id}/items`, { method: 'PUT', body: { items: rows } });
      return api('/purchase-orders', { method: 'POST', body: { supplierId: Number(dlg.querySelector('[name=supplierId]').value), note: dlg.querySelector('[name=note]').value, items: rows } });
    },
  });
  if (result) { toast(po ? 'Draft updated' : `Draft order #${result.id} created`); if (po) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = `#/purchase/${result.id}`; }
}

// ---------- order page ----------
async function renderOrder(el, id) {
  let po;
  try { po = await api(`/purchase-orders/${id}`); } catch (e) {
    if (e.status !== 404) throw e;
    render(el, html`<a class="back" href="#/purchase">${icon('back')}All orders</a>${emptyState('truck', `Order #${id} doesn't exist`, 'It may have been removed when the demo data was reset.', html`<a class="btn" href="#/purchase">See all orders</a>`)}`);
    return;
  }
  const owner = isOwner();
  const steps = [['draft', 'Draft', po.created_at], ['ordered', 'Ordered', po.ordered_at], ['received', 'Received', po.received_at]];
  const reached = { draft: 0, ordered: 1, received: 2, cancelled: po.ordered_at ? 1 : 0 }[po.status];
  const missingCost = po.items.some((i) => i.unitCost === null);

  render(el, html`
    <a class="back" href="#/purchase">${icon('back')}All orders</a>
    ${pageHeader(html`Order <span class="mono">#${po.id}</span>`, html`${po.supplier_name}${po.note ? html` · <span class="muted">${po.note}</span>` : ''}`, html`
      ${owner && po.status === 'draft' ? html`<button class="btn" id="edit">Edit items</button><button class="btn btn-primary" data-act="place" ${missingCost ? 'disabled' : ''}>${icon('truck')}Place order</button>` : ''}
      ${po.status === 'ordered' ? html`<a class="btn btn-primary" href="#receive" id="jump-receive">${icon('box')}Receive goods</a>` : ''}
      ${owner && ['draft', 'ordered'].includes(po.status) ? html`<button class="btn btn-ghost" data-act="cancel">Cancel order</button>` : ''}`)}
    <ol class="timeline ${po.status === 'cancelled' ? 'is-cancelled' : ''}">${steps.map(([k, label, at], i) => html`
      <li class="${i < reached || (i === reached && po.status !== 'cancelled') ? 'done' : ''} ${i === reached && po.status !== 'cancelled' ? 'current' : ''}">
        <span class="dot">${i <= reached && po.status !== 'cancelled' ? icon('check') : ''}</span><b>${label}</b>
        <span class="small muted">${at ? fmtDate(String(at).slice(0, 10)) : k === 'received' && po.status === 'ordered' ? `expected ${fmtDate(expectedOn(po))}` : ''}</span></li>`)}
      ${po.status === 'cancelled' ? html`<li class="cancelled"><span class="dot">${icon('x')}</span><b>Cancelled</b><span class="small muted">${fmtDate(String(po.cancelled_at).slice(0, 10))}</span></li>` : ''}</ol>
    ${po.status === 'draft' && missingCost && owner ? callout('warn', 'info', html`Add a unit cost to every item before placing the order. <button class="btn btn-sm" id="edit2">Add costs</button>`) : ''}
    ${po.status === 'ordered' ? html`<div>${arrivalHint(po)}</div>` : ''}
    ${po.status === 'received' ? callout('ok', 'check', html`Received into stock on ${fmtDate(String(po.received_at).slice(0, 10))}. Each line is now its own batch —
      ${po.items.map((i, k) => html`${k ? ', ' : ''}<a href="#/stock/${i.productId}">${i.productName}</a>`)}.`) : ''}
    <section class="card flush"><div class="table-wrap"><table>
      <thead><tr><th>Product</th><th class="num">Qty</th>${owner ? html`<th class="num">Unit cost</th><th class="num">Line total</th>` : ''}</tr></thead>
      <tbody>${po.items.map((i) => html`<tr><td class="cell-strong">${i.productName}<span class="sub mono">${i.sku}</span></td><td class="num">${i.qty}</td>
        ${owner ? html`<td class="num">${i.unitCost === null ? html`<span class="hint-warn">not set</span>` : n2(i.unitCost)}</td><td class="num">${i.unitCost === null ? '–' : money(i.qty * i.unitCost)}</td>` : ''}</tr>`)}</tbody>
      ${owner ? html`<tfoot><tr><td colspan="3" class="num muted">Order value</td><td class="num cell-strong">${money(orderTotal(po))}</td></tr></tfoot>` : ''}</table></div></section>
    ${po.status === 'ordered' ? html`<section class="card" id="receive">${receiveForm(po, owner)}</section>` : ''}`);

  const reload = () => renderOrder(el, id);
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', busy(b, async () => {
    const act = b.dataset.act;
    if (act === 'cancel' && !(await confirmDialog({ title: `Cancel order #${po.id}?`, message: 'A cancelled order cannot be reopened. Nothing is added to stock.', confirmLabel: 'Cancel order', tone: 'danger' }))) return;
    if (act === 'place' && !(await confirmDialog({ title: `Place order #${po.id}?`, message: `This marks the order as sent to ${po.supplier_name}. Its quantities will count as “on order” in reorder suggestions.`, confirmLabel: 'Place order' }))) return;
    try { await api(`/purchase-orders/${id}/${act}`, { method: 'POST' }); toast(act === 'place' ? 'Order placed' : 'Order cancelled'); reload(); } catch (e) { toast(e.message, 'bad'); }
  })));
  const edit = async () => {
    const [suppliers, products] = await Promise.all([api('/suppliers'), api('/products')]);
    await orderDialog({ suppliers, products, po });
  };
  $('#edit', el)?.addEventListener('click', edit);
  $('#edit2', el)?.addEventListener('click', edit);
  $('#jump-receive', el)?.addEventListener('click', (e) => { e.preventDefault(); $('#receive', el).scrollIntoView({ behavior: 'smooth' }); $('#receive input', el)?.focus(); });
  if (po.status === 'ordered') bindReceive($('#receive', el), po, owner, reload);
}

// ---------- receiving ----------
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

function batchRow(item, owner, qty) {
  return html`<div class="rcv-batch">
    <label class="field"><span>Batch no</span><input name="batchNo" required placeholder="as printed" autocapitalize="characters"></label>
    <label class="field"><span>Expiry (month/year)</span><input name="expiry" type="month" required min="${state.today.slice(0, 7)}"><small class="exp-hint">&nbsp;</small></label>
    <label class="field"><span>Qty</span><input name="qty" type="number" min="1" max="${item.qty}" value="${qty}" required></label>
    ${owner ? html`<label class="field"><span>Unit cost ৳</span><input name="unitCost" type="number" min="0" step="0.01" value="${item.unitCost ?? ''}"></label>` : ''}
    <button type="button" class="icon-btn" data-rm-batch aria-label="Remove this batch">${icon('x')}</button></div>`;
}

function receiveForm(po, owner) {
  return html`<div class="card-head"><div><h2>Receive goods</h2><p>Copy the batch number and expiry from each pack. If one product arrived in two batches, use “Split into another batch”.</p></div></div>
    <form id="rcv-form" class="stack" novalidate>
      ${po.items.map((i) => html`<fieldset class="rcv-item" data-item="${i.id}" data-ordered="${i.qty}">
        <legend><b>${i.productName}</b> <span class="muted">· ordered ${i.qty}</span><span class="rcv-count"></span></legend>
        <div class="rcv-batches">${batchRow(i, owner, i.qty)}</div>
        <button type="button" class="btn btn-sm btn-ghost" data-split>${icon('plus')}Split into another batch</button></fieldset>`)}
      <p class="field-error" id="rcv-error" role="alert"></p>
      <div class="row"><span class="spacer"></span><button class="btn btn-primary btn-lg" type="submit">${icon('check')}Receive into stock</button></div>
    </form>`;
}

function bindReceive(box, po, owner, reload) {
  const form = $('#rcv-form', box);
  const update = () => {
    form.querySelectorAll('.rcv-item').forEach((f) => {
      const ordered = Number(f.dataset.ordered);
      const got = [...f.querySelectorAll('[name=qty]')].reduce((s, i) => s + (Number(i.value) || 0), 0);
      const c = f.querySelector('.rcv-count');
      c.className = `rcv-count ${got > ordered ? 'hint-bad' : got < ordered ? 'hint-warn' : 'hint-ok'}`;
      c.textContent = got > ordered ? ` · ${got} entered — more than ordered` : got < ordered ? ` · ${got} of ${ordered} — short delivery` : ` · all ${ordered} assigned`;
      f.querySelectorAll('[data-rm-batch]').forEach((b) => { b.hidden = f.querySelectorAll('.rcv-batch').length === 1; });
    });
    form.querySelectorAll('[name=expiry]').forEach((inp) => {
      const hint = inp.parentElement.querySelector('.exp-hint');
      if (!inp.value) { hint.innerHTML = '&nbsp;'; hint.className = 'exp-hint'; return; }
      const end = monthEnd(inp.value);
      const days = daysBetween(end, state.today);
      hint.className = `exp-hint ${days < 0 ? 'hint-bad' : days < 180 ? 'hint-warn' : ''}`;
      hint.textContent = days < 0 ? 'Already expired — do not accept' : `Valid until ${fmtDate(end)}${days < 180 ? ' · short-dated' : ''}`;
    });
  };
  form.addEventListener('input', update);
  form.addEventListener('click', (e) => {
    const split = e.target.closest('[data-split]');
    if (split) {
      const f = split.closest('.rcv-item');
      const item = po.items.find((i) => i.id === Number(f.dataset.item));
      const qtys = [...f.querySelectorAll('[name=qty]')];
      const assigned = qtys.reduce((s, i) => s + (Number(i.value) || 0), 0);
      // Take half of the last batch's quantity so the totals still match the order.
      const last = qtys[qtys.length - 1];
      const moved = assigned >= item.qty ? Math.floor(Number(last.value) / 2) : item.qty - assigned;
      if (assigned >= item.qty) last.value = Number(last.value) - moved;
      const tmp = document.createElement('div');
      render(tmp, batchRow(item, owner, Math.max(1, moved)));
      f.querySelector('.rcv-batches').append(tmp.firstElementChild);
      f.querySelector('.rcv-batch:last-child [name=batchNo]').focus();
      update();
    }
    const rm = e.target.closest('[data-rm-batch]');
    if (rm) { rm.closest('.rcv-batch').remove(); update(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rcv-error', box);
    err.textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
    const bad = [...form.querySelectorAll('input[required]')].filter((i) => !i.value.trim());
    if (bad.length) { bad.forEach((i) => i.setAttribute('aria-invalid', 'true')); bad[0].focus(); err.textContent = 'Fill in the batch number and expiry for every batch.'; return; }
    const lines = [...form.querySelectorAll('.rcv-item')].flatMap((f) => [...f.querySelectorAll('.rcv-batch')].map((r) => ({
      poItemId: Number(f.dataset.item), batchNo: r.querySelector('[name=batchNo]').value.trim(), expiry: r.querySelector('[name=expiry]').value,
      qty: Number(r.querySelector('[name=qty]').value), unitCost: r.querySelector('[name=unitCost]')?.value })));
    const ordered = po.items.reduce((s, i) => s + i.qty, 0);
    const got = lines.reduce((s, l) => s + l.qty, 0);
    if (got < ordered && !(await confirmDialog({ title: 'Short delivery?', message: `You're receiving ${got} of ${ordered} units ordered. The order will be closed as received; order the rest separately if needed.`, confirmLabel: 'Receive anyway' }))) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.classList.add('loading');
    try {
      const res = await api(`/purchase-orders/${po.id}/receive`, { method: 'POST', body: { lines } });
      toast(`Received ${plural(res.batches.length, 'batch', 'batches')} into stock`);
      stockChanged();
      reload();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false; btn.classList.remove('loading');
    }
  });
  update();
}
