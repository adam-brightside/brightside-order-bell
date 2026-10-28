CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,   -- Shopify order id
  name               TEXT,               -- e.g. #1234
  created_at         TEXT NOT NULL,      -- ISO UTC
  local_date         TEXT NOT NULL,      -- YYYY-MM-DD in STORE_TIMEZONE (drives MTD/WTD)
  total_cents        INTEGER NOT NULL,
  currency           TEXT,
  items              TEXT,               -- JSON array of "2× Product (Variant)"
  landing_page       TEXT,
  full_url           TEXT,
  source             TEXT,
  medium             TEXT,
  campaign           TEXT,
  content            TEXT,
  term               TEXT,               -- ad name
  referrer           TEXT,
  attribution_method TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_local_date ON orders(local_date);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
