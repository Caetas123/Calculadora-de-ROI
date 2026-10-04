import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { DashboardStats, MarketCard, Opportunity, ScanSummary, SortKey } from '../shared/types.js';

export interface GameUpdate {
  appid: number; name: string; type: string; isFree: boolean; availableBr: boolean; isDelisted: boolean;
  headerImage?: string | null; storeUrl?: string | null; priceCents?: number | null; normalPriceCents?: number | null;
  discountPercent?: number; promoStart?: number | null; promoEnd?: number | null; cardsCount?: number; drops?: number; dropsSource?: string; dropsExact?: boolean; marketCardsVersion?: number;
  expectedGrossCents?: number | null; expectedSellCents?: number | null; expectedInstantCents?: number | null;
  worstCents?: number | null; bestCents?: number | null; medianCents?: number | null; profitCents?: number | null;
  roiBps?: number | null; instantProfitCents?: number | null; instantRoiBps?: number | null; liquidityScore?: number | null;
  liquidityLabel?: string | null; confidenceScore?: number | null; confidenceLabel?: string | null; opportunityScore?: number | null;
  lastStoreAt?: string | null; lastMarketAt?: string | null; status?: string; errorMessage?: string | null;
}

export interface CardUpdate {
  appid: number; hashName: string; name: string; isFoil?: boolean; rarity?: string | null; iconUrl?: string | null; lowestCents?: number | null;
  medianCents?: number | null; volume?: number | null; sellListings?: number | null; buyOrderCents?: number | null;
  buyOrderCount?: number | null; lastSaleAt?: string | null; sourceUpdatedAt?: string | null; stale?: boolean;
}

type OpportunityQuery = { where: string; params: Record<string, number | string>; sort: string; limit: number; offset: number };

function localizeScoreLabel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const labels: Record<string, string> = { Unknown: 'Desconhecida', 'Very High': 'Muito alta', High: 'Alta', Medium: 'Média', Low: 'Baixa' };
  return labels[String(value)] ?? String(value);
}

export class StoreDb {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5_000, enableForeignKeyConstraints: true, allowBareNamedParameters: true });
    const migration = fs.readFileSync(path.resolve(process.cwd(), 'migrations/001_initial.sql'), 'utf8');
    this.db.exec(migration);
    // O aplicativo pode já ter um banco criado por uma versão anterior.
    // As alterações são aditivas para que a atualização não exija apagar o cache.
    try { this.db.exec("ALTER TABLE games ADD COLUMN drops_source TEXT NOT NULL DEFAULT 'estimated_half_set'"); } catch { /* a coluna já existe */ }
    try { this.db.exec('ALTER TABLE games ADD COLUMN drops_exact INTEGER NOT NULL DEFAULT 0'); } catch { /* a coluna já existe */ }
    try { this.db.exec('ALTER TABLE games ADD COLUMN market_cards_version INTEGER NOT NULL DEFAULT 0'); } catch { /* a coluna já existe */ }
    try { this.db.exec('ALTER TABLE cards ADD COLUMN rarity TEXT'); } catch { /* a coluna já existe */ }
    // Não encerra uma varredura longa só porque o processo do painel foi
    // reiniciado. Apenas varreduras sem chance recente de ainda estarem ativas
    // são recuperadas automaticamente.
    this.db.prepare("UPDATE scans SET status='failed', finished_at=?, message='Process ended before scan completion' WHERE status='running' AND datetime(started_at) < datetime('now','-2 hours')").run(new Date().toISOString());
  }

  upsertGame(game: GameUpdate): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO games (
        appid,name,type,is_free,available_br,is_delisted,header_image,store_url,price_cents,normal_price_cents,
        discount_percent,promo_start,promo_end,cards_count,drops,drops_source,drops_exact,market_cards_version,expected_gross_cents,expected_sell_cents,
        expected_instant_cents,worst_cents,best_cents,median_cents,profit_cents,roi_bps,instant_profit_cents,
        instant_roi_bps,liquidity_score,liquidity_label,confidence_score,confidence_label,opportunity_score,
        last_store_at,last_market_at,status,error_message,created_at,updated_at
      ) VALUES (
        @appid,@name,@type,@isFree,@availableBr,@isDelisted,@headerImage,@storeUrl,@priceCents,@normalPriceCents,
        @discountPercent,@promoStart,@promoEnd,@cardsCount,@drops,@dropsSource,@dropsExact,@marketCardsVersion,@expectedGrossCents,@expectedSellCents,
        @expectedInstantCents,@worstCents,@bestCents,@medianCents,@profitCents,@roiBps,@instantProfitCents,
        @instantRoiBps,@liquidityScore,@liquidityLabel,@confidenceScore,@confidenceLabel,@opportunityScore,
        @lastStoreAt,@lastMarketAt,@status,@errorMessage,@now,@now
      ) ON CONFLICT(appid) DO UPDATE SET
        name=excluded.name,type=excluded.type,is_free=excluded.is_free,available_br=excluded.available_br,
        is_delisted=excluded.is_delisted,header_image=COALESCE(excluded.header_image,games.header_image),
        store_url=COALESCE(excluded.store_url,games.store_url),price_cents=excluded.price_cents,
        normal_price_cents=excluded.normal_price_cents,discount_percent=excluded.discount_percent,
        cards_count=CASE WHEN excluded.status = 'pending' THEN games.cards_count ELSE excluded.cards_count END,
        drops=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.drops ELSE excluded.drops END,
        drops_source=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.drops_source ELSE excluded.drops_source END,
        drops_exact=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.drops_exact ELSE excluded.drops_exact END,
        market_cards_version=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.market_cards_version ELSE excluded.market_cards_version END,
        expected_gross_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.expected_gross_cents ELSE excluded.expected_gross_cents END,
        expected_sell_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.expected_sell_cents ELSE excluded.expected_sell_cents END,
        expected_instant_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.expected_instant_cents ELSE excluded.expected_instant_cents END,
        worst_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.worst_cents ELSE excluded.worst_cents END,
        best_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.best_cents ELSE excluded.best_cents END,
        median_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.median_cents ELSE excluded.median_cents END,
        profit_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.profit_cents ELSE excluded.profit_cents END,
        roi_bps=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.roi_bps ELSE excluded.roi_bps END,
        instant_profit_cents=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.instant_profit_cents ELSE excluded.instant_profit_cents END,
        instant_roi_bps=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.instant_roi_bps ELSE excluded.instant_roi_bps END,
        liquidity_score=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.liquidity_score ELSE excluded.liquidity_score END,
        liquidity_label=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.liquidity_label ELSE excluded.liquidity_label END,
        confidence_score=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.confidence_score ELSE excluded.confidence_score END,
        confidence_label=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.confidence_label ELSE excluded.confidence_label END,
        opportunity_score=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.opportunity_score ELSE excluded.opportunity_score END,
        last_store_at=COALESCE(excluded.last_store_at,games.last_store_at),
        last_market_at=CASE WHEN excluded.status IN ('pending','stale','error') THEN games.last_market_at ELSE excluded.last_market_at END,
        status=CASE WHEN excluded.status = 'pending' AND games.status IN ('ready','stale') THEN games.status ELSE excluded.status END,
        error_message=CASE WHEN excluded.status = 'pending' THEN games.error_message ELSE excluded.error_message END,
        updated_at=excluded.updated_at
    `).run({
      appid: game.appid, name: game.name, type: game.type, isFree: game.isFree ? 1 : 0, availableBr: game.availableBr ? 1 : 0,
      isDelisted: game.isDelisted ? 1 : 0, headerImage: game.headerImage ?? null, storeUrl: game.storeUrl ?? null,
      priceCents: game.priceCents ?? null, normalPriceCents: game.normalPriceCents ?? null, discountPercent: game.discountPercent ?? 0,
      promoStart: game.promoStart ?? null, promoEnd: game.promoEnd ?? null, cardsCount: game.cardsCount ?? 0, drops: game.drops ?? 0,
      dropsSource: game.dropsSource ?? 'estimated_half_set', dropsExact: game.dropsExact ? 1 : 0, marketCardsVersion: game.marketCardsVersion ?? 0,
      expectedGrossCents: game.expectedGrossCents ?? null, expectedSellCents: game.expectedSellCents ?? null,
      expectedInstantCents: game.expectedInstantCents ?? null, worstCents: game.worstCents ?? null, bestCents: game.bestCents ?? null,
      medianCents: game.medianCents ?? null, profitCents: game.profitCents ?? null, roiBps: game.roiBps ?? null,
      instantProfitCents: game.instantProfitCents ?? null, instantRoiBps: game.instantRoiBps ?? null,
      liquidityScore: game.liquidityScore ?? null, liquidityLabel: game.liquidityLabel ?? null,
      confidenceScore: game.confidenceScore ?? null, confidenceLabel: game.confidenceLabel ?? null,
      opportunityScore: game.opportunityScore ?? null, lastStoreAt: game.lastStoreAt ?? null, lastMarketAt: game.lastMarketAt ?? null,
      status: game.status ?? 'pending', errorMessage: game.errorMessage ?? null, now
    });
  }

  upsertCard(card: CardUpdate): void {
    this.db.prepare(`
      INSERT INTO cards (appid,hash_name,name,is_foil,rarity,icon_url,lowest_cents,median_cents,volume,sell_listings,buy_order_cents,buy_order_count,last_sale_at,source_updated_at,stale)
      VALUES (@appid,@hashName,@name,@isFoil,@rarity,@iconUrl,@lowestCents,@medianCents,@volume,@sellListings,@buyOrderCents,@buyOrderCount,@lastSaleAt,@sourceUpdatedAt,@stale)
      ON CONFLICT(appid,hash_name) DO UPDATE SET name=excluded.name,is_foil=excluded.is_foil,rarity=excluded.rarity,icon_url=excluded.icon_url,
        lowest_cents=excluded.lowest_cents,median_cents=excluded.median_cents,volume=excluded.volume,sell_listings=excluded.sell_listings,
        buy_order_cents=excluded.buy_order_cents,buy_order_count=excluded.buy_order_count,last_sale_at=excluded.last_sale_at,
        source_updated_at=excluded.source_updated_at,stale=excluded.stale
    `).run({ appid: card.appid, hashName: card.hashName, name: card.name, isFoil: card.isFoil ? 1 : 0, rarity: card.rarity ?? null, iconUrl: card.iconUrl ?? null,
      lowestCents: card.lowestCents ?? null, medianCents: card.medianCents ?? null, volume: card.volume ?? null, sellListings: card.sellListings ?? null,
      buyOrderCents: card.buyOrderCents ?? null, buyOrderCount: card.buyOrderCount ?? null, lastSaleAt: card.lastSaleAt ?? null,
      sourceUpdatedAt: card.sourceUpdatedAt ?? null, stale: card.stale ? 1 : 0 });
  }

  saveGamePriceHistory(appid: number, game: GameUpdate, capturedAt = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO game_price_history (appid,price_cents,normal_price_cents,discount_percent,captured_at) VALUES (?,?,?,?,?)')
      .run(appid, game.priceCents ?? null, game.normalPriceCents ?? null, game.discountPercent ?? 0, capturedAt);
  }

  saveMarketHistory(card: CardUpdate, capturedAt = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO market_price_history (appid,hash_name,lowest_cents,median_cents,volume,sell_listings,captured_at) VALUES (?,?,?,?,?,?,?)')
      .run(card.appid, card.hashName, card.lowestCents ?? null, card.medianCents ?? null, card.volume ?? null, card.sellListings ?? null, capturedAt);
  }

  getCards(appid: number): MarketCard[] {
    const rows = this.db.prepare("SELECT * FROM cards WHERE appid = ? AND is_foil = 0 AND (rarity IS NULL OR rarity = '') ORDER BY lowest_cents IS NULL, lowest_cents ASC").all(appid) as Record<string, unknown>[];
    return rows.map((row) => this.cardFromRow(row));
  }

  getSpecialCards(appid: number): MarketCard[] {
    const rows = this.db.prepare("SELECT * FROM cards WHERE appid = ? AND (is_foil = 1 OR (rarity IS NOT NULL AND rarity <> '')) ORDER BY is_foil DESC, lowest_cents IS NULL, lowest_cents ASC").all(appid) as Record<string, unknown>[];
    return rows.map((row) => this.cardFromRow(row));
  }

  getMarketHistory(appid: number, hashName: string, limit = 90): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT lowest_cents,median_cents,volume,sell_listings,captured_at FROM market_price_history WHERE appid = ? AND hash_name = ? ORDER BY captured_at DESC LIMIT ?').all(appid, hashName, Math.max(1, Math.min(365, limit))) as unknown as Array<Record<string, unknown>>;
  }

  getGameHistory(appid: number, limit = 90): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT price_cents,normal_price_cents,discount_percent,captured_at FROM game_price_history WHERE appid = ? ORDER BY captured_at DESC LIMIT ?').all(appid, Math.max(1, Math.min(365, limit))) as unknown as Array<Record<string, unknown>>;
  }

  priorityAppids(): number[] {
    const rows = this.db.prepare("SELECT appid FROM games WHERE status IN ('ready','stale') ORDER BY (discount_percent > 0) DESC, COALESCE(opportunity_score,0) DESC, COALESCE(confidence_score,0) DESC, updated_at ASC LIMIT 5000").all() as unknown as Array<{ appid: number }>;
    return rows.map((row) => Number(row.appid));
  }

  gameFreshness(appid: number): {
    status: string;
    lastStoreAt: string | null;
    lastMarketAt: string | null;
    priceCents: number | null;
    type: string;
    availableBr: boolean;
    marketCardsVersion: number;
  } | null {
    const row = this.db.prepare('SELECT status,last_store_at,last_market_at,price_cents,type,available_br,market_cards_version FROM games WHERE appid = ?').get(appid) as unknown as {
      status: string;
      last_store_at: string | null;
      last_market_at: string | null;
      price_cents: number | null;
      type: string;
      available_br: number;
      market_cards_version: number;
    } | undefined;
    return row ? {
      status: row.status,
      lastStoreAt: row.last_store_at,
      lastMarketAt: row.last_market_at,
      priceCents: row.price_cents === null || row.price_cents === undefined ? null : Number(row.price_cents),
      type: row.type,
      availableBr: Boolean(row.available_br),
      marketCardsVersion: Number(row.market_cards_version ?? 0),
    } : null;
  }

  private cardFromRow(row: Record<string, unknown>): MarketCard {
    return {
      appid: Number(row.appid), hash_name: String(row.hash_name), name: String(row.name), is_foil: Boolean(row.is_foil), rarity: row.rarity as string | null,
      icon_url: row.icon_url as string | null, lowest_cents: row.lowest_cents as number | null, median_cents: row.median_cents as number | null,
      volume: row.volume as number | null, sell_listings: row.sell_listings as number | null, buy_order_cents: row.buy_order_cents as number | null,
      buy_order_count: row.buy_order_count as number | null, last_sale_at: row.last_sale_at as string | null,
      source_updated_at: row.source_updated_at as string | null, stale: Boolean(row.stale)
    };
  }

  private opportunityFromRow(row: Record<string, unknown>): Opportunity {
    return {
      appid: Number(row.appid), name: String(row.name), type: String(row.type), is_free: Boolean(row.is_free), available_br: Boolean(row.available_br),
      is_delisted: Boolean(row.is_delisted), header_image: row.header_image as string | null, store_url: row.store_url as string | null,
      price_cents: row.price_cents as number | null, normal_price_cents: row.normal_price_cents as number | null, discount_percent: Number(row.discount_percent ?? 0),
      promo_start: row.promo_start as number | null, promo_end: row.promo_end as number | null, cards_count: Number(row.cards_count ?? 0), drops: Number(row.drops ?? 0),
      drops_source: String(row.drops_source ?? 'estimated_half_set'), drops_exact: Boolean(row.drops_exact),
      expected_gross_cents: row.expected_gross_cents as number | null, expected_sell_cents: row.expected_sell_cents as number | null,
      expected_instant_cents: row.expected_instant_cents as number | null, worst_cents: row.worst_cents as number | null, best_cents: row.best_cents as number | null,
      median_cents: row.median_cents as number | null, profit_cents: row.profit_cents as number | null, roi_bps: row.roi_bps as number | null,
      instant_profit_cents: row.instant_profit_cents as number | null, instant_roi_bps: row.instant_roi_bps as number | null,
      liquidity_score: row.liquidity_score as number | null, liquidity_label: localizeScoreLabel(row.liquidity_label),
      confidence_score: row.confidence_score as number | null, confidence_label: localizeScoreLabel(row.confidence_label), opportunity_score: row.opportunity_score as number | null,
      last_store_at: row.last_store_at as string | null, last_market_at: row.last_market_at as string | null, status: String(row.status)
    };
  }

  private buildOpportunityQuery(query: Record<string, string | undefined> = {}): OpportunityQuery {
    const where: string[] = ["status IN ('ready','stale')", 'cards_count > 0', 'drops > 0'];
    const params: Record<string, number | string> = {};
    const add = (condition: string, key: string, value: number) => { if (Number.isFinite(value)) { where.push(condition); params[key] = value; } };
    if (query.promotion === '1') where.push('discount_percent > 0');
    if (query.positive === '1') where.push('profit_cents > 0');
    if (query.updatedOnly === '1') where.push("status = 'ready'");
    if (query.excludeFree === '1') where.push('is_free = 0 AND price_cents > 0');
    if (query.excludeUnavailable === '1') where.push('available_br = 1');
    const search = (query.search ?? '').trim().toLowerCase();
    if (search) { params.search = `%${search}%`; where.push('(LOWER(name) LIKE @search OR CAST(appid AS TEXT) LIKE @search)'); }
    const numeric = (value: string | undefined): number => Number((value ?? '').replace(',', '.'));
    if (query.roiMin) add('roi_bps >= @roiMin', 'roiMin', numeric(query.roiMin) * 100);
    if (query.priceMax) add('price_cents <= @priceMax', 'priceMax', numeric(query.priceMax) * 100);
    if (query.priceMin) add('price_cents >= @priceMin', 'priceMin', numeric(query.priceMin) * 100);
    if (query.profitMin) add('profit_cents >= @profitMin', 'profitMin', numeric(query.profitMin) * 100);
    if (query.dropsMin) add('drops >= @dropsMin', 'dropsMin', numeric(query.dropsMin));
    if (query.cardsMin) add('cards_count >= @cardsMin', 'cardsMin', numeric(query.cardsMin));
    if (query.discountMin) add('discount_percent >= @discountMin', 'discountMin', numeric(query.discountMin));
    if (query.volumeMin) add('liquidity_score >= @volumeMin', 'volumeMin', numeric(query.volumeMin));
    const sortMap: Record<SortKey, string> = {
      roi: 'roi_bps DESC', profit: 'profit_cents DESC', price: 'price_cents ASC', expected: 'expected_sell_cents DESC',
      discount: 'discount_percent DESC', liquidity: 'liquidity_score DESC', drops: 'drops DESC', instant: 'instant_roi_bps DESC'
    };
    const sort = sortMap[(query.sort ?? 'roi') as SortKey] ?? sortMap.roi;
    const limit = Math.max(1, Math.min(500, Math.floor(Number(query.pageSize ?? query.limit ?? 100))));
    const requestedPage = Math.max(1, Math.floor(Number(query.page ?? 1)));
    const offset = query.page ? (requestedPage - 1) * limit : Math.max(0, Math.floor(Number(query.offset ?? 0)));
    return { where: where.join(' AND '), params, sort, limit, offset };
  }

  listOpportunities(query: Record<string, string | undefined> = {}): Opportunity[] {
    const built = this.buildOpportunityQuery(query);
    const rows = this.db.prepare(`SELECT * FROM games WHERE ${built.where} ORDER BY ${built.sort} LIMIT @limit OFFSET @offset`).all({ ...built.params, limit: built.limit, offset: built.offset }) as Record<string, unknown>[];
    return rows.map((row) => this.opportunityFromRow(row));
  }

  listOpportunitiesPage(query: Record<string, string | undefined> = {}): { data: Opportunity[]; total: number } {
    const built = this.buildOpportunityQuery(query);
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM games WHERE ${built.where}`).get(built.params) as { count: number }).count);
    const rows = this.db.prepare(`SELECT * FROM games WHERE ${built.where} ORDER BY ${built.sort} LIMIT @limit OFFSET @offset`).all({ ...built.params, limit: built.limit, offset: built.offset }) as Record<string, unknown>[];
    return { data: rows.map((row) => this.opportunityFromRow(row)), total };
  }

  getOpportunity(appid: number): Opportunity | null {
    const row = this.db.prepare('SELECT * FROM games WHERE appid = ?').get(appid) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { ...this.opportunityFromRow(row), cards: this.getCards(appid), special_cards: this.getSpecialCards(appid) };
  }

  markGameError(appid: number, message: string): void {
    const existing = this.db.prepare('SELECT status FROM games WHERE appid = ?').get(appid) as { status?: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE games SET status = CASE WHEN status = 'ready' THEN 'stale' ELSE 'error' END, error_message = ?, updated_at = ? WHERE appid = ?")
        .run(message.slice(0, 500), new Date().toISOString(), appid);
    } else {
      this.upsertGame({ appid, name: `App ${appid}`, type: 'unknown', isFree: false, availableBr: false, isDelisted: false, status: 'error', errorMessage: message });
    }
  }

  private currentCatalogCount(fallback: () => number): number {
    for (const filename of ['data/card-games.json', 'data/catalog.json']) {
      try {
        const value = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')) as { apps?: unknown; gamesOnly?: boolean };
        if (filename === 'data/catalog.json' && value.gamesOnly !== true) continue;
        if (Array.isArray(value.apps) && value.apps.length > 0) return value.apps.length;
      } catch { /* usa a próxima fonte ou o fallback do banco */ }
    }
    return fallback();
  }

  stats(): DashboardStats {
    const count = (sql: string): number => Number((this.db.prepare(sql).get() as { count: number }).count);
    const topRoi = this.db.prepare("SELECT * FROM games WHERE status IN ('ready','stale') AND roi_bps IS NOT NULL ORDER BY roi_bps DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const topProfit = this.db.prepare("SELECT * FROM games WHERE status IN ('ready','stale') AND is_free = 0 AND price_cents > 0 AND profit_cents IS NOT NULL ORDER BY profit_cents DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const latest = this.latestScan();
    return {
      gamesAnalyzed: count("SELECT COUNT(*) AS count FROM games WHERE status IN ('ready','stale') AND cards_count > 0"),
      positiveRoi: count("SELECT COUNT(*) AS count FROM games WHERE status IN ('ready','stale') AND is_free = 0 AND price_cents > 0 AND profit_cents > 0"),
      topRoi: topRoi ? this.opportunityFromRow(topRoi) : null,
      topProfit: topProfit ? this.opportunityFromRow(topProfit) : null,
      totalCataloged: this.currentCatalogCount(() => count("SELECT COUNT(*) AS count FROM games WHERE status <> 'pending'")),
      totalCards: count('SELECT COUNT(*) AS count FROM cards WHERE is_foil = 0'),
      lastUpdated: (this.db.prepare("SELECT MAX(updated_at) AS value FROM games WHERE status IN ('ready','stale')").get() as { value: string | null }).value,
      latestScan: latest
    };
  }

  createScan(kind: string): number {
    const result = this.db.prepare('INSERT INTO scans (kind,status,started_at) VALUES (?,?,?)').run(kind, 'running', new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  finishScan(id: number, summary: Partial<ScanSummary> & { status: string; message?: string | null }): void {
    this.db.prepare('UPDATE scans SET status=?,finished_at=?,apps_cataloged=?,games_with_cards=?,cards_analyzed=?,requests=?,errors=?,message=? WHERE id=?')
      .run(summary.status, new Date().toISOString(), summary.apps_cataloged ?? 0, summary.games_with_cards ?? 0, summary.cards_analyzed ?? 0, summary.requests ?? 0, summary.errors ?? 0, summary.message ?? null, id);
  }

  updateScanProgress(id: number, summary: Partial<ScanSummary>): void {
    this.db.prepare('UPDATE scans SET apps_cataloged=?,games_with_cards=?,cards_analyzed=?,requests=?,errors=? WHERE id=?')
      .run(summary.apps_cataloged ?? 0, summary.games_with_cards ?? 0, summary.cards_analyzed ?? 0, summary.requests ?? 0, summary.errors ?? 0, id);
  }

  latestScan(): ScanSummary | null {
    const row = this.db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: Number(row.id), kind: String(row.kind), status: String(row.status), started_at: String(row.started_at), finished_at: row.finished_at as string | null,
      apps_cataloged: Number(row.apps_cataloged), games_with_cards: Number(row.games_with_cards), cards_analyzed: Number(row.cards_analyzed), requests: Number(row.requests), errors: Number(row.errors), message: row.message as string | null };
  }

  exportRows(): Opportunity[] { return this.listOpportunities({ sort: 'roi', limit: '500' }); }
}
