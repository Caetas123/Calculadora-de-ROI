import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from './api.js';
import { StoreDb } from './db.js';

describe('API integration', () => {
  const db = new StoreDb(':memory:');
  const app = createApp(db);
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    db.upsertGame({ appid: 999001, name: 'Integration Game', type: 'game', isFree: false, availableBr: true, isDelisted: false,
      priceCents: 100, normalPriceCents: 500, discountPercent: 80, cardsCount: 2, drops: 1, expectedGrossCents: 200, expectedSellCents: 170,
      expectedInstantCents: 150, worstCents: 100, bestCents: 300, medianCents: 170, profitCents: 70, roiBps: 7000, instantProfitCents: 50,
      instantRoiBps: 5000, liquidityScore: 80, liquidityLabel: 'High', confidenceScore: 90, confidenceLabel: 'Very High', opportunityScore: 75,
      status: 'ready', lastStoreAt: new Date().toISOString(), lastMarketAt: new Date().toISOString() });
    db.upsertCard({ appid: 999001, hashName: '999001-Card A', name: 'Card A', lowestCents: 100, medianCents: 120, volume: 50, sellListings: 100, sourceUpdatedAt: new Date().toISOString() });
    db.upsertCard({ appid: 999001, hashName: '999001-Card A-Foil', name: 'Card A (Foil)', isFoil: true, rarity: 'Foil', lowestCents: 450, medianCents: 500, volume: 4, sellListings: 6, sourceUpdatedAt: new Date().toISOString() });
  });
  afterAll(() => server.close());

  it('returns health, stats and filtered opportunities', async () => {
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    const stats = await (await fetch(`${baseUrl}/api/stats`)).json() as { gamesAnalyzed: number; totalCards: number };
    expect(stats.gamesAnalyzed).toBe(1);
    expect(stats.totalCards).toBe(1);
    const body = await (await fetch(`${baseUrl}/api/opportunities?positive=1&roiMin=50&page=1&pageSize=1`)).json() as { data: Array<{ appid: number }>; total: number };
    expect(body.data[0].appid).toBe(999001);
    expect(body.total).toBe(1);
  });

  it('returns details and a CSV export', async () => {
    const detail = await (await fetch(`${baseUrl}/api/games/999001`)).json() as { cards: Array<{ hash_name: string }>; special_cards: Array<{ hash_name: string; is_foil: boolean }> };
    expect(detail.cards[0].hash_name).toContain('Card A');
    expect(detail.special_cards).toHaveLength(1);
    expect(detail.special_cards[0].is_foil).toBe(true);
    const csv = await (await fetch(`${baseUrl}/api/export.csv`)).text();
    expect(csv).toContain('Integration Game');
    expect(csv).toContain('ROI');
  });
});
