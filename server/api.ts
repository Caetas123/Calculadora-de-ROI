import express from 'express';
import cors from 'cors';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { config } from './config.js';
import { StoreDb } from './db.js';
import { Scanner } from './scanner.js';
import { SteamClient } from './steam.js';
import type { Opportunity } from '../shared/types.js';

const log = pino({ name: 'api' });

function queryObject(query: express.Request['query']): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, Array.isArray(value) ? String(value[0]) : value === undefined ? undefined : String(value)]));
}

function money(cents: number | null): string { return cents === null ? '' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`; }
function csvCell(value: unknown): string { return `"${String(value ?? '').replaceAll('"', '""')}"`; }

const authCookieName = 'steam_auth';
const authMaxAge = 30 * 24 * 60 * 60;

function signedAuthValue(steamId: string): string {
  const payload = steamId + '.' + Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', config.authCookieSecret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function steamIdFromRequest(req: express.Request): string | null {
  const raw = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(authCookieName + '='));
  if (!raw) return null;
  const encoded = raw.slice(authCookieName.length + 1);
  try {
    const value = decodeURIComponent(encoded);
    const parts = value.split('.');
    if (parts.length !== 3 || !/^\d{17}$/.test(parts[0])) return null;
    const payload = parts[0] + '.' + parts[1];
    const expected = createHmac('sha256', config.authCookieSecret).update(payload).digest('base64url');
    const actualBuffer = Buffer.from(parts[2]);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    if (Math.floor(Date.now() / 1000) - Number(parts[1]) > authMaxAge) return null;
    return parts[0];
  } catch { return null; }
}

function setAuthCookie(res: express.Response, steamId: string): void {
  const value = encodeURIComponent(signedAuthValue(steamId));
  res.setHeader('Set-Cookie', authCookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + authMaxAge);
}

export function createApp(db: StoreDb): express.Express {
  const app = express();
  let scanRunning = false;
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/auth/steam', (_req, res) => {
    const returnTo = config.publicBaseUrl + '/auth/steam/callback';
    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo,
      'openid.realm': config.publicBaseUrl,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });
    return res.redirect('https://steamcommunity.com/openid/login?' + params.toString());
  });

  app.get('/auth/steam/callback', async (req, res) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') params.set(key, value);
      else if (Array.isArray(value) && value[0] !== undefined) params.set(key, String(value[0]));
    }
    if (params.get('openid.mode') === 'cancel') return res.redirect('/?steam=cancelled');
    const claimedId = params.get('openid.claimed_id') ?? '';
    const steamId = claimedId.match(/\/id\/(\d+)\/?$/)?.[1];
    if (params.get('openid.mode') !== 'id_res' || !steamId) return res.status(400).send('O login com a Steam não foi concluído.');
    const verification = new URLSearchParams(params);
    verification.set('openid.mode', 'check_authentication');
    try {
      const response = await fetch('https://steamcommunity.com/openid/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.userAgent },
        body: verification.toString(),
        signal: AbortSignal.timeout(20_000)
      });
      const body = await response.text();
      if (!response.ok || !/is_valid\s*:\s*true/i.test(body)) return res.status(401).send('Não foi possível verificar o login com a Steam.');
    } catch (error) {
      log.warn({ error: String(error) }, 'Falha na verificação do OpenID da Steam');
      return res.status(502).send('O login com a Steam está temporariamente indisponível.');
    }
    setAuthCookie(res, steamId);
    return res.redirect('/?steam=connected');
  });

  app.get('/auth/steam/logout', (_req, res) => {
    res.setHeader('Set-Cookie', authCookieName + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return res.redirect('/');
  });

  app.get('/api/auth/me', (req, res) => {
    const steamId = steamIdFromRequest(req);
    return res.json({ authenticated: Boolean(steamId), steamid: steamId });
  });

  app.get('/api/account/drops/:appid', async (req, res) => {
    const steamId = steamIdFromRequest(req);
    if (!steamId) return res.status(401).json({ authenticated: false, error: 'login_required' });
    const appid = Number(req.params.appid);
    if (!Number.isInteger(appid) || appid <= 0) return res.status(400).json({ error: 'invalid_appid' });
    const drops = await new SteamClient().getExactDropsRemaining(appid, steamId);
    return res.json({ authenticated: true, steamid: steamId, drops, exact: drops !== null, source: drops === null ? 'unavailable' : 'steam_gamecards' });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));
  app.get('/api/stats', (_req, res) => res.json(db.stats()));
  app.get('/api/scans/latest', (_req, res) => res.json(db.latestScan()));
  app.get('/api/opportunities', (req, res) => res.json(db.listOpportunitiesPage(queryObject(req.query))));
  app.get('/api/games', (req, res) => res.json({ data: db.listOpportunities(queryObject(req.query)) }));
  app.get('/api/opportunities/top', (req, res) => {
    const query = { ...queryObject(req.query), limit: String(Math.min(20, Number(req.query.limit ?? 20))) };
    res.json({ data: db.listOpportunities(query) });
  });
  app.get('/api/games/:appid', (req, res) => {
    const game = db.getOpportunity(Number(req.params.appid));
    if (!game) return res.status(404).json({ error: 'Jogo não encontrado' });
    return res.json(game);
  });
  app.get('/api/cards/:appid', (req, res) => res.json({ data: db.getCards(Number(req.params.appid)) }));
  app.get('/api/games/:appid/history', (req, res) => res.json({ data: db.getGameHistory(Number(req.params.appid), Number(req.query.limit ?? 90)) }));
  app.get('/api/market/cards/:appid/:hashName/history', (req, res) => res.json({ data: db.getMarketHistory(Number(req.params.appid), req.params.hashName, Number(req.query.limit ?? 90)) }));
  app.get('/api/export.json', (_req, res) => res.json(db.exportRows()));
  app.get('/api/export.csv', (_req, res) => {
    const rows = db.exportRows();
    const fields: Array<keyof Opportunity> = ['appid', 'name', 'price_cents', 'discount_percent', 'cards_count', 'drops', 'drops_source', 'expected_sell_cents', 'profit_cents', 'roi_bps', 'instant_roi_bps', 'liquidity_label', 'confidence_score', 'opportunity_score', 'last_market_at'];
    const labels: Partial<Record<keyof Opportunity, string>> = { appid: 'AppID', name: 'Game', price_cents: 'Price', discount_percent: 'Discount %', cards_count: 'Set cards', drops: 'Normal drops', drops_source: 'Drops source', expected_sell_cents: 'Expected net', profit_cents: 'Profit', roi_bps: 'ROI', instant_roi_bps: 'Instant ROI', liquidity_label: 'Liquidity', confidence_score: 'Confidence', opportunity_score: 'Opportunity score', last_market_at: 'Market updated' };
    const header = fields.map((field) => labels[field] ?? field).join(';');
    const body = rows.map((row) => fields.map((field) => csvCell(field.endsWith('_cents') ? money(row[field] as number | null) : field === 'roi_bps' || field === 'instant_roi_bps' ? row[field] === null ? '' : `${((row[field] as number) / 100).toFixed(2)}%` : row[field])).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="steam-card-roi.csv"');
    return res.send(`\ufeff${header}\n${body}`);
  });
  app.post('/api/scan', (req, res) => {
    if (scanRunning || db.latestScan()?.status === 'running') return res.status(409).json({ error: 'Já existe uma varredura em execução' });
    const rawLimit = Number(req.body?.limit ?? config.catalogScanLimit);
    const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : config.catalogScanLimit;
    scanRunning = true;
    void new Scanner(db, undefined, config.concurrency).run(limit).then((result) => log.info({ result }, 'scan completed')).catch((error) => log.error({ error: String(error) }, 'scan failed')).finally(() => { scanRunning = false; });
    return res.status(202).json({ started: true, limit });
  });

  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
  app.use(express.static(clientDist));
  app.use((_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  return app;
}

export async function startServer(): Promise<void> {
  const db = new StoreDb(config.databasePath);
  const app = createApp(db);
  app.listen(config.port, () => log.info({ port: config.port, database: config.databasePath }, 'server listening'));
  if (db.stats().totalCataloged === 0) {
    log.info('empty database; starting live bootstrap');
    void new Scanner(db, undefined, config.concurrency).bootstrap().then((result) => log.info({ result }, 'live bootstrap completed')).catch((error) => log.error({ error: String(error) }, 'live bootstrap failed'));
  }
  if (config.autoScanIntervalMinutes > 0) {
    const interval = setInterval(() => {
      if (db.latestScan()?.status === 'running') return;
      void new Scanner(db, undefined, config.concurrency).run(config.catalogScanLimit).then((result) => log.info({ result }, 'scheduled scan completed')).catch((error) => log.warn({ error: String(error) }, 'scheduled scan failed'));
    }, config.autoScanIntervalMinutes * 60_000);
    interval.unref();
  }
}
