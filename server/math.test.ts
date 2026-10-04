import { describe, expect, it } from 'vitest';
import { calculateConfidence, calculateDropDistribution, calculateDrops, calculateLiquidity, calculateMetrics, calculateOpportunityScore, feeCents, grossFromSellerCents, sellerPayoutFromBuyerCents } from './math.js';

describe('Steam cent-aware market fees', () => {
  it.each([[3, 1], [5, 3], [10, 8]])('keeps tiny buyer price %i cents -> seller payout %i cents', (buyer, expected) => {
    expect(sellerPayoutFromBuyerCents(buyer)).toBe(expected);
  });
  it('uses one cent minimum for each fee and floors percentage fees', () => {
    expect(feeCents(3, 500)).toBe(1);
    expect(feeCents(3, 1000)).toBe(1);
    expect(grossFromSellerCents(88)).toBe(100);
    expect(sellerPayoutFromBuyerCents(100)).toBe(88);
  });
  it('round trips normal values without applying a naive 0.85 multiplier', () => {
    for (const seller of [1, 5, 10, 88, 100, 999, 10_000]) expect(sellerPayoutFromBuyerCents(grossFromSellerCents(seller))).toBe(seller);
  });
});

describe('drop model', () => {
  it('uses half the set rounded up', () => {
    expect(calculateDrops(0)).toBe(0);
    expect(calculateDrops(5)).toBe(3);
    expect(calculateDrops(6)).toBe(3);
    expect(calculateDrops(8)).toBe(4);
    expect(calculateDrops(15)).toBe(8);
  });
  it('models duplicates and exposes distribution bounds', () => {
    const result = calculateDropDistribution([{ lowest_cents: 100 }, { lowest_cents: 300 }], 3);
    expect(result).not.toBeNull();
    expect(result?.expectedGrossCents).toBe(600);
    expect(result?.worstCents).toBe(3 * sellerPayoutFromBuyerCents(100));
    expect(result?.bestCents).toBe(3 * sellerPayoutFromBuyerCents(300));
    expect(result?.medianCents).toBeGreaterThan(result?.worstCents ?? 0);
  });
  it('does not fabricate instant sell when buy orders are incomplete', () => {
    const result = calculateMetrics({ cards: [{ lowest_cents: 100, buy_order_cents: 80 }, { lowest_cents: 100 }], drops: 1, priceCents: 50 });
    expect(result?.expectedInstantCents).toBeNull();
    expect(result?.roiBps).toBeGreaterThan(0);
  });
});

describe('ranking quality', () => {
  it('penalizes empty liquidity and scores healthy volume', () => {
    const low = calculateLiquidity([{ volume: 0, sell_listings: 0 }]);
    const high = calculateLiquidity([{ volume: 1000, sell_listings: 1000, buy_order_cents: 50 }]);
    expect(low.score).toBeLessThan(high.score);
    expect(high.label).toMatch(/High|Very High/);
  });
  it('caps suspicious ROI instead of letting it dominate opportunity score', () => {
    const suspicious = calculateOpportunityScore(500_000, 500_000, 8, 20);
    const liquid = calculateOpportunityScore(15_000, 250, 90, 90);
    expect(suspicious).toBeLessThan(100);
    expect(liquid).toBeGreaterThan(suspicious ?? 0);
  });
  it('lowers confidence for stale incomplete records', () => {
    const fresh = calculateConfidence({ storeConfirmed: true, setComplete: true, pricedCards: 8, totalCards: 8, liquidityScore: 80, ageHours: 1, stale: false });
    const stale = calculateConfidence({ storeConfirmed: false, setComplete: false, pricedCards: 2, totalCards: 8, liquidityScore: 5, ageHours: 120, stale: true });
    expect(fresh.score).toBeGreaterThan(stale.score);
    expect(stale.label).toBe('Low');
  });
});
