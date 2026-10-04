import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const log = pino({ name: 'steam-client' });

export interface StoreGame {
  appid: number; name: string; type: string; isFree: boolean; availableBr: boolean; isDelisted: boolean;
  headerImage: string | null; storeUrl: string; priceCents: number | null; normalPriceCents: number | null;
  discountPercent: number; promoStart: number | null; promoEnd: number | null; hasCards: boolean;
}

export interface StoreBundle {
  bundleId: number; name: string; apps: Array<{ appid: number; name: string }>;
  headerImage: string | null; storeUrl: string; priceCents: number | null; normalPriceCents: number | null;
  discountPercent: number; isFree: boolean; availableBr: boolean;
}

export interface MarketCardSnapshot {
  hashName: string; name: string; iconUrl: string | null; lowestCents: number | null; medianCents: number | null;
  volume: number | null; sellListings: number | null; buyOrderCents: number | null; buyOrderCount: number | null;
  isFoil?: boolean; rarity?: string | null;
}

export interface AppListEntry { appid: number; name: string; type?: string; bundleId?: number; bundleAppids?: number[]; }

interface AppDetailsResponse { [appid: string]: { success: boolean; data?: Record<string, unknown> } }
interface PackageDetailsResponse { [packageid: string]: { success: boolean; data?: Record<string, unknown> } }
interface MarketSearchResponse { success: boolean; total_count?: number; pagesize?: number; results?: Array<Record<string, unknown>>; }
interface StoreSearchResponse { success: number; total_count?: number; start?: number; results_html?: string; }

export function parseSteamMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value !== 'string') return null;
  if (/[€£$]/.test(value) && !/R\$|BRL/i.test(value)) return null;
  const cleaned = value.replace(/[^0-9,.-]/g, '').trim();
  if (!cleaned) return null;
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,(?=\d{3}(?:\D|$))/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function unixFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export class SteamClient {
  private static readonly cardCatalogVersion = 'store-card-filter-v3';
  private nextRequestAt = 0;
  private nextCatalogRequestAt = 0;
  private nextMarketRequestAt = 0;
  private readonly storeCache = new Map<number, StoreGame | null>();
  private readonly marketCache = new Map<number, MarketCardSnapshot[]>();
  private readonly bundleCache = new Map<number, StoreBundle | null>();
  requests = 0;
  errors = 0;

  private async throttle(isMarket = false): Promise<void> {
    const interval = 1000 / (isMarket ? config.marketRequestsPerSecond : config.requestsPerSecond);
    const nextRequestAt = isMarket ? this.nextMarketRequestAt : this.nextRequestAt;
    const now = Date.now();
    const wait = Math.max(0, nextRequestAt - now);
    if (isMarket) this.nextMarketRequestAt = Math.max(now, nextRequestAt) + interval;
    else this.nextRequestAt = Math.max(now, nextRequestAt) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private async throttleCatalog(): Promise<void> {
    const interval = 1000 / config.catalogRequestsPerSecond;
    const now = Date.now();
    const wait = Math.max(0, this.nextCatalogRequestAt - now);
    this.nextCatalogRequestAt = Math.max(now, this.nextCatalogRequestAt) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'User-Agent': config.userAgent, Accept: 'application/json,text/plain,*/*', ...extra };
  }

  private async getJson<T>(url: string, allowRetry = true, bucket: 'default' | 'catalog' = 'default'): Promise<T> {
    if (bucket === 'catalog') await this.throttleCatalog();
    else await this.throttle(url.includes('steamcommunity.com'));
    this.requests += 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < (allowRetry ? 4 : 1); attempt += 1) {
      try {
        const response = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
        if (response.status === 429 || response.status >= 500) throw new Error(`Steam HTTP ${response.status}`);
        if (!response.ok) throw new Error(`Steam HTTP ${response.status}`);
        return await response.json() as T;
      } catch (error) {
        lastError = error;
        this.errors += 1;
        if (attempt < (allowRetry ? 3 : 0)) {
          const delay = String(error).includes('429') ? 65_000 : Math.min(15_000, 500 * 2 ** attempt + Math.round(Math.random() * 250));
          log.warn({ url, attempt, delay, error: String(error) }, 'steam request retry');
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Steam request failed');
  }

  private async getText(url: string, extraHeaders?: Record<string, string>): Promise<string> {
    await this.throttle(true);
    this.requests += 1;
    const response = await fetch(url, { headers: this.headers({ Accept: 'text/html', ...extraHeaders }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { this.errors += 1; throw new Error(`Steam HTTP ${response.status}`); }
    return response.text();
  }

  /**
   * A FAQ oficial expõe a quantidade exata restante somente na página
   * autenticada de insígnias/cartas. Como o valor é específico da conta, o
   * scanner público usa deliberadamente a regra documentada de metade do conjunto.
   */
  async getExactDropsRemaining(appid: number, steamId?: string): Promise<number | null> {
    const hasSession = config.exactDrops && config.sessionId && config.loginSecure;
    if (!hasSession && !steamId) return null;
    try {
      const headers: Record<string, string> = { Referer: 'https://steamcommunity.com/my/badges/' };
      let url = 'https://steamcommunity.com/profiles/' + steamId + '/gamecards/' + appid + '/?l=english';
      if (hasSession) {
        const cookies = 'sessionid=' + encodeURIComponent(config.sessionId) + '; steamLoginSecure=' + encodeURIComponent(config.loginSecure);
        headers.Cookie = cookies;
        url = 'https://steamcommunity.com/my/gamecards/' + appid + '/?l=english';
      }
      const html = await this.getText(url, headers);
      const matches = [
        html.match(/(\d+)\s+card drops?\s+remaining/i),
        html.match(/card drops?\s+remaining[^0-9]{0,80}(\d+)/i),
        html.match(/data-drops-remaining=["'](\d+)/i)
      ];
      const value = matches.find((match) => match)?.[1];
      if (value !== undefined) return Math.max(0, Number(value));
      if (/no\s+card\s+drops?\s+remaining/i.test(html)) return 0;
      log.warn({ appid }, 'exact account drop count was not found on gamecards page');
      return null;
    } catch (error) {
      log.warn({ appid, error: String(error) }, 'exact account drop count unavailable; using half-set estimate');
      return null;
    }
  }

  async getAppList(): Promise<AppListEntry[]> {
    // A lista de aplicativos da Valve sem chave não informa o tipo e pode
    // incluir ferramentas, trilhas sonoras e DLC. Use o catálogo anonymous-PICS,
    // que traz a separação necessária para a varredura somente de jogos.
    const cardCatalogFile = path.resolve(process.cwd(), 'data/card-games.json');
    try {
      const cached = JSON.parse(fs.readFileSync(cardCatalogFile, 'utf8')) as { capturedAt: string; apps: AppListEntry[]; catalogVersion?: string };
      if (cached.catalogVersion === SteamClient.cardCatalogVersion && Date.now() - Date.parse(cached.capturedAt) < 86_400_000 && cached.apps.length) return cached.apps;
    } catch { /* busca um catálogo de cartas atualizado */ }
    try {
      const apps = await this.getCardGameList();
      if (apps.length) {
        fs.mkdirSync(path.dirname(cardCatalogFile), { recursive: true });
        fs.writeFileSync(cardCatalogFile, JSON.stringify({ capturedAt: new Date().toISOString(), catalogVersion: SteamClient.cardCatalogVersion, apps }));
        return apps;
      }
    } catch (error) {
      log.warn({ error: String(error) }, 'store card catalog unavailable; falling back to app catalog');
    }
    const cacheFile = path.resolve(process.cwd(), 'data/catalog.json');
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { capturedAt: string; apps: AppListEntry[]; gamesOnly?: boolean };
      if (cached.gamesOnly && Date.now() - Date.parse(cached.capturedAt) < 86_400_000 && cached.apps.length) return cached.apps;
    } catch { /* ainda não há cache local */ }
    const source = await this.getJson<unknown>(config.catalogUrl);
    const raw = Array.isArray(source) ? source : (source as { apps?: unknown[] })?.apps ?? [];
    const appsWithType = raw.map((app) => {
      const item = app as { appid?: number; name?: string; type?: string };
      return { appid: Number(item.appid), name: String(item.name ?? ''), type: item.type };
    }).filter((app) => Number.isInteger(app.appid) && Boolean(app.name));
    const apps = appsWithType.filter((app) => !app.type || app.type === 'game');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ capturedAt: new Date().toISOString(), gamesOnly: true, apps }));
    return apps;
  }

  private async getCardGameList(): Promise<AppListEntry[]> {
    const apps = new Map<number, AppListEntry>();
    const count = 100;
    let start = 0;
    let total = Infinity;
    do {
      const params = new URLSearchParams({ query: '', start: String(start), count: String(count), dynamic_data: '', sort_by: '_ASC', category2: '29', infinite: '1' });
      const page = await this.getJson<StoreSearchResponse>('https://store.steampowered.com/search/results/?' + params.toString(), true, 'catalog');
      if (page.success !== 1 || !page.results_html) throw new Error('Store card catalog returned no results');
      total = Number(page.total_count ?? 0);
      const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match: RegExpExecArray | null;
      let pageApps = 0;
      while ((match = anchorPattern.exec(page.results_html)) !== null) {
        const opening = match[0].slice(0, match[0].indexOf('>') + 1);
        const itemKey = opening.match(/\bdata-ds-itemkey=["'](App|Sub)_(\d+)["']/i);
        if (!itemKey) continue;
        const titleMatch = match[2].match(/<span\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const name = (titleMatch?.[1] ?? match[2]).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
        const id = Number(itemKey[2]);
        if (itemKey[1].toLowerCase() === 'app' && Number.isInteger(id) && id > 0) {
          apps.set(id, { appid: id, name: name || 'App ' + id, type: 'game' });
          pageApps += 1;
        } else if (itemKey[1].toLowerCase() === 'sub' && Number.isInteger(id) && id > 0) {
          const appids = opening.match(/\bdata-ds-appid=["']([^"']+)["']/i)?.[1]
            ?.split(',').map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0) ?? [];
          apps.set(-id, { appid: -id, name: name || 'Bundle ' + id, type: 'bundle', bundleId: id, bundleAppids: appids });
          pageApps += 1;
        }
      }
      if (pageApps === 0 && start > 0) break;
      start += count;
      if (start >= total) break;
    } while (start < 50_000);
    return [...apps.values()];
  }

  async getStoreGame(appid: number): Promise<StoreGame | null> {
    if (this.storeCache.has(appid)) return this.storeCache.get(appid) ?? null;
    const response = await this.getJson<AppDetailsResponse>(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=br&l=brazilian`);
    const result = response[String(appid)];
    if (!result?.success || !result.data) { this.storeCache.set(appid, null); return null; }
    const data = result.data;
    const type = typeof data.type === 'string' ? data.type : 'unknown';
    const price = data.price_overview as Record<string, unknown> | undefined;
    const packageGroups = Array.isArray(data.package_groups) ? data.package_groups as Array<Record<string, unknown>> : [];
    const packageSubs = packageGroups.flatMap((group) => Array.isArray(group.subs) ? group.subs as Array<Record<string, unknown>> : []);
    const pricedSubs = packageSubs.map((sub) => Number(sub.price_in_cents_with_discount)).filter(Number.isFinite);
    const finalPrice = price ? Number(price.final) : pricedSubs.length ? Math.min(...pricedSubs) : null;
    const initialPrice = price ? Number(price.initial) : finalPrice;
    const categoryList = Array.isArray(data.categories) ? data.categories as Array<Record<string, unknown>> : [];
    const hasCards = categoryList.some((category) => Number(category.id) === 29);
    const release = data.release_date as Record<string, unknown> | undefined;
    const comingSoon = Boolean(release?.coming_soon);
    const isFree = Boolean(data.is_free);
    const available = !comingSoon && Boolean(price || pricedSubs.length || isFree) && type === 'game';
    const discounts = price ? Number(price.discount_percent ?? 0) : initialPrice && finalPrice !== null ? Math.max(0, Math.round((1 - finalPrice / initialPrice) * 100)) : 0;
    const game = {
      appid, name: typeof data.name === 'string' ? data.name : `App ${appid}`, type, isFree, availableBr: available,
      isDelisted: !price && !pricedSubs.length && !isFree, headerImage: typeof data.header_image === 'string' ? data.header_image : null,
      storeUrl: `https://store.steampowered.com/app/${appid}/`, priceCents: isFree ? 0 : Number.isFinite(finalPrice) ? finalPrice : null,
      normalPriceCents: isFree ? 0 : Number.isFinite(initialPrice) ? initialPrice : null, discountPercent: Number.isFinite(discounts) ? discounts : 0,
      promoStart: unixFromUnknown(data.sale_start), promoEnd: unixFromUnknown(data.sale_end), hasCards
    };
    this.storeCache.set(appid, game);
    return game;
  }

  async getStoreBundle(bundleId: number): Promise<StoreBundle | null> {
    if (this.bundleCache.has(bundleId)) return this.bundleCache.get(bundleId) ?? null;
    const response = await this.getJson<PackageDetailsResponse>(`https://store.steampowered.com/api/packagedetails?packageids=${bundleId}&cc=br&l=brazilian`);
    const result = response[String(bundleId)];
    if (!result?.success || !result.data) { this.bundleCache.set(bundleId, null); return null; }
    const data = result.data;
    const apps = (Array.isArray(data.apps) ? data.apps : []).map((item) => {
      const value = item as Record<string, unknown>;
      return { appid: Number(value.id), name: typeof value.name === 'string' ? value.name : `App ${value.id ?? ''}` };
    }).filter((app) => Number.isInteger(app.appid) && app.appid > 0);
    const uniqueApps = [...new Map(apps.map((app) => [app.appid, app])).values()];
    if (uniqueApps.length < 2) { this.bundleCache.set(bundleId, null); return null; }
    const price = data.price as Record<string, unknown> | undefined;
    const finalPrice = price && Number.isFinite(Number(price.final)) ? Number(price.final) : null;
    const initialPrice = price && Number.isFinite(Number(price.initial)) ? Number(price.initial) : finalPrice;
    const isFree = finalPrice === 0;
    const bundle = {
      bundleId, name: typeof data.name === 'string' ? data.name : `Bundle ${bundleId}`, apps: uniqueApps,
      headerImage: typeof data.header_image === 'string' ? data.header_image : null,
      storeUrl: `https://store.steampowered.com/sub/${bundleId}/`, priceCents: isFree ? 0 : finalPrice,
      normalPriceCents: isFree ? 0 : initialPrice, discountPercent: price ? Number(price.discount_percent ?? 0) : 0,
      isFree, availableBr: finalPrice !== null
    };
    this.bundleCache.set(bundleId, bundle);
    return bundle;
  }

  private async getMarketCardResults(appid: number, foil: boolean): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    let start = 0;
    let total = Infinity;
    do {
      const params = new URLSearchParams({ appid: '753', norender: '1', count: '100', start: String(start), sort_column: 'price', sort_dir: 'asc', country: 'BR', currency: '7' });
      params.append('category_753_Game[]', `tag_app_${appid}`);
      params.append('category_753_item_class[]', 'tag_item_class_2');
      params.append('category_753_cardborder[]', `tag_cardborder_${foil ? 1 : 0}`);
      const response = await this.getJson<MarketSearchResponse>(`https://steamcommunity.com/market/search/render/?${params.toString()}`);
      if (!response.success) throw new Error(`falha na busca do mercado para ${appid}`);
      const page = response.results ?? [];
      total = Number(response.total_count ?? 0);
      results.push(...page);
      if (!page.length) break;
      start += page.length;
      if (page.length < Number(response.pagesize ?? 10)) break;
    } while (start < total && start < 100);
    return results;
  }

  async getMarketCards(appid: number): Promise<MarketCardSnapshot[]> {
    if (this.marketCache.has(appid)) return this.marketCache.get(appid) ?? [];
    const [normalResponse, foilResponse] = await Promise.allSettled([
      this.getMarketCardResults(appid, false),
      this.getMarketCardResults(appid, true)
    ]);
    if (normalResponse.status === 'rejected') throw normalResponse.reason;
    const normalResults = normalResponse.value;
    const foilResults = foilResponse.status === 'fulfilled' ? foilResponse.value : [];
    if (foilResponse.status === 'rejected') {
      log.warn({ appid, error: String(foilResponse.reason) }, 'foil market search unavailable; continuing with normal cards');
    }
    const results = [
      ...normalResults.map((result) => ({ result, foil: false })),
      ...foilResults.map((result) => ({ result, foil: true }))
    ];

    const cards: MarketCardSnapshot[] = [];
    for (const entry of results) {
      const result = entry.result;
      const description = (result.asset_description ?? {}) as Record<string, unknown>;
      const hashName = typeof result.hash_name === 'string' ? result.hash_name : '';
      const itemType = String(description.type ?? result.name ?? '');
      const cardName = typeof result.name === 'string' ? result.name : hashName;
      const isFoil = entry.foil || /foil/i.test(itemType) || /foil/i.test(cardName) || /\(Foil\)$/i.test(hashName);
      if (!hashName) continue;
      const tags = Array.isArray(description.tags) ? description.tags as Array<Record<string, unknown>> : [];
      const rarityTag = tags.find((tag) => /rarity|raridade|quality|qualidade|tier/i.test(String(tag.category ?? tag.name ?? '')));
      const rarityValue = rarityTag?.localized_tag_name ?? rarityTag?.name;
      const rarity = isFoil ? 'Foil' : typeof rarityValue === 'string' && /super|ultra|legend|lendár|rare|raro|epic|épico|mythic|mítico/i.test(rarityValue) ? rarityValue : null;
      let overview: { success?: boolean; lowest_price?: string; median_price?: string; volume?: string } = {};
      if (config.marketPriceDetails) {
        try {
          overview = await this.getJson<{ success?: boolean; lowest_price?: string; median_price?: string; volume?: string }>(
            `https://steamcommunity.com/market/priceoverview/?appid=753&currency=7&country=BR&market_hash_name=${encodeURIComponent(hashName)}`, false
          );
        } catch (error) {
          // Uma carta pode sofrer limitação de requisições ou ficar
          // temporariamente indisponível. Mantém o conjunto e a cobertura do
          // score em vez de descartar o jogo inteiro.
          log.warn({ appid, hashName, error: String(error) }, 'card price unavailable; continuing with partial set');
        }
      }
      // Os resultados da busca já incluem o menor preço de venda na moeda
      // solicitada. Use-o como fallback quando priceoverview sofrer limitação;
      // mediana/volume continuam desconhecidos em vez de serem inventados.
      const searchLowestCents = parseSteamMoney(result.sell_price_text) ??
        (Number.isFinite(Number(result.sell_price)) ? Number(result.sell_price) : null);
      let buyOrderCents: number | null = null;
      let buyOrderCount: number | null = null;
      if (config.marketBuyOrders && config.sessionId && config.loginSecure) {
        const order = await this.getBuyOrder(hashName);
        buyOrderCents = order.priceCents;
        buyOrderCount = order.count;
      }
      const iconToken = typeof description.icon_url === 'string' ? description.icon_url : null;
      cards.push({
        hashName, name: cardName, iconUrl: iconToken ? `https://community.fastly.steamstatic.com/economy/image/${iconToken}/96fx96f` : null,
        lowestCents: parseSteamMoney(overview.lowest_price) ?? searchLowestCents, medianCents: parseSteamMoney(overview.median_price),
        volume: overview.volume && /^\d+$/.test(overview.volume) ? Number(overview.volume) : null,
        sellListings: Number.isFinite(Number(result.sell_listings)) ? Number(result.sell_listings) : null, buyOrderCents, buyOrderCount, isFoil, rarity
      });
    }
    this.marketCache.set(appid, cards);
    return cards;
  }

  private async getBuyOrder(hashName: string): Promise<{ priceCents: number | null; count: number | null }> {
    try {
      const urlName = encodeURIComponent(hashName);
      const html = await this.getText(`https://steamcommunity.com/market/listings/753/${urlName}`);
      const match = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
      if (!match) return { priceCents: null, count: null };
      const cookies = `sessionid=${encodeURIComponent(config.sessionId)}; steamLoginSecure=${encodeURIComponent(config.loginSecure)}`;
      const response = await fetch(`https://steamcommunity.com/market/itemordershistogram?norender=1&country=BR&language=brazilian&currency=7&item_nameid=${match[1]}`, { headers: this.headers({ Cookie: cookies, Referer: `https://steamcommunity.com/market/listings/753/${urlName}` }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return { priceCents: null, count: null };
      const data = await response.json() as { highest_buy_order?: string | number; buy_order_count?: string | number };
      const raw = Number(data.highest_buy_order);
      return { priceCents: Number.isFinite(raw) ? Math.round(raw) : null, count: Number.isFinite(Number(data.buy_order_count)) ? Number(data.buy_order_count) : null };
    } catch (error) {
      log.warn({ hashName, error: String(error) }, 'buy order unavailable');
      return { priceCents: null, count: null };
    }
  }
}
