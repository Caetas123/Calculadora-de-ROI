import pino from 'pino';
import { config } from './config.js';
import { calculateConfidence, calculateDrops, calculateLiquidity, calculateMetrics, calculateOpportunityScore, calculateRoiBps, labelForScore } from './math.js';
import { StoreDb, type GameUpdate } from './db.js';
import { SteamClient, type AppListEntry, type MarketCardSnapshot, type StoreBundle, type StoreGame } from './steam.js';

const log = pino({ name: 'scanner' });
const marketCardsVersion = 2;

function hoursSince(iso: string): number { return Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000); }

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

export interface ScanResult { id: number; appsCataloged: number; gamesWithCards: number; cardsAnalyzed: number; requests: number; errors: number; }

interface GameAnalysis {
  store: StoreGame;
  cards: MarketCardSnapshot[];
  specialCards: MarketCardSnapshot[];
  drops: number;
  dropsSource: string;
  dropsExact: boolean;
  noDrops: boolean;
  metrics: ReturnType<typeof calculateMetrics>;
  liquidity: { score: number; label: string };
  confidence: { score: number; label: string };
}

export class Scanner {
  constructor(private readonly db: StoreDb, private readonly client = new SteamClient(), private readonly concurrency = 3) {}

  private async analyzeStoreGame(store: StoreGame): Promise<GameAnalysis | null> {
    if (!store.hasCards || store.type !== 'game') return null;
    const exactDrops = await this.client.getExactDropsRemaining(store.appid);
    if (exactDrops === 0) {
      return { store, cards: [], specialCards: [], drops: 0, dropsSource: 'account_badges_exact', dropsExact: true, noDrops: true, metrics: null,
        liquidity: { score: 0, label: 'Unknown' }, confidence: { score: 0, label: 'Unknown' } };
    }
    const marketCards = await this.client.getMarketCards(store.appid);
    const cards = marketCards.filter((card) => !card.isFoil && !card.rarity);
    const specialCards = marketCards.filter((card) => Boolean(card.isFoil || card.rarity));
    if (!cards.length) throw new Error('Trading card category present but market set was empty');
    const drops = exactDrops ?? calculateDrops(cards.length);
    const mappedCards = cards.map((card) => ({ lowest_cents: card.lowestCents, buy_order_cents: card.buyOrderCents }));
    const metrics = calculateMetrics({ cards: mappedCards, drops, priceCents: store.priceCents }, config.defaultPublisherFeeBps);
    const liquidity = calculateLiquidity(cards.map((card) => ({ volume: card.volume, sell_listings: card.sellListings, buy_order_cents: card.buyOrderCents })));
    const pricedCards = cards.filter((card) => card.lowestCents !== null).length;
    const confidence = calculateConfidence({ storeConfirmed: store.priceCents !== null, setComplete: pricedCards === cards.length,
      pricedCards, totalCards: cards.length, liquidityScore: liquidity.score, ageHours: 0, stale: false });
    return { store, cards, specialCards, drops, dropsSource: exactDrops === null ? 'estimated_half_set' : 'account_badges_exact', dropsExact: exactDrops !== null,
      noDrops: false, metrics, liquidity, confidence };
  }

  private baseForStore(store: StoreGame, status: string): GameUpdate {
    return {
      appid: store.appid, name: store.name, type: store.type, isFree: store.isFree, availableBr: store.availableBr,
      isDelisted: store.isDelisted, headerImage: store.headerImage, storeUrl: store.storeUrl, priceCents: store.priceCents,
      normalPriceCents: store.normalPriceCents, discountPercent: store.discountPercent, promoStart: store.promoStart, promoEnd: store.promoEnd,
      lastStoreAt: new Date().toISOString(), status
    };
  }

  private saveGameAnalysis(base: GameUpdate, analysis: GameAnalysis): void {
    if (analysis.noDrops) {
      this.db.upsertGame({ ...base, cardsCount: 0, drops: 0, dropsSource: analysis.dropsSource, dropsExact: true, marketCardsVersion, status: 'no_drops_remaining' });
      return;
    }
    const cards = [...analysis.cards, ...analysis.specialCards].map((card) => ({ appid: base.appid, hashName: card.hashName, name: card.name, isFoil: card.isFoil, rarity: card.rarity,
      iconUrl: card.iconUrl,
      lowestCents: card.lowestCents, medianCents: card.medianCents, volume: card.volume, sellListings: card.sellListings,
      buyOrderCents: card.buyOrderCents, buyOrderCount: card.buyOrderCount, sourceUpdatedAt: new Date().toISOString(), stale: false }));
    for (const card of cards) { this.db.upsertCard(card); this.db.saveMarketHistory(card); }
    const metrics = analysis.metrics;
    if (!metrics) {
      this.db.upsertGame({ ...base, cardsCount: analysis.cards.length, drops: analysis.drops, dropsSource: analysis.dropsSource, dropsExact: analysis.dropsExact, marketCardsVersion,
        confidenceScore: analysis.confidence.score, confidenceLabel: analysis.confidence.label, status: 'stale' });
      return;
    }
    this.db.upsertGame({ ...base, cardsCount: analysis.cards.length, drops: analysis.drops, dropsSource: analysis.dropsSource, dropsExact: analysis.dropsExact, marketCardsVersion,
      expectedGrossCents: metrics.expectedGrossCents, expectedSellCents: metrics.expectedSellCents, expectedInstantCents: metrics.expectedInstantCents,
      worstCents: metrics.worstCents, bestCents: metrics.bestCents, medianCents: metrics.medianCents, profitCents: metrics.profitCents,
      roiBps: metrics.roiBps, instantProfitCents: metrics.instantProfitCents, instantRoiBps: metrics.instantRoiBps,
      liquidityScore: analysis.liquidity.score, liquidityLabel: analysis.liquidity.label, confidenceScore: analysis.confidence.score,
      confidenceLabel: analysis.confidence.label, opportunityScore: calculateOpportunityScore(metrics.roiBps, metrics.profitCents,
        analysis.liquidity.score, analysis.confidence.score), lastMarketAt: new Date().toISOString(), status: 'ready' });
  }

  private saveBundleAnalysis(bundle: StoreBundle, children: GameAnalysis[]): number {
    if (!bundle.priceCents || bundle.priceCents <= 0) throw new Error('Bundle has no paid BR price');
    const active = children.filter((child) => !child.noDrops);
    if (!active.length) {
      const exact = children.length > 0 && children.every((child) => child.dropsExact);
      this.db.upsertGame({ appid: -bundle.bundleId, name: bundle.name, type: 'bundle', isFree: bundle.isFree, availableBr: bundle.availableBr,
        isDelisted: false, headerImage: bundle.headerImage, storeUrl: bundle.storeUrl, priceCents: bundle.priceCents,
        normalPriceCents: bundle.normalPriceCents, discountPercent: bundle.discountPercent, cardsCount: 0, drops: 0,
        dropsSource: exact ? 'account_badges_exact' : 'estimated_half_set', dropsExact: exact, marketCardsVersion, status: exact ? 'no_drops_remaining' : 'stale' });
      return 0;
    }
    if (active.some((child) => child.metrics === null)) throw new Error('Bundle child has incomplete card prices');
    const now = new Date().toISOString();
    const mapBundleCard = (child: GameAnalysis, card: MarketCardSnapshot) => ({ appid: -bundle.bundleId,
      hashName: `bundle-${bundle.bundleId}-${child.store.appid}-${card.hashName}`, name: `${child.store.name} · ${card.name}`,
      isFoil: card.isFoil, rarity: card.rarity, iconUrl: card.iconUrl, lowestCents: card.lowestCents, medianCents: card.medianCents, volume: card.volume,
      sellListings: card.sellListings, buyOrderCents: card.buyOrderCents, buyOrderCount: card.buyOrderCount, sourceUpdatedAt: now, stale: false });
    const normalCards = active.flatMap((child) => child.cards.map((card) => mapBundleCard(child, card)));
    const specialCards = active.flatMap((child) => child.specialCards.map((card) => mapBundleCard(child, card)));
    const cards = [...normalCards, ...specialCards];
    for (const card of cards) { this.db.upsertCard(card); this.db.saveMarketHistory(card); }
    const metrics = active.map((child) => child.metrics!);
    const expectedGrossCents = metrics.reduce((sum, value) => sum + value.expectedGrossCents, 0);
    const expectedSellCents = metrics.reduce((sum, value) => sum + value.expectedSellCents, 0);
    const expectedInstantCents = metrics.every((value) => value.expectedInstantCents !== null)
      ? metrics.reduce((sum, value) => sum + (value.expectedInstantCents ?? 0), 0) : null;
    const drops = active.reduce((sum, child) => sum + child.drops, 0);
    const liquidityScore = Math.round(active.reduce((sum, child) => sum + child.liquidity.score * child.cards.length, 0) / normalCards.length);
    const confidenceScore = Math.min(...active.map((child) => child.confidence.score));
    const profitCents = expectedSellCents - bundle.priceCents;
    const roiBps = calculateRoiBps(profitCents, bundle.priceCents);
    const instantProfitCents = expectedInstantCents === null ? null : expectedInstantCents - bundle.priceCents;
    const dropsExact = active.every((child) => child.dropsExact) && children.every((child) => child.dropsExact);
    const metricsSummary = { expectedGrossCents, expectedSellCents, expectedInstantCents, worstCents: metrics.reduce((sum, value) => sum + value.worstCents, 0),
      bestCents: metrics.reduce((sum, value) => sum + value.bestCents, 0), medianCents: metrics.reduce((sum, value) => sum + value.medianCents, 0),
      profitCents, roiBps, instantProfitCents, instantRoiBps: calculateRoiBps(instantProfitCents, bundle.priceCents) };
    this.db.upsertGame({ appid: -bundle.bundleId, name: bundle.name, type: 'bundle', isFree: bundle.isFree, availableBr: bundle.availableBr,
      isDelisted: false, headerImage: bundle.headerImage, storeUrl: bundle.storeUrl, priceCents: bundle.priceCents, normalPriceCents: bundle.normalPriceCents,
      discountPercent: bundle.discountPercent, cardsCount: normalCards.length, drops, dropsSource: dropsExact ? 'account_badges_exact' : 'estimated_half_set', dropsExact, marketCardsVersion,
      ...metricsSummary, liquidityScore, liquidityLabel: labelForScore(liquidityScore), confidenceScore, confidenceLabel: labelForScore(confidenceScore),
      opportunityScore: calculateOpportunityScore(roiBps, profitCents, liquidityScore, confidenceScore), lastStoreAt: now, lastMarketAt: now, status: 'ready' });
    return normalCards.length;
  }

  async run(limit: number, explicitApps?: AppListEntry[]): Promise<ScanResult> {
    const scanId = this.db.createScan(explicitApps ? 'bootstrap' : 'catalog');
    let apps: AppListEntry[] = [];
    let gamesWithCards = 0;
    let cardsAnalyzed = 0;
    let errors = 0;
    let processedApps = 0;
    try {
      apps = explicitApps ?? await this.client.getAppList();
      if (!explicitApps) {
        const priority = new Set(this.db.priorityAppids());
        apps = [...apps.filter((app) => priority.has(app.appid)), ...apps.filter((app) => !priority.has(app.appid))];
      }
      if (limit > 0) apps = apps.slice(0, limit);
      await mapConcurrent(apps, this.concurrency, async (app, index) => {
        try {
          const freshness = this.db.gameFreshness(app.appid);
          const metadataComplete = (freshness?.type === 'game' || freshness?.type === 'bundle') && freshness.availableBr && freshness.priceCents !== null;
          if (freshness?.status === 'ready' && freshness.marketCardsVersion >= marketCardsVersion && metadataComplete && freshness.lastStoreAt && freshness.lastMarketAt &&
            hoursSince(freshness.lastStoreAt) < config.storeTtlMinutes / 60 && hoursSince(freshness.lastMarketAt) < config.marketTtlMinutes / 60) return;
          if (app.type === 'bundle' && app.bundleId) {
            const bundle = await this.client.getStoreBundle(app.bundleId);
            if (!bundle) { this.db.markGameError(app.appid, 'Steam package is not a multi-game bundle'); errors += 1; return; }
            const base: GameUpdate = { appid: -bundle.bundleId, name: bundle.name, type: 'bundle', isFree: bundle.isFree, availableBr: bundle.availableBr,
              isDelisted: false, headerImage: bundle.headerImage, storeUrl: bundle.storeUrl, priceCents: bundle.priceCents, normalPriceCents: bundle.normalPriceCents,
              discountPercent: bundle.discountPercent, lastStoreAt: new Date().toISOString(), status: 'pending' };
            this.db.upsertGame(base);
            this.db.saveGamePriceHistory(base.appid, base);
            if (bundle.priceCents === null || bundle.priceCents <= 0) { this.db.upsertGame({ ...base, status: 'not_card_game' }); return; }
            const children: GameAnalysis[] = [];
            for (const child of bundle.apps) {
              const store = await this.client.getStoreGame(child.appid);
              if (!store) throw new Error(`Bundle child appdetails unavailable: ${child.appid}`);
              if (!store.hasCards || store.type !== 'game') continue;
              const analysis = await this.analyzeStoreGame(store);
              if (analysis) children.push(analysis);
            }
            cardsAnalyzed += this.saveBundleAnalysis(bundle, children);
            if (children.some((child) => !child.noDrops)) gamesWithCards += 1;
            return;
          }
          const store = await this.client.getStoreGame(app.appid);
          if (!store) {
            this.db.markGameError(app.appid, 'Store appdetails unavailable or delisted');
            errors += 1;
            return;
          }
          const base = this.baseForStore(store, store.hasCards ? 'pending' : 'not_card_game');
          this.db.upsertGame(base);
          this.db.saveGamePriceHistory(store.appid, base);
          const analysis = await this.analyzeStoreGame(store);
          if (!analysis) return;
          if (!analysis.noDrops) { gamesWithCards += 1; cardsAnalyzed += analysis.cards.length; }
          this.saveGameAnalysis(base, analysis);
        } catch (error) {
          errors += 1;
          this.db.markGameError(app.appid, String(error));
          log.warn({ appid: app.appid, error: String(error) }, 'app scan failed; cache preserved where available');
        } finally {
          processedApps += 1;
          // Atualiza o painel a cada aplicativo concluído. Antes, a interface
          // ficava em 0 durante muitos minutos quando os primeiros jogos
          // aguardavam o limite de requisições do Mercado.
          this.db.updateScanProgress(scanId, { apps_cataloged: processedApps, games_with_cards: gamesWithCards, cards_analyzed: cardsAnalyzed, requests: this.client.requests, errors });
          if (processedApps === 1 || processedApps % 25 === 0 || processedApps === apps.length) {
            log.info({ index: processedApps, total: apps.length }, 'scan progress');
          }
        }
      });
      const result = { id: scanId, appsCataloged: apps.length, gamesWithCards, cardsAnalyzed, requests: this.client.requests, errors };
      this.db.finishScan(scanId, { status: errors > 0 && gamesWithCards === 0 ? 'failed' : 'completed', apps_cataloged: apps.length, games_with_cards: gamesWithCards, cards_analyzed: cardsAnalyzed, requests: this.client.requests, errors });
      return result;
    } catch (error) {
      this.db.finishScan(scanId, { status: 'failed', apps_cataloged: apps.length, games_with_cards: gamesWithCards, cards_analyzed: cardsAnalyzed, requests: this.client.requests, errors: errors + 1, message: String(error) });
      throw error;
    }
  }

  async bootstrap(): Promise<ScanResult> {
    const apps = await this.client.getAppList();
    const names = ["Garry's Mod", 'Team Fortress 2', 'PAYDAY 2', "Don't Starve Together", 'Terraria', 'Stardew Valley', 'Dota 2', 'Counter-Strike 2', 'Rust', 'Hollow Knight', 'Brawlhalla', 'PlanetSide 2'];
    const selected = names.map((name) => apps.find((app) => app.name.toLowerCase() === name.toLowerCase())).filter((app): app is AppListEntry => Boolean(app));
    return this.run(selected.length, selected);
  }
}
