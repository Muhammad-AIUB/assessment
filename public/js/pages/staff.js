import { api, html, render, state, $ } from '../core.js';
import { pageHeader, icon, badge, toast, openDialog, confirmDialog } from '../ui.js';

export async function render_(el) {
  const users = await api('/users');
  render(el, html`
    ${pageHeader('Staff', 'Staff can sell and receive goods. They never see purchase prices, forecasts or reports.',
      html`<button class="btn btn-primary" id="add-user">${icon('plus')}Add person</button>`)}
    <section class="card flush"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr><td class="cell-strong">${u.name}${u.id === state.user.id ? html` <span class="muted small">(you)</span>` : ''}</td>
        <td class="mono">${u.username}</td><td>${badge(u.role)}</td><td>${u.active ? badge('active', 'Active') : badge('written_off', 'Disabled')}</td>
        <td class="num">${u.id === state.user.id ? '' : html`<button class="btn btn-sm" data-toggle="${u.id}" data-active="${u.active ? '0' : '1'}">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`)}</tbody>
    </table></div></section>`);

  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.find((x) => x.id === Number(b.dataset.toggle));
    const enable = b.dataset.active === '1';
    if (!enable && !(await confirmDialog({ title: `Disable ${u.name}?`, message: 'They will be logged out and cannot log in until you enable them again.', confirmLabel: 'Disable', tone: 'danger' }))) return;
    try { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: enable } }); toast(`${u.name} ${enable ? 'enabled' : 'disabled'}`); render_(el); }
    catch (e) { toast(e.message, 'bad'); }
  }));
  $('#add-user', el).addEventListener('click', async () => {
    const ok = await openDialog({
      title: 'Add person', submitLabel: 'Add',
      body: html`<label class="field"><span>Full name</span><input name="name" required></label><div class="form-grid">
        <label class="field"><span>Username</span><input name="username" autocapitalize="none" required></label>
        <label class="field"><span>Role</span><select name="role"><option value="staff">Staff</option><option value="owner">Owner</option></select></label></div>
        <label class="field"><span>Temporary password</span><input name="password" type="text" minlength="6" required><small>At least 6 characters. Share it with them in person.</small></label>`,
      onSubmit: (fd) => api('/users', { method: 'POST', body: Object.fromEntries(fd) }),
    });
    if (ok) { toast('Person added'); render_(el); }
  });
}
export { render_ as render };
