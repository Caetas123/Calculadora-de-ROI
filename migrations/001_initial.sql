PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  appid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'game',
  is_free INTEGER NOT NULL DEFAULT 0,
  available_br INTEGER NOT NULL DEFAULT 0,
  is_delisted INTEGER NOT NULL DEFAULT 0,
  header_image TEXT,
  store_url TEXT,
  price_cents INTEGER,
  normal_price_cents INTEGER,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  promo_start INTEGER,
  promo_end INTEGER,
  cards_count INTEGER NOT NULL DEFAULT 0,
  drops INTEGER NOT NULL DEFAULT 0,
  drops_source TEXT NOT NULL DEFAULT 'estimated_half_set',
  drops_exact INTEGER NOT NULL DEFAULT 0,
  market_cards_version INTEGER NOT NULL DEFAULT 0,
  expected_gross_cents INTEGER,
  expected_sell_cents INTEGER,
  expected_instant_cents INTEGER,
  worst_cents INTEGER,
  best_cents INTEGER,
  median_cents INTEGER,
  profit_cents INTEGER,
  roi_bps INTEGER,
  instant_profit_cents INTEGER,
  instant_roi_bps INTEGER,
  liquidity_score INTEGER,
  liquidity_label TEXT,
  confidence_score INTEGER,
  confidence_label TEXT,
  opportunity_score INTEGER,
  last_store_at TEXT,
  last_market_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_roi ON games(roi_bps DESC);
CREATE INDEX IF NOT EXISTS idx_games_profit ON games(profit_cents DESC);
CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_filters ON games(price_cents, discount_percent, drops, available_br);

CREATE TABLE IF NOT EXISTS cards (
  appid INTEGER NOT NULL REFERENCES games(appid) ON DELETE CASCADE,
  hash_name TEXT NOT NULL,
  name TEXT NOT NULL,
  is_foil INTEGER NOT NULL DEFAULT 0,
  rarity TEXT,
  icon_url TEXT,
  lowest_cents INTEGER,
  median_cents INTEGER,
  volume INTEGER,
  sell_listings INTEGER,
  buy_order_cents INTEGER,
  buy_order_count INTEGER,
  last_sale_at TEXT,
  source_updated_at TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (appid, hash_name)
);

CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(source_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cards_volume ON cards(volume DESC);

CREATE TABLE IF NOT EXISTS game_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid INTEGER NOT NULL REFERENCES games(appid) ON DELETE CASCADE,
  price_cents INTEGER,
  normal_price_cents INTEGER,
  discount_percent INTEGER,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_price_history ON game_price_history(appid, captured_at DESC);

CREATE TABLE IF NOT EXISTS market_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid INTEGER NOT NULL,
  hash_name TEXT NOT NULL,
  lowest_cents INTEGER,
  median_cents INTEGER,
  volume INTEGER,
  sell_listings INTEGER,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_history ON market_price_history(appid, hash_name, captured_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  apps_cataloged INTEGER NOT NULL DEFAULT 0,
  games_with_cards INTEGER NOT NULL DEFAULT 0,
  cards_analyzed INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at DESC);
