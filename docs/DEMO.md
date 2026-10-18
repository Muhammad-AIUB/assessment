# Live demo script (≈ 12 minutes)

Before you start, reset to a known state:

```bash
npm run db:up && npm run seed && npm start
```

Keep two browser windows open: **owner** (normal window) and **staff** (private window). The demo logins are `owner/owner123` and `staff/staff123`; the buttons on the login screen fill them in.

| # | Show | Say | Proves |
|---|---|---|---|
| 1 | Owner **Dashboard** | "The *Needs attention* list is the owner's to-do list, most urgent first. Each item has the one button that fixes it." | Problem understanding, UX |
| 2 | Click **Review & write off** → Paracetamol drawer | "Batches are listed in FEFO order. This one expired 12 days ago and still has 3 units on the shelf." | Batch + expiry model |
| 3 | Staff window → **Sell** → type `para`, Enter, set qty **500** | Red line: "Only N sellable (3 expired not counted)". Tap **Set to N**, then back to 3. | Expired excluded, validation |
| 4 | Add **eye drops**, qty **20**, Ctrl+Enter | The receipt shows **two batches**, the earlier expiry first. | FEFO across batches |
| 5 | Terminal: `npm test` (or show the test names) | "15 simultaneous sales of 1 unit against 8 in stock: exactly 8 succeed. Two clerks selling 6 of 10: one wins, one gets the Bengali error." | Row locking, atomicity |
| 6 | Owner → **Purchase orders → To receive** → open one → **Receive** | Split into 2 batches, choose an expiry month: "Valid until 28 Feb 2027 · short-dated". | PO lifecycle, month-end expiry |
| 7 | Owner → **Stock history** | The receipt, sale and write-off rows, with who and why. | Audit trail |
| 8 | **Forecast & reorder** (planner) | "Products ranked by when they run out. Tick, adjust, **one draft PO per supplier**." | Forecast → business logic |
| 9 | Click **Cough syrup** | Chart with the likely-range band, "Why 0?" line by line, the expiry-risk table, the weekday pattern. | Explainability |
| 10 | **Model report** | "The model beats both baselines on 12 of 17 products. It does **not** win on slow or intermittent items, and here's why." | Honest evaluation |
| 11 | Staff window: go to `#/forecast` | Redirects to the dashboard; the API itself returns 403. Staff never see a cost. | Security |
| 12 | `src/forecast/model.js` | Walk through `fit()` line by line (next section). | You built it yourself |

## Walking through the model (`src/forecast/model.js`)

1. `initialState`: level = the mean of the first 28 days. The weekday index = that weekday's mean ÷ the overall mean.
2. `fit`, for each day:
   * de-seasonalise: `y / season[dow]`
   * `level = α·that + (1−α)·level`
   * `season[dow] = γ·(y/level) + (1−γ)·season[dow]`
   * at the end, rescale the indices to average 1
3. `predict`: `level × season[dow of each future day]`.
4. `selectParams`: grid-search α ∈ {0.05…0.7} and γ ∈ {0…0.3} on the last 28 days, forecasting 7 days ahead from 4 origins. Lowest MAE wins.
5. `forecast`: under 28 days of history → plain mean, flagged "low confidence".
6. `backtest.js` `walkForward`: train on days before t → forecast t…t+6 → step 7 → repeat. α and γ are re-tuned each time using only the past (there is a test proving there's no leakage).
7. `reorder.js`:
   * order = demand over (lead + review) + z·σ·√lead − usable − on order
   * σ comes from step 6, and z = 1.65 gives 95% service

## Likely review questions

**Why PostgreSQL and not SQLite or Mongo?**
The sale needs row-level locks (`SELECT … FOR UPDATE`). SQLite locks the whole database, and Mongo would need hand-written multi-document transactions.

**What stops two people selling the same unit?**
The sale is one transaction. The batch rows are locked `FOR UPDATE`, so the second transaction waits, then re-reads the reduced quantity. Products are locked in id order, so two multi-item sales can't deadlock. `test/sales.db.test.js` covers this.

**Why not store `near_expiry` / `expired` as a status?**
A stored status goes stale unless a job updates it. A derived status is always correct for today. Only *written off* is a human action, so only that is stored.

**Why does MAPE ignore zero days?**
Dividing by an actual value of 0 is undefined, so MAPE has nothing to say about a day with no sales. That's why WAPE (Σ|error| / Σ actual) is the headline metric, and why the report states how many days MAPE used.

**Why does the model lose on slow movers?**
With 30–75% zero days there is no weekday pattern to learn. A flat 7-day mean is as good, or better. The fix would be Croston/SBA for intermittent demand. The forecast page warns when the model lost its backtest for that product.

**Isn't evaluating on your own synthetic data cheating?**
Partly. That's why the seed adds lognormal noise, Poisson sampling and random spikes, and why the same backtest was also run on real pharmacy data (README → *Public dataset*).

**Did you test it on real data?**
Yes, on a public pharmacy POS dataset (Indonesia, 2015, CC BY 4.0). It exposed a real bug: on near-closed weekdays the multiplicative weekday index went to about 0.01, and dividing by it blew the forecast up. I fixed it by also fitting an additive form and choosing per product on validation data. The before/after numbers are in the README. Synthetic data alone would never have shown this.

**How do staff receive goods if they can't see prices?**
The owner sets the unit cost when ordering. On receive, the server uses the PO price for staff and ignores any price they send (there's a test for this).

**How would this scale?**
Run several app instances behind a load balancer. Move the login throttle and the model-report cache to Redis. Add a background job that precomputes the reorder plan nightly. Partition `stock_movements` by month.

**What would you do next?**
1. Croston/SBA for intermittent items
2. Partial receipts across several deliveries
3. Customer returns
4. Annual seasonality once there is more than a year of data
5. A background job that precomputes the reorder plan
