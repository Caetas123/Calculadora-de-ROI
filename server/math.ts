export interface CardForMath {
  lowest_cents: number | null;
  buy_order_cents?: number | null;
}

export interface DropDistribution {
  expectedGrossCents: number;
  expectedSellCents: number;
  expectedInstantCents: number | null;
  worstCents: number;
  bestCents: number;
  medianCents: number;
  coverage: number;
}

export interface MetricsInput {
  cards: CardForMath[];
  drops: number;
  priceCents: number | null;
}

/** As taxas são representadas em pontos-base para evitar desvios de ponto flutuante. */
export function feeCents(baseCents: number, rateBps: number): number {
  if (baseCents <= 0) return 0;
  return Math.max(1, Math.floor((baseCents * rateBps) / 10_000));
}

export function grossFromSellerCents(sellerCents: number, publisherFeeBps = 1_000): number {
  if (sellerCents <= 0) return 0;
  return sellerCents + feeCents(sellerCents, 500) + feeCents(sellerCents, publisherFeeBps);
}

/**
 * O mercado da Steam exibe o total pago pelo comprador. Esta função inverte
 * o cálculo das taxas sobre o valor-base do vendedor, incluindo o mínimo de
 * um centavo para cada taxa.
 */
export function sellerPayoutFromBuyerCents(buyerCents: number, publisherFeeBps = 1_000): number {
  if (buyerCents <= 0) return 0;
  let low = 0;
  let high = buyerCents;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (grossFromSellerCents(mid, publisherFeeBps) <= buyerCents) low = mid;
    else high = mid - 1;
  }
  return low;
}

function quantile(values: Map<number, number>, q: number): number {
  const entries = [...values.entries()].sort((a, b) => a[0] - b[0]);
  let cumulative = 0;
  for (const [value, probability] of entries) {
    cumulative += probability;
    if (cumulative >= q) return value;
  }
  const last = entries[entries.length - 1];
  return last ? last[0] : 0;
}

function sumDistribution(values: number[], drops: number): Map<number, number> {
  let distribution = new Map<number, number>([[0, 1]]);
  for (let i = 0; i < drops; i += 1) {
    const next = new Map<number, number>();
    for (const [subtotal, probability] of distribution) {
      for (const value of values) {
        next.set(subtotal + value, (next.get(subtotal + value) ?? 0) + probability / values.length);
      }
    }
    distribution = next;
  }
  return distribution;
}

export function calculateDrops(cardSetSize: number): number {
  return cardSetSize > 0 ? Math.ceil(cardSetSize / 2) : 0;
}

export function calculateDropDistribution(
  cards: CardForMath[],
  drops: number,
  publisherFeeBps = 1_000
): DropDistribution | null {
  const priced = cards.filter((card): card is CardForMath & { lowest_cents: number } =>
    Number.isInteger(card.lowest_cents) && (card.lowest_cents as number) >= 0
  );
  if (!priced.length || drops <= 0) return null;
  const gross = priced.map((card) => card.lowest_cents);
  const sell = gross.map((cents) => sellerPayoutFromBuyerCents(cents, publisherFeeBps));
  const instantValues = priced
    .map((card) => card.buy_order_cents)
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0)
    .map((value) => sellerPayoutFromBuyerCents(value, publisherFeeBps));
  const sellDistribution = sumDistribution(sell, drops);
  const expectedGrossCents = Math.round(gross.reduce((sum, value) => sum + value, 0) / gross.length * drops);
  const expectedSellCents = Math.round(sell.reduce((sum, value) => sum + value, 0) / sell.length * drops);
  const expectedInstantCents = instantValues.length === priced.length
    ? Math.round(instantValues.reduce((sum, value) => sum + value, 0) / instantValues.length * drops)
    : null;
  return {
    expectedGrossCents,
    expectedSellCents,
    expectedInstantCents,
    worstCents: Math.min(...sell) * drops,
    bestCents: Math.max(...sell) * drops,
    medianCents: quantile(sellDistribution, 0.5),
    coverage: priced.length / cards.length
  };
}

export function calculateRoiBps(profitCents: number | null, priceCents: number | null): number | null {
  if (profitCents === null || priceCents === null || priceCents <= 0) return null;
  return Math.round((profitCents * 10_000) / priceCents);
}

export function labelForScore(score: number | null): string {
  if (score === null) return 'Unknown';
  if (score >= 85) return 'Very High';
  if (score >= 70) return 'High';
  if (score >= 45) return 'Medium';
  return 'Low';
}

export function calculateLiquidity(cards: Array<{ volume: number | null; sell_listings: number | null; buy_order_cents?: number | null }>): { score: number; label: string } {
  if (!cards.length) return { score: 0, label: 'Unknown' };
  const available = cards.filter((card) => card.volume !== null || card.sell_listings !== null);
  if (!available.length) return { score: 8, label: 'Low' };
  const avgVolume = available.reduce((s, c) => s + (c.volume ?? 0), 0) / available.length;
  const avgListings = available.reduce((s, c) => s + (c.sell_listings ?? 0), 0) / available.length;
  const volumeScore = Math.min(100, Math.log10(avgVolume + 1) / 3 * 100);
  const listingScore = Math.min(100, Math.log10(avgListings + 1) / 4 * 100);
  const buyCoverage = cards.filter((c) => c.buy_order_cents !== null && c.buy_order_cents !== undefined).length / cards.length;
  const score = Math.round(Math.max(0, Math.min(100, volumeScore * 0.55 + listingScore * 0.25 + buyCoverage * 20)));
  return { score, label: labelForScore(score) };
}

export function calculateConfidence(input: {
  storeConfirmed: boolean;
  setComplete: boolean;
  pricedCards: number;
  totalCards: number;
  liquidityScore: number;
  ageHours: number;
  stale: boolean;
}): { score: number; label: string } {
  const freshness = input.ageHours <= 1 ? 30 : input.ageHours <= 6 ? 24 : input.ageHours <= 24 ? 17 : input.ageHours <= 72 ? 10 : 3;
  let score = (input.storeConfirmed ? 20 : 0) + (input.setComplete ? 20 : 10) +
    (input.totalCards ? Math.round((input.pricedCards / input.totalCards) * 20) : 0) +
    Math.round(input.liquidityScore * 0.1) + freshness;
  if (input.stale) score -= 15;
  score = Math.max(0, Math.min(100, score));
  return { score, label: labelForScore(score) };
}

export function calculateOpportunityScore(roiBps: number | null, profitCents: number | null, liquidity: number | null, confidence: number | null): number | null {
  if (roiBps === null || profitCents === null || liquidity === null || confidence === null) return null;
  const roi = Math.max(0, Math.min(250, roiBps / 100));
  const profit = Math.max(0, Math.min(1000, profitCents)) / 1000;
  const health = Math.min(liquidity, confidence) / 100;
  return Math.round((0.45 * roi / 250 * health + 0.25 * profit * health + 0.20 * liquidity / 100 + 0.10 * confidence / 100) * 100);
}

export function calculateMetrics(input: MetricsInput, publisherFeeBps = 1_000) {
  const distribution = calculateDropDistribution(input.cards, input.drops, publisherFeeBps);
  if (!distribution) return null;
  const profitCents = input.priceCents === null ? null : distribution.expectedSellCents - input.priceCents;
  const instantProfitCents = input.priceCents === null || distribution.expectedInstantCents === null
    ? null : distribution.expectedInstantCents - input.priceCents;
  return {
    ...distribution,
    profitCents,
    roiBps: calculateRoiBps(profitCents, input.priceCents),
    instantProfitCents,
    instantRoiBps: calculateRoiBps(instantProfitCents, input.priceCents)
  };
}
