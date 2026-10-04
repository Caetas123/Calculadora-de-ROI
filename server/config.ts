import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: numberEnv('PORT', 3000),
  databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/steam-roi.sqlite'),
  userAgent: process.env.STEAM_USER_AGENT ?? 'SteamCardROI/1.0',
  catalogUrl: process.env.CATALOG_URL ?? 'https://raw.githubusercontent.com/Austrum-lab/steam-appdb/master/data/all.json',
  requestsPerSecond: Math.max(0.2, numberEnv('STEAM_REQUESTS_PER_SECOND', 1.5)),
  catalogRequestsPerSecond: Math.max(0.1, numberEnv('STEAM_CATALOG_REQUESTS_PER_SECOND', 0.25)),
  marketRequestsPerSecond: Math.max(0.1, numberEnv('STEAM_MARKET_REQUESTS_PER_SECOND', 0.25)),
  marketPriceDetails: process.env.STEAM_MARKET_PRICE_DETAILS === 'true',
  concurrency: Math.max(1, Math.floor(numberEnv('STEAM_CONCURRENCY', 3))),
  catalogScanLimit: Math.max(0, Math.floor(numberEnv('CATALOG_SCAN_LIMIT', 100))),
  marketTtlMinutes: Math.max(15, numberEnv('MARKET_SCAN_TTL_MINUTES', 180)),
  storeTtlMinutes: Math.max(15, numberEnv('STORE_SCAN_TTL_MINUTES', 60)),
  metadataTtlHours: Math.max(1, numberEnv('METADATA_TTL_HOURS', 168)),
  autoScanIntervalMinutes: Math.max(0, numberEnv('AUTO_SCAN_INTERVAL_MINUTES', 0)),
  marketBuyOrders: process.env.STEAM_MARKET_BUY_ORDERS === 'true',
  defaultPublisherFeeBps: Math.max(0, numberEnv('DEFAULT_PUBLISHER_FEE_BPS', 1_000)),
  sessionId: process.env.STEAM_SESSION_ID ?? '',
  loginSecure: process.env.STEAM_LOGIN_SECURE ?? '',
  exactDrops: process.env.STEAM_EXACT_DROPS === 'true',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  authCookieSecret: process.env.AUTH_COOKIE_SECRET || randomBytes(32).toString('hex')
};
