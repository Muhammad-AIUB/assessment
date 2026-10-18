// Dashboard: what happened today, and a prioritised list of what needs doing.
import { api, html, render, isOwner, fmtDate, money, num, plural, state } from '../core.js';
import { pageHeader, icon, barSpark } from '../ui.js';

const DAY = 86_400_000;
const dueDate = (o) => new Date(Date.parse(`${o.ordered_at.slice(0, 10)}T00:00:00Z`) + o.lead_time_days * DAY).toISOString().slice(0, 10);

export async function render_(el) {
  const owner = isOwner();
  const [products, alerts, orders, summary] = await Promise.all([api('/products'), api('/alerts/expiry'), api('/purchase-orders'), api('/summary')]);
  const expired = alerts.filter((a) => a.status === 'expired');
  const near = alerts.filter((a) => a.status === 'near_expiry');
  const below = products.filter((p) => p.below_min);
  const out = products.filter((p) => p.usable === 0);
  const ordered = orders.filter((o) => o.status === 'ordered');
  const overdue = ordered.filter((o) => dueDate(o) < state.today);
  const dueNow = ordered.filter((o) => dueDate(o) === state.today);
  const drafts = orders.filter((o) => o.status === 'draft');
  const units = (list) => list.reduce((s, b) => s + b.qty_on_hand, 0);

  // Most urgent first. Each task says what, why, and offers the one action that fixes it.
  const tasks = [
    expired.length && { tone: 'bad', icon: 'alert', title: `${plural(expired.length, 'expired batch', 'expired batches')} still on the shelf`,
      text: `${plural(units(expired), 'unit')} can't be sold. ${owner ? 'Write them off so stock figures stay true.' : 'Set them aside and tell the owner.'}`,
      href: '#/stock/expired', action: owner ? 'Review & write off' : 'See which' },
    out.length && { tone: 'bad', icon: 'box', title: `${plural(out.length, 'product')} out of stock`, text: out.slice(0, 3).map((p) => p.name).join(', ') + (out.length > 3 ? '…' : ''),
      href: owner ? `#/forecast/${out[0].id}` : '#/stock/out', action: owner ? 'Plan reorder' : 'See which' },
    overdue.length && { tone: 'warn', icon: 'truck', title: `${plural(overdue.length, 'order')} overdue from suppliers`, text: overdue.map((o) => `#${o.id} ${o.supplier_name}`).slice(0, 2).join(', '),
      href: '#/purchase', action: 'Check orders' },
    dueNow.length && { tone: 'info', icon: 'truck', title: `${plural(dueNow.length, 'delivery', 'deliveries')} due today`, text: 'Receive the goods when they arrive — batch number and expiry from each pack.',
      href: `#/purchase/${dueNow[0].id}`, action: 'Open order' },
    below.length && { tone: 'warn', icon: 'trend', title: `${plural(below.length, 'product')} below minimum level`, text: below.slice(0, 3).map((p) => `${p.name} (${p.usable}/${p.min_level})`).join(', '),
      href: owner ? `#/forecast/${below[0].id}` : '#/stock/low', action: owner ? 'Plan reorder' : 'See which' },
    near.length && { tone: 'warn', icon: 'clock', title: `${plural(near.length, 'batch', 'batches')} expire${near.length === 1 ? 's' : ''} within 60 days`, text: `${plural(units(near), 'unit')} — sell these first${owner ? ', or discount / return what won’t sell in time' : ''}.`,
      href: '#/stock/expiring', action: 'See batches' },
    owner && drafts.length && { tone: 'info', icon: 'receipt', title: `${plural(drafts.length, 'draft order')} not placed yet`, text: drafts.map((o) => `#${o.id} ${o.supplier_name}`).slice(0, 2).join(', '),
      href: `#/purchase/${drafts[0].id}`, action: 'Review draft' },
  ].filter(Boolean);

  const t = summary.today;
  const trend = summary.trend;
  const name = state.user.name.replace(/\s*\(.*\)/, '');
  render(el, html`
    ${pageHeader(`Good ${greeting()}, ${name}`, `${fmtDate(state.today)} · ${tasks.length ? `${plural(tasks.length, 'thing')} need${tasks.length === 1 ? 's' : ''} attention` : 'all clear'}`,
      owner ? html`<a class="btn btn-primary" href="#/sell">${icon('cart')}New sale</a>` : '')}
    ${owner ? '' : html`<a class="cta" href="#/sell">${icon('cart', 'icon-xl')}<div><h2>Start selling</h2><p>Search a medicine, add it, done. Expired stock is blocked automatically.</p></div>${icon('arrow', 'arrow')}</a>`}
    <section class="card today">
      <div><div class="stat-top">Today so far</div>
        <div class="today-figs"><div><b>${money(t.revenue)}</b><span>sales value</span></div><div><b>${num(t.sales)}</b><span>${t.sales === 1 ? 'sale' : 'sales'}</span></div><div><b>${num(t.units)}</b><span>units sold</span></div></div></div>
      <div>${barSpark(trend.map((d) => d.revenue), { labels: trend.map((d) => fmtDate(d.day)), format: money })}
        <div class="spark-axis"><span>${fmtDate(trend[0].day)}</span><span>Last 14 days · sales value</span><span>Today</span></div></div>
    </section>
    <section class="card flush"><div class="card-head"><div><h2>Needs attention</h2><p>Most urgent first.</p></div></div>
      ${tasks.length ? html`<ul class="tasks">${tasks.map((k) => html`<li class="task task-${k.tone}"><span class="task-icon">${icon(k.icon)}</span>
        <div><b>${k.title}</b><p>${k.text}</p></div><a class="btn btn-sm ${k.tone === 'bad' ? 'btn-primary' : ''}" href="${k.href}">${k.action}</a></li>`)}</ul>`
        : html`<div class="all-clear">${icon('check', 'icon-xl')}<div><b>All clear.</b><p class="muted">No expired stock, nothing below minimum, no late deliveries.</p></div></div>`}
    </section>
    <div class="grid cols-4">
      ${stat('Usable units', num(products.reduce((s, p) => s + p.usable, 0)), `${plural(products.length, 'product')}`, 'box', 'info', '#/stock')}
      ${stat('Expired on shelf', expired.length, 'batches', 'alert', expired.length ? 'bad' : 'ok', '#/stock/expired')}
      ${stat('Expiring ≤ 60 days', near.length, `${num(units(near))} units`, 'clock', near.length ? 'warn' : 'ok', '#/stock/expiring')}
      ${stat('On the way', ordered.length, overdue.length ? `${overdue.length} overdue` : 'orders', 'truck', overdue.length ? 'warn' : 'info', '#/purchase')}
    </div>`);
}
export { render_ as render };

const stat = (label, value, foot, ic, tone, href) =>
  html`<a class="card stat tone-${tone}" href="${href}"><div class="stat-top">${label} ${icon(ic)}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></a>`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
