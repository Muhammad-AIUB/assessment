# Planning & decisions

## 1. The problem, restated

Small pharmacies keep stock in a notebook or Excel with **no batch or expiry tracking**. That causes three losses:

| Loss | Root cause | What the system does about it |
|---|---|---|
| Medicine expires on the shelf | Nobody knows which pack expires when | Every receipt is a **batch with an expiry date**; sales take the **first-expiring** batch (FEFO); expiry watch and write-off |
| Fast movers run out | No view of demand vs. stock | Demand **forecast** per product, a **reorder planner** ranked by days of cover |
| Order sizes are guesses | No link from sales history to purchasing | Reorder quantity = forecast demand + safety stock − usable stock − on order → **Draft PO in one click** |

The loop: `Purchase Order → Batch (with expiry) → Sale (FEFO) → sales history → Forecast → Reorder suggestion → new Purchase Order`.

## 2. Users and what each may do

| | Owner | Staff |
|---|---|---|
| Sell, receive goods | ✓ | ✓ |
| See purchase prices | ✓ | ✗ (removed server-side) |
| Write off, purchase orders, forecast, reports, staff, catalogue | ✓ | ✗ (403) |

## 3. Build order (and why)

1. **Schema + seed script first.** The forecast depends on months of sales history, and none exists, so the simulator came before any feature. It runs the same `allocateFefo()` as the live app, so the seeded history follows the same rules.
2. **Pure core:** FEFO allocation, the forecast model, metrics, backtest, reorder and expiry risk. These are plain functions with no I/O, tested first.
3. **Transactional services:** sale (row locks), PO lifecycle, receive, write-off. Tested against real PostgreSQL.
4. **API + roles**, then the **UI**, then the **model report**.
5. **Hardening:** validation at the edge, security headers, login throttle, hashed sessions, migrations, CI.

## 4. Key decisions & trade-offs

| Decision | Alternatives considered | Why |
|---|---|---|
| **PostgreSQL** | SQLite, MongoDB | The spec requires row-level locks during a sale (`SELECT … FOR UPDATE`). SQLite only locks the whole database; Mongo would need hand-written transactions. |
| **Lock batch rows, products in id order** | Optimistic version column + retry; `SERIALIZABLE` | Pessimistic locking is simple and correct for short counter transactions. Ordering by id prevents deadlocks between multi-item sales. |
| **Store only "written off"; derive near-expiry/expired from dates** | A nightly job updating a `status` column | A derived status can never go stale. Nothing has to run on time. |
| **Expiry stored as month-end `DATE`** | Store month/year text | Packs print MM/YYYY and the medicine is valid until month-end. A real date makes comparisons and indexes simple. |
| **Hand-written forecast (no ML library)** | Prophet, statsmodels, ARIMA | The brief asks for it, and it can be explained line by line in a review. A level × weekday model fits daily pharmacy demand. |
| **Tune α, γ by MAE on rolling 7-day origins** | A single hold-out block | The first version used one 14-day block and beat the baselines on only 5/17 products. Scoring the way the model is actually used raised that to 12/17. |
| **Seasonal form (additive vs multiplicative) chosen per product** | Multiplicative only | Found by testing on **real** pharmacy data. Weekdays with near-zero sales made the multiplicative model divide by ≈ 0.01 and explode (pooled MAE 152 vs 108 for the naive baseline). Additive has no division. The form is now tuned like α and γ, and multiplicative is ruled out when a weekday index is below 0.2. |
| **σ from the backtest feeds safety stock** | A fixed % buffer | Evaluation becomes business logic: a product that is harder to predict gets a bigger buffer automatically. |
| **No frontend framework / build step** | React + Vite | Fewer moving parts to set up and review. ES modules plus a small escaping `html` template is enough at this size. |
| **Versioned SQL migrations** | ORM migrations | Plain SQL is easy to read in a review, and each migration runs in its own transaction. |

## 5. Risks identified up front

| Risk | Mitigation |
|---|---|
| Two clerks sell the last units at once | One transaction, `FOR UPDATE` row locks; tested with 15 concurrent sales |
| Timezone shifts the expiry by a day | Dates are `YYYY-MM-DD` strings, UTC arithmetic, the pg `DATE` parser is disabled, "today" uses the shop's timezone |
| Model looks good only on its own synthetic data | Noise and spikes in the seed; two baselines; honest reporting of where the model loses |
| Staff seeing cost prices | Costs stripped centrally in the API (not just hidden in the UI); tested on every endpoint |

## 6. Out of scope (stated, not forgotten)

Partial receipts across several deliveries, customer returns, price history, several branches, and annual seasonality or promotions in the forecast. The README lists these under *Limitations*.
