import { api, html, isOwner, n2, fmtDate, plural } from '../core.js';
import { badge, expiryMeter, openDialog, toast, icon } from '../ui.js';

/** Tell the shell that stock changed (refreshes the expiry badge in the nav). */
export const stockChanged = () => window.dispatchEvent(new Event('stock-changed'));

const batchHead = ({ showProduct, writeOff }) => html`<tr>${showProduct ? html`<th>Product</th>` : ''}<th>Batch</th><th>Expiry</th><th class="num">On hand</th>
  ${isOwner() ? html`<th class="num">Unit cost</th>` : ''}<th>Status</th>${writeOff ? html`<th><span class="sr-only">Actions</span></th>` : ''}</tr>`;

const batchRow = (b, { showProduct, writeOff, compact }) => html`<tr>
  ${showProduct ? html`<td class="cell-strong">${b.product_name}</td>` : ''}
  <td><span class="batch-no">${b.batch_no}</span>${compact ? '' : html`<span class="sub">received ${fmtDate(b.received_at)}</span>`}</td>
  <td><div class="cell-strong">${fmtDate(b.expiry_date)}</div>${b.status === 'written_off' || b.status === 'depleted' ? '' : expiryMeter(b.days_left)}</td>
  <td class="num cell-strong">${b.qty_on_hand}</td>
  ${isOwner() ? html`<td class="num">${n2(b.unit_cost)}</td>` : ''}
  <td>${badge(b.status)}</td>
  ${writeOff ? html`<td class="num">${b.status === 'written_off' || b.qty_on_hand === 0 ? ''
    : html`<button class="btn btn-sm ${b.status === 'expired' ? 'btn-danger' : ''} ${compact ? 'btn-icon-only' : ''}" data-writeoff="${b.id}"
        ${compact ? html`aria-label="Write off batch ${b.batch_no}" title="Write off"` : ''}>${icon('trash')}${compact ? '' : 'Write off'}</button>`}</td>` : ''}
</tr>`;

export function batchTable(batches, opts = {}) {
  return html`<div class="table-wrap"><table><thead>${batchHead(opts)}</thead><tbody>${batches.map((b) => batchRow(b, opts))}</tbody></table></div>`;
}

/** One table, several labelled groups: [{ label (html), batches }]. */
export function groupedBatchTable(groups, opts = {}) {
  const cols = 4 + (opts.showProduct ? 1 : 0) + (isOwner() ? 1 : 0) + (opts.writeOff ? 1 : 0);
  return html`<div class="table-wrap"><table><thead>${batchHead(opts)}</thead>${groups.map((g) => html`<tbody>
    <tr class="group-row"><th colspan="${cols}" scope="rowgroup">${g.label}</th></tr>${g.batches.map((b) => batchRow(b, opts))}</tbody>`)}</table></div>`;
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
