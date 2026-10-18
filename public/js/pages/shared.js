import { api, html, isOwner, n2, fmtDate, plural } from '../core.js';
import { badge, expiryMeter, openDialog, toast, icon } from '../ui.js';

/** Tell the shell that stock changed (refreshes the expiry badge in the nav). */
export const stockChanged = () => window.dispatchEvent(new Event('stock-changed'));

export function batchTable(batches, { showProduct = false, writeOff = false } = {}) {
  const owner = isOwner();
  return html`<div class="table-wrap"><table>
    <thead><tr>${showProduct ? html`<th>Product</th>` : ''}<th>Batch</th><th>Expiry</th><th class="num">On hand</th>
      ${owner ? html`<th class="num">Unit cost</th>` : ''}<th>Status</th>${writeOff ? html`<th><span class="sr-only">Actions</span></th>` : ''}</tr></thead>
    <tbody>${batches.map((b) => html`<tr>
      ${showProduct ? html`<td class="cell-strong">${b.product_name}</td>` : ''}
      <td><span class="batch-no">${b.batch_no}</span><span class="sub">received ${fmtDate(b.received_at)}</span></td>
      <td><div class="cell-strong">${fmtDate(b.expiry_date)}</div>${b.status === 'written_off' || b.status === 'depleted' ? '' : expiryMeter(b.days_left)}</td>
      <td class="num cell-strong">${b.qty_on_hand}</td>
      ${owner ? html`<td class="num">${n2(b.unit_cost)}</td>` : ''}
      <td>${badge(b.status)}</td>
      ${writeOff ? html`<td class="num">${b.status === 'written_off' || b.qty_on_hand === 0 ? ''
        : html`<button class="btn btn-sm ${b.status === 'expired' ? 'btn-danger' : ''}" data-writeoff="${b.id}">${icon('trash')}Write off</button>`}</td>` : ''}
    </tr>`)}</tbody></table></div>`;
}

/** Wire every [data-writeoff] button inside root to the write-off dialog. */
export function bindWriteOff(root, batches, onDone) {
  root.querySelectorAll('[data-writeoff]').forEach((btn) => btn.addEventListener('click', async () => {
    const b = batches.find((x) => x.id === Number(btn.dataset.writeoff));
    const reasons = b.status === 'expired' ? ['Expired', 'Damaged', 'Recalled by manufacturer'] : ['Damaged', 'Recalled by manufacturer', 'Expired', 'Lost / stolen'];
    const done = await openDialog({
      title: 'Write off batch',
      tone: 'danger',
      submitLabel: `Write off ${plural(b.qty_on_hand, 'unit')}`,
      body: html`<p>This removes <b>${plural(b.qty_on_hand, 'unit')}</b> of <b>${b.product_name}</b> (batch <span class="batch-no">${b.batch_no}</span>, expires ${fmtDate(b.expiry_date)}) from stock. It is recorded in stock history and can't be undone.</p>
        <label class="field"><span>Reason</span>
          <select name="preset">${reasons.map((r) => html`<option>${r}</option>`)}<option value="">Other…</option></select></label>
        <label class="field"><span>Note <small>(optional, or required for “Other”)</small></span><input name="note" placeholder="e.g. found under shelf, packaging torn"></label>`,
      onSubmit: async (fd) => {
        const reason = [fd.get('preset'), fd.get('note')?.trim()].filter(Boolean).join(' — ');
        if (reason.length < 3) throw new Error('Please describe the reason.');
        return api(`/batches/${b.id}/write-off`, { method: 'POST', body: { reason } });
      },
    });
    if (done) { toast(`Wrote off ${plural(done.writtenOffQty, 'unit')} of ${b.product_name}`); stockChanged(); onDone?.(); }
  }));
}
