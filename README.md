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
npm run setup        # apply migrations + seed ~9 months of synthetic history
npm start            # http://localhost:3000
```

Demo logins (seed data only): **owner / owner123** · **staff / staff123**

| Command | What it does |
|---|---|
| `npm test` | all 51 tests: unit, PostgreSQL integration and HTTP end-to-end (needs `npm run db:up`) |
| `npm run lint` | ESLint (also runs in CI on every push: `.github/workflows/ci.yml`) |
| `npm run migrate` | apply pending migrations from `db/migrations/` (safe to repeat) |
| `npm run test:unit` | pure FEFO + forecast tests, no database |
| `npm run backtest` | prints the model-vs-baseline table for every product |
| `npm run backtest:csv -- file.csv --item=item --qty=sales` | same backtest on any daily sales CSV |
| `npm run seed` · `npm run db:reset` | **drop everything** and reseed / rebuild (development only) |

Set `APP_TODAY=2026-10-18` in `.env` to freeze "today" (reproducible demo/backtest numbers).

---

## Using it

| Screen | Built for |
|---|---|
| **Dashboard** | Today's takings and a 14-day trend, plus a *Needs attention* list, most urgent first, where each item has the one button that fixes it |
| **Sell** | Counter speed. Type to search (`/` focuses it), `Enter` adds, a +/− stepper on each line, `Ctrl+Enter` completes. Each line shows which batch it will come from and blocks quantities above sellable stock, with a one-tap "Set to N". A receipt shows the batches used. On phones: two-column tiles and a floating cart bar |
| **Stock & expiry** | Filter chips (below minimum, out of stock, expiring, expired), search, sortable columns, days of cover, an expiry meter on every batch, and a side drawer per product. A second view lists every batch grouped by expiry month |
| **Purchase orders** | Status tabs (staff land on *To receive*), due/overdue hints, an order page with a timeline. The receive form can split a line into several batches, shows the "valid until" date for each expiry, and warns on short-dated stock and short deliveries |
| **Forecast & reorder** | A **reorder planner** ranks every product by when it runs out; tick and adjust, and **one click creates draft orders, one per supplier**. The product page says it plainly ("Buy 120 strips by Mon 20 Oct"), shows the chart with a likely-range band, and explains the calculation line by line |
| **Model report** | Backtest results in the app |

Works on phones (bottom tab bar, slide-out menu) and in dark mode. It uses native `<dialog>`s, keeps keyboard focus visible, has a skip link, and moves focus to the new page on navigation.

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
A simplified Holt-Winters model: an exponentially smoothed **level** plus a **day-of-week effect** (no trend term). The weekday effect comes in two forms, and each product gets the one that validates better:

```
multiplicative:  forecast = level × season[d]     level = α·(y / season[d]) + (1−α)·level     season[d] = γ·(y / level) + (1−γ)·season[d]
additive:        forecast = level + season[d]     level = α·(y − season[d]) + (1−α)·level     season[d] = γ·(y − level) + (1−γ)·season[d]
```

Why two forms: on **real** pharmacy data some weekdays are almost closed, giving a weekday index of about 0.01. The multiplicative form divides by that index, so one ordinary sale on such a day becomes 100× the level and the forecast explodes. The additive form has no division. Multiplicative is not allowed when any weekday index is below 0.2 (see [Public dataset](#public-dataset-real-pharmacy-sales)).

- **Initialisation:** level = mean of the first 28 days. The weekday indices are each weekday's mean ÷ the overall mean over the training window. At the end, the indices are rescaled to average 1, so `level` means "average units per day".
- **Choosing the form, α and γ:** grid search over form ∈ {multiplicative, additive}, α ∈ {0.05…0.7}, γ ∈ {0…0.3}. The score is MAE on the last **28 days** of history, measured the way the model is actually used: from 4 weekly origins, each forecasting 7 days ahead. If two settings tie, the smoother one wins.
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

### Results on the seeded data (`APP_TODAY=2026-10-18 npm run backtest`)

**The model beats both baselines on 11 of 17 products** (the 18th has too little history to score).

| Pooled over all products | MAE | WAPE |
|---|---|---|
| **Model** | **3.38** | **35.8 %** |
| Seasonal naive | 4.49 | 47.6 % |
| Mean of last 7 days | 3.59 | 38.1 % |

**Where it wins:** every fast mover (Paracetamol, Napa, Omeprazole, ORS) and almost every medium mover. These products have a weekly pattern that the weekday index picks up.

**Where it does NOT win, and why** (on this synthetic data; on real data see below):
- **Slow / intermittent items** (eye drops, thermometer, bandage, zinc syrup; 30–75 % zero days): a weekday index can't be learned from mostly zeros, so the flat 7-day mean does as well or better. The next step would be Croston/SBA for these items.
- **N95 mask** (random multi-day spikes): spikes are unpredictable from history by construction, and any smoother lags behind them.

The forecast page shows a warning on any product where the model lost its backtest.

How the model got here, with every version scored honestly:

| Version | Synthetic data (17 products) | Real pharmacy data (200 drugs) |
|---|---|---|
| v1: indices from the first 4 weeks, tuned on one 14-day block | beats both on 5/17, roughly tied with mean-7 | not tested |
| v2: indices from the whole training window, tuned on rolling 7-day origins | beats both on 12/17, pooled WAPE 35.9 % | beats both on 125/200, but pooled WAPE **122.5 %**, worse than both baselines (81.2 %, 90.5 %) because of the near-closed-weekday blow-up |
| **v3 (current): form chosen per product (additive / multiplicative)** | beats both on **11/17**, pooled WAPE **35.8 %** | beats both on **168/200**, pooled WAPE **70.3 %**, best of the three |

The v2 → v3 change cost one synthetic win. Amlodipine moved from 3.25 vs 3.30 to 3.31 vs 3.30 MAE, so it is now just behind the 7-day mean. Every slow item improved (eye drops 0.73 → 0.67, thermometer 0.48 → 0.40).

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

## Public dataset: real pharmacy sales

The same walk-forward backtest, unchanged, was run on real point-of-sale data from a pharmacy.

**Source and licence.** Gustriansyah, R. (2022). *Retail sales dataset of a pharmacy in Indonesia.* Mendeley Data, V1. [doi:10.17632/2ym7v78wtd.1](https://doi.org/10.17632/2ym7v78wtd.1). Licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Changes made:
- the `transaction` table was summed to units per product per day
- 268 rows with quantity ≤ 0 (returns or corrections) were dropped
- days with no sale count as 0

The data is not committed to this repository.

**What it contains:**
- 399,470 sale lines for 2,042 products
- every day of 2015 (365 days)
- mostly prescription medicine, with near-zero sales on some weekdays

**Reproduce:**

```bash
mkdir -p data/external/mendeley-pharmacy
```

Download `sales.zip` from the DOI above into that folder and unzip it there (it contains `sales.sql`, a MariaDB dump). Then:

```bash
npm run dataset:pharmacy
```

```bash
npm run backtest:csv -- data/external/pharmacy-daily.csv --top=200 --quiet
```

The dump is **parsed as text, never executed** (`scripts/prepare-pharmacy-dataset.js`). The backtest scores the 200 products with the most units sold, which is 86 % of all units in the year.

**Results (7-day horizon, last 26 weekly windows, re-tuned at every origin):**

| Segment | Items | Model beats both | Pooled MAE: model / same-day-last-week / 7-day mean | Pooled WAPE: model / same-day-last-week / 7-day mean |
|---|---|---|---|---|
| Fast (≥ 15/day) | 70 | 65 | **60.6** / 72.2 / 84.7 | **54.6 %** / 65.1 % / 76.3 % |
| Medium | 12 | 7 | **9.4** / 11.5 / 9.6 | **71.8 %** / 87.4 % / 73.1 % |
| Slow / intermittent (≥ 30 % zero days) | 118 | 96 | **32.0** / 35.5 / 37.4 | **104.9 %** / 116.6 % / 122.7 % |
| **All 200** | 200 | **168 (84 %)** | **40.8** / 47.1 / 52.5 | **70.3 %** / 81.2 % / 90.5 % |

**What this shows:**
- **Real data found a real bug.** The earlier model (v2 in the table above) beat both baselines on 125/200 items, but its pooled WAPE was 122.5 %, worse than either baseline. A few high-volume drugs with near-zero weekdays blew up the multiplicative update, for example item AI-0406 with MAE 1,576 vs 240 for same-day-last-week. The synthetic data had no such weekdays, so it could never have shown this. Choosing the seasonal form per product fixed it.
- **Researcher degrees of freedom.** The fix was designed *after* seeing this dataset fail, so these numbers are not a fully untouched hold-out. The fix is a standard modelling choice, not tuning to the test. The form is picked per product on that product's own past (validation window) and re-picked at every backtest origin, and the synthetic results stayed the same.
- **Intermittent items remain hard.** WAPE above 100 % means the total error exceeds the units sold. The model is still better than both baselines on these items, but a forecast for a drug that sells a few times a month is a rough guide. That is why the app shows *Rough guide* and *Low confidence* badges, and why Croston/SBA is the next step.
- **Only one year of data**, so annual seasonality can't be tested here either.

## Limitations

- The app's demo history is synthetic. The real-data check (above) is a different pharmacy, in a different country, from 2015, and only one year long. It shows the method holds up on real demand, not that it is calibrated for any particular shop.
- Slow and intermittent items have high error in absolute terms (WAPE above 100 % on real data), even where the model beats the baselines. The app labels these forecasts as rough guides.
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
db/migrations/            versioned SQL migrations (CHECK constraints guard qty ≥ 0 at the DB level too)
public/                   no-build SPA: js/core.js (API, safe html``), js/ui.js (dialogs, drawer,
                          toasts, expiry meter), js/pages/*.js — one module per screen
scripts/                  migrate, seed, backtest reports
test/                     *.unit.test.js (pure) and sales.db.test.js (real PostgreSQL)
```

Design decisions:
- **PostgreSQL rather than SQLite**, because the spec needs row-level locks (`FOR UPDATE`) and SQLite has none.
- **The business logic is pure functions** (FEFO, forecast, reorder, risk). The services only load rows, call them, and write the results. That's what makes the critical parts testable without a database, and easy to explain line by line in a review.
- **Dates are `YYYY-MM-DD` strings** with UTC arithmetic. pg's `DATE` → JS `Date` conversion is turned off, so expiry never shifts by a day because of the timezone.
- **Append-only `stock_movements`**: every receive, sale and write-off is a signed row, so stock can always be audited.

## Security

* Parameterised SQL only.
* Every HTML value is escaped, and a strict Content-Security-Policy is set.
* The session cookie is `httpOnly` and `SameSite=Strict`, and the database stores only a hash of the token.
* Passwords use scrypt.
* Login is throttled (429 after 5 failures). An unknown username and a wrong password get the same message and take the same time.
* Roles are enforced in the API, and staff responses have costs removed.
* All input is validated at the edge (400, never 500), with database constraints behind that.

Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-summary).

## Documentation

| Doc | Contents |
|---|---|
| [docs/PLANNING.md](docs/PLANNING.md) | Problem breakdown, build order, decisions and trade-offs, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, ER diagram, the sale step by step, full API table, security summary |
| [docs/DEMO.md](docs/DEMO.md) | 12-minute live-demo script, a line-by-line model walkthrough, likely review questions with answers |

## Tests (`npm test` → 51 tests)

**HTTP end to end** (`http.db.test.js`, the real app on a random port)
* 401 without a session
* the cookie is `httpOnly` / `SameSite=Strict`, and only its hash is stored
* logout ends the session
* login is throttled, and an unknown user gets the same message as a wrong password
* staff get 403 on 11 owner endpoints and never see a cost on any endpoint
* staff can't override the purchase price when receiving
* 18 kinds of malformed input each return 400, never 500
* security headers are present
* product editing works, with a 409 for a duplicate SKU


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
