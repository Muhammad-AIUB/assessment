# PharmaStock

Stock management for a small pharmacy that tracks **batches and expiry dates**, sells **FEFO**
(first-expiry-first-out), and uses a **hand-written demand forecast** to recommend how much to buy.

```
Purchase Order → Batch (with expiry) → Sale (FEFO) → sales history → Forecast → Reorder suggestion → new Purchase Order
```

> ⚠️ **All sales history in this project is synthetic.** The seed script generates it. See [Data](#data).

---

## Quick start

Requirements: Node 20+, Docker.

```bash
cp .env.example .env
npm install
npm run db:up        # PostgreSQL 16 on localhost:5433 (creates pharmastock + pharmastock_test)
npm run setup        # create schema + seed ~9 months of synthetic history
npm start            # http://localhost:3000
```

Demo logins (seed data only): **owner / owner123** · **staff / staff123**

| Command | What it does |
|---|---|
| `npm test` | all tests (unit + PostgreSQL integration; needs `npm run db:up`) |
| `npm run test:unit` | pure FEFO + forecast tests, no database |
| `npm run backtest` | prints the model-vs-baseline table for every product |
| `npm run backtest:csv -- file.csv --item=item --qty=sales` | same backtest on any daily sales CSV |
| `npm run seed` | **drops everything** and reseeds |

Set `APP_TODAY=2026-10-18` in `.env` to freeze "today" (reproducible demo/backtest numbers).

---

## Roles

| | Owner | Staff |
|---|---|---|
| Sell | ✅ | ✅ |
| Receive goods (batch no, expiry) | ✅ (can override purchase price) | ✅ (price taken from the PO, never shown) |
| See purchase prices | ✅ | ❌ — stripped server-side from every response |
| Create / place / cancel POs | ✅ | ❌ |
| Write off batches | ✅ | ❌ |
| Forecast, reorder, model report, stock history | ✅ | ❌ |
| Manage suppliers, products, staff | ✅ | ❌ |

Permissions are enforced in the API (`src/routes/api.js`), not just hidden in the UI.

## The flow

1. **Setup** — owner adds suppliers and products (lead time in days, minimum level, review period). Seed data is pre-loaded.
2. **Purchase** — `Draft → Ordered → Received` (or `Cancelled` from Draft/Ordered). A PO can't be placed while any item lacks a unit cost. On receive, every line gets a batch no, expiry and cost and becomes **its own batch**. One item can be split across several batch numbers. Over-delivery and already-expired batches are rejected. The pack shows expiry as `MM/YYYY`, so it is stored as **the last day of that month** (`2027-02` → `2027-02-28`, `02/2028` → `2028-02-29`).
3. **Sale** — staff enter product + qty. The system takes stock from the batch that expires first, across several batches if needed, and skips expired ones. The whole sale runs in **one transaction with `SELECT … FOR UPDATE`** on the batch rows. Products are locked in id order, so two multi-item sales can't deadlock. If stock runs short, the sale returns HTTP 409 with:
   `Paracetamol 500mg (strip): বিক্রয়যোগ্য stock 5 (3টা মেয়াদোত্তীর্ণ বাদ)`
4. **Expiry watch** — a batch goes `Active → Near Expiry (≤ 60 days) → Expired → Written Off`. Only `written_off` is stored. The other states come from `expiry_date` vs today, so a status can never go stale because a cron job didn't run. Expired stock can't be sold. The owner writes it off with a required reason, and that goes into the append-only `stock_movements` history.
5. **Forecast & reorder** — the owner picks a product and sees a chart of the last 90 days plus 14 forecast days, the full reorder calculation, and a **"Draft PO বানাও"** button that creates a Draft PO straight from the recommendation.
6. **Expiry risk** — the forecast is "played forward" day by day, selling FEFO. Units still on a batch when it expires are flagged, with a suggestion: *discount*, or *return to supplier* when the batch is ≥ 90 days from expiry and at least half of it won't sell.
7. **Model report** — the walk-forward backtest (model vs baselines) is shown inside the app at `#/model`.

---

## The forecasting model (`src/forecast/`, pure functions, no ML library)

**Input:** daily units sold per product, with missing days filled as 0, up to *yesterday* (today is incomplete).
**Output:** daily demand for the next 7/14 days, plus a reorder quantity.

### Model — `model.js`
A simplified Holt-Winters model: exponentially smoothed **level** × **day-of-week seasonal index** (no trend term).

```
forecast(t+h)  = level_t × season[weekday(t+h)]
level_t        = α · (y_t / season[d]) + (1 − α) · level_{t−1}
season[d]      = γ · (y_t / level_t)   + (1 − γ) · season[d]
```

- **Initialisation:** level = mean of the first 28 days. The weekday indices are each weekday's mean ÷ the overall mean over the training window. At the end, the indices are rescaled to average 1, so `level` means "average units per day".
- **Choosing α and γ:** grid search, α ∈ {0.05…0.7}, γ ∈ {0…0.3}. The score is MAE on the last **28 days** of history, measured the way the model is actually used: from 4 weekly origins, each forecasting 7 days ahead. If two settings tie, the smoother one wins.
- **Fewer than 28 days of history:** falls back to the plain mean and shows **"Low confidence"** (see *Montelukast* in the seed data).

### Evaluation — `backtest.js`, `metrics.js`
**Walk-forward backtest:** train on every day before an origin, forecast the next 7 days, move the origin forward 7 days, and repeat. The last 26 windows are used, starting after at least 56 days of training. α and γ are **re-tuned at every origin using only past data**, so nothing leaks from the future (there is a test for this).

Two baselines:
- **seasonal naive:** "same weekday last week"
- **mean-7:** "average of the last 7 days"

Metrics:
- **MAE**
- **WAPE** = Σ|error| / Σ actual. It still works when many days have zero sales.
- **MAPE**, computed only on days with sales > 0 (you can't divide by zero). The report says how many days were counted. MAPE alone would be misleading for intermittent items, which is why WAPE is the headline number.

### Results on the seeded data (as of 2026-10-18)

**The model beats both baselines on 12 of 17 products** (the 18th has too little history to score).

| Pooled over all products | MAE | WAPE |
|---|---|---|
| **Model** | **3.38** | **35.9 %** |
| Seasonal naive | 4.49 | 47.6 % |
| Mean of last 7 days | 3.59 | 38.1 % |

**Where it wins:** every fast mover (Paracetamol, Napa, Omeprazole, ORS) and almost every medium mover. These products have a weekly pattern that the weekday index picks up.

**Where it does NOT win, and why:**
- **Slow / intermittent items** (eye drops, thermometer, bandage, zinc syrup; 30–75 % zero days): a weekday index can't be learned from mostly zeros, so the flat 7-day mean does as well or better. The next step would be Croston/SBA for these items.
- **N95 mask** (random multi-day spikes): spikes are unpredictable from history by construction, and any smoother lags behind them.

The forecast page shows a warning on any product where the model lost its backtest.

The first version used only 4 weeks to set the weekday indices and tuned on a single 14-day block. It beat the baselines on just **5/17** products, roughly tied with mean-7. Estimating the indices from the full training window and tuning on rolling 7-day origins fixed that. Both versions are honest; the second one is better.

### Reorder — `reorder.js`
```
order        = forecast demand over (lead time + review period)
             + safety stock
             − usable stock (expired & written-off excluded)
             − quantity on Ordered (in-transit) POs
safety stock = z × σ × √(lead time)       z = 1.65  (≈ 95 % service level)
```
**σ is the standard deviation of the daily forecast error measured in the backtest**, so the evaluation feeds straight into the business decision. A product that forecasts badly automatically gets more safety stock. With no backtest available (short history), σ falls back to the series' own standard deviation. The result is rounded up, never negative, and never leaves the stock position below the owner's minimum level.

*Note:* the spec asks for √(lead time). Textbook periodic-review policies often use √(lead + review). That's a one-line change in `reorder.js` if you prefer the more conservative version.

---

## Data

There is no real sales history, so `scripts/seed.js` **simulates** one (fixed RNG seed, so it's deterministic):

- **18 products, 270 days**, in 4 behaviour types:
  - fast movers with a Bangladesh-style weekly pattern (quiet Friday, busy Thursday/Saturday)
  - medium movers
  - slow / intermittent items (Poisson mean < 1.2 per day)
  - spiky items (≈ 3 % chance per day of a 2–6-day spike at 2.5–5× demand)
  - plus one **new product with only 20 days of history**, to show the low-confidence path
- Demand gets lognormal noise on top of Poisson sampling. The model would trivially fit a clean pattern, so the noise and spikes are there on purpose.
- The shop itself is simulated too: weekly reviews, POs that arrive after the supplier's lead time, batches with realistic shelf life, and **FEFO sales using the same `allocateFefo()` the live app uses**. Demand that can't be met is a lost sale, as in a real shop.
- Demo situations on "today":
  - an expired Paracetamol batch still on the shelf
  - near-expiry eye drops and cough syrup
  - a slow-moving thermometer batch with surplus stock
  - an Ordered PO in transit and a Draft PO

**Public dataset:** `npm run backtest:csv` runs the same backtest on any daily CSV. For example, Kaggle's *Store Item Demand Forecasting Challenge* `train.csv` with `--item=item --qty=sales`. No external dataset is bundled; check the dataset's licence before using it.

## Limitations

- The data is synthetic. The results show the method works on *plausible* data, not that it is accurate for a real shop.
- The model is weak on slow and intermittent items, and the report says so.
- Not modelled: promotions, yearly seasons (monsoon diarrhoea → ORS, winter flu), sudden demand jumps, and trend.
- The model is only evaluated 7 days ahead. The expiry-risk projection months out is a rough estimate.
- When stock runs out, the sales history records what was sold, not what was asked for. Long stock-outs bias the forecast down.
- Out of scope: partial receipts across several deliveries (a PO is received once, possibly short), returns/refunds, price history, and multiple branches.

---

## Architecture

```
src/
  domain/fefo.js          pure FEFO allocation + shortage message     ← shared by sales, seed, risk
  domain/batchStatus.js   derived lifecycle status
  forecast/               pure: model, baselines, metrics, backtest, reorder, risk
  services/               DB + transactions: sales, purchasing, inventory, forecasting, auth
  routes/api.js           REST API, auth, role checks, cost stripping for staff
  dates.js                calendar-date maths in UTC; "today" is the shop's date (APP_TZ)
db/schema.sql             PostgreSQL schema (CHECK constraints guard qty ≥ 0 at the DB level too)
public/                   no-build vanilla JS SPA + Chart.js
scripts/                  migrate, seed, backtest reports
test/                     *.unit.test.js (pure) and sales.db.test.js (real PostgreSQL)
```

Design decisions:
- **PostgreSQL rather than SQLite**, because the spec needs row-level locks (`FOR UPDATE`) and SQLite has none.
- **The business logic is pure functions** (FEFO, forecast, reorder, risk). The services only load rows, call them, and write the results. That's what makes the critical parts testable without a database, and easy to explain line by line in a review.
- **Dates are `YYYY-MM-DD` strings** with UTC arithmetic. pg's `DATE` → JS `Date` conversion is turned off, so expiry never shifts by a day because of the timezone.
- **Append-only `stock_movements`**: every receive, sale and write-off is a signed row, so stock can always be audited.

## Tests (`npm test` → 36 tests)

**Critical: FEFO selling** (`fefo.unit.test.js`, `sales.db.test.js`)
- takes the earliest expiry first, spans several batches, skips expired stock, and a batch is still sellable *on* its expiry day
- a shortage gives the exact Bengali message, and the whole multi-item sale rolls back with nothing written
- **concurrency:** two simultaneous sales of 6 against 10 units → exactly one succeeds and 4 remain; 15 simultaneous single-unit sales against 8 units → exactly 8 sold
- month-end expiry parsing (including a leap year), status lifecycle, PO transitions, receive validation, write-off audit

**Critical: forecast measurement** (`forecast.unit.test.js`)
- MAE, WAPE, and MAPE that skips zero days
- both baselines
- low-confidence fallback, recovering the weekday pattern, never forecasting below zero
- the backtest beats the baselines on noisy seasonal data, and **doesn't leak future data**
- the exact reorder formula, the minimum-level floor, and the expiry-risk simulation
- end to end: history → forecast → reorder 88 → Draft PO
