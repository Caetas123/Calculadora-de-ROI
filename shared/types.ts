export type SortKey = 'roi' | 'profit' | 'price' | 'expected' | 'discount' | 'liquidity' | 'drops' | 'instant';

export interface MarketCard {
  appid: number;
  hash_name: string;
  name: string;
  is_foil: boolean;
  rarity?: string | null;
  icon_url?: string | null;
  lowest_cents: number | null;
  median_cents: number | null;
  volume: number | null;
  sell_listings: number | null;
  buy_order_cents: number | null;
  buy_order_count: number | null;
  last_sale_at?: string | null;
  source_updated_at?: string | null;
  stale: boolean;
}

export interface Opportunity {
  appid: number;
  name: string;
  type: string;
  is_free: boolean;
  available_br: boolean;
  is_delisted: boolean;
  header_image: string | null;
  store_url: string | null;
  price_cents: number | null;
  normal_price_cents: number | null;
  discount_percent: number;
  promo_start: number | null;
  promo_end: number | null;
  cards_count: number;
  drops: number;
  drops_source: string;
  drops_exact: boolean;
  expected_gross_cents: number | null;
  expected_sell_cents: number | null;
  expected_instant_cents: number | null;
  worst_cents: number | null;
  best_cents: number | null;
  median_cents: number | null;
  profit_cents: number | null;
  roi_bps: number | null;
  instant_profit_cents: number | null;
  instant_roi_bps: number | null;
  liquidity_score: number | null;
  liquidity_label: string | null;
  confidence_score: number | null;
  confidence_label: string | null;
  opportunity_score: number | null;
  last_store_at: string | null;
  last_market_at: string | null;
  status: string;
  cards?: MarketCard[];
  special_cards?: MarketCard[];
}

export interface OpportunityPage {
  data: Opportunity[];
  total: number;
}

export interface DashboardStats {
  gamesAnalyzed: number;
  positiveRoi: number;
  topRoi: Opportunity | null;
  topProfit: Opportunity | null;
  totalCataloged: number;
  totalCards: number;
  lastUpdated: string | null;
  latestScan: ScanSummary | null;
}

export interface ScanSummary {
  id: number;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  apps_cataloged: number;
  games_with_cards: number;
  cards_analyzed: number;
  requests: number;
  errors: number;
  message: string | null;
}
