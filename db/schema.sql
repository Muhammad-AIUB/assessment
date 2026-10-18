-- PharmaStock schema. Re-runnable: drops and recreates everything (used by migrate + tests).
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TYPE user_role     AS ENUM ('owner', 'staff');
CREATE TYPE po_status     AS ENUM ('draft', 'ordered', 'received', 'cancelled');
-- Only "written_off" is stored. Near Expiry / Expired are derived from expiry_date vs today,
-- so a batch can never be stuck in a stale status because a cron job didn't run.
CREATE TYPE batch_state   AS ENUM ('active', 'written_off');
CREATE TYPE movement_type AS ENUM ('receive', 'sale', 'write_off');

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE suppliers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  phone          TEXT,
  lead_time_days INT NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0)
);

CREATE TABLE products (
  id                 SERIAL PRIMARY KEY,
  sku                TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  unit               TEXT NOT NULL DEFAULT 'pcs',
  supplier_id        INT REFERENCES suppliers(id),
  lead_time_days     INT NOT NULL CHECK (lead_time_days >= 0),
  review_period_days INT NOT NULL DEFAULT 7 CHECK (review_period_days > 0),  -- days until the next order
  min_level          INT NOT NULL DEFAULT 0 CHECK (min_level >= 0),
  sell_price         NUMERIC(10,2) NOT NULL CHECK (sell_price >= 0),
  active             BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE purchase_orders (
  id           SERIAL PRIMARY KEY,
  supplier_id  INT NOT NULL REFERENCES suppliers(id),
  status       po_status NOT NULL DEFAULT 'draft',
  note         TEXT,
  created_by   INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ordered_at   TIMESTAMPTZ,
  received_at  TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE po_items (
  id         SERIAL PRIMARY KEY,
  po_id      INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty        INT NOT NULL CHECK (qty > 0),
  unit_cost  NUMERIC(10,2) CHECK (unit_cost >= 0),
  UNIQUE (po_id, product_id)
);

CREATE TABLE batches (
  id           SERIAL PRIMARY KEY,
  product_id   INT NOT NULL REFERENCES products(id),
  po_item_id   INT REFERENCES po_items(id),
  batch_no     TEXT NOT NULL,
  expiry_date  DATE NOT NULL,              -- last valid day (month-end when the packet shows MM/YYYY)
  qty_received INT NOT NULL CHECK (qty_received > 0),
  qty_on_hand  INT NOT NULL CHECK (qty_on_hand >= 0),
  unit_cost    NUMERIC(10,2) NOT NULL CHECK (unit_cost >= 0),
  state        batch_state NOT NULL DEFAULT 'active',
  received_at  DATE NOT NULL,
  CHECK (qty_on_hand <= qty_received)
);
CREATE INDEX batches_fefo_idx ON batches (product_id, expiry_date, id) WHERE state = 'active' AND qty_on_hand > 0;

CREATE TABLE sales (
  id         SERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  sale_date  DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sales_date_idx ON sales (sale_date);

CREATE TABLE sale_lines (
  id         SERIAL PRIMARY KEY,
  sale_id    INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  batch_id   INT NOT NULL REFERENCES batches(id),
  qty        INT NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(10,2) NOT NULL
);
CREATE INDEX sale_lines_product_idx ON sale_lines (product_id, sale_id);

-- Append-only audit trail of every stock change.
CREATE TABLE stock_movements (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      INT NOT NULL REFERENCES batches(id),
  product_id    INT NOT NULL REFERENCES products(id),
  type          movement_type NOT NULL,
  qty           INT NOT NULL,               -- signed: + in, - out
  reason        TEXT,
  ref_id        INT,                        -- sale id / po id
  user_id       INT REFERENCES users(id),
  movement_date DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, id DESC);

-- Daily demand history consumed by the forecaster.
CREATE VIEW daily_sales AS
  SELECT sl.product_id, s.sale_date AS day, SUM(sl.qty)::INT AS qty
  FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
  GROUP BY sl.product_id, s.sale_date;
