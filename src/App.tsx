import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardStats, MarketCard, Opportunity, OpportunityPage, ScanSummary } from '../shared/types';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const number = new Intl.NumberFormat('pt-BR');

function money(cents: number | null): string { return cents === null ? '—' : brl.format(cents / 100); }
function percent(bps: number | null): string { return bps === null ? '—' : `${(bps / 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`; }
function shortDate(value: string | null): string { return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function scoreTone(score: number | null): string { return score === null ? 'muted' : score >= 85 ? 'green' : score >= 70 ? 'blue' : score >= 45 ? 'amber' : 'red'; }

type Filters = { search: string; sort: string; promotion: boolean; positive: boolean; priceMax: string; priceMin: string; roiMin: string; profitMin: string; discountMin: string; dropsMin: string; cardsMin: string; liquidityMin: string; updatedOnly: boolean; excludeFree: boolean; excludeUnavailable: boolean };
const initialFilters: Filters = { search: '', sort: 'roi', promotion: false, positive: false, priceMax: '', priceMin: '', roiMin: '', profitMin: '', discountMin: '', dropsMin: '', cardsMin: '', liquidityMin: '', updatedOnly: false, excludeFree: true, excludeUnavailable: false };
const sortOptions = [{ value: 'roi', label: 'Maior ROI' }, { value: 'profit', label: 'Maior lucro' }, { value: 'price', label: 'Menor preço' }, { value: 'expected', label: 'Retorno esperado' }, { value: 'discount', label: 'Desconto' }, { value: 'liquidity', label: 'Liquidez' }, { value: 'drops', label: 'Drops' }, { value: 'instant', label: 'ROI de venda instantânea' }];
const pageSizeOptions = [10, 20, 50, 100, 200].map((value) => ({ value: String(value), label: String(value) }));

type PaginationItem = number | 'ellipsis';
function getPaginationItems(current: number, total: number): PaginationItem[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const items: PaginationItem[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) items.push('ellipsis');
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < total - 1) items.push('ellipsis');
  items.push(total);
  return items;
}

export function App() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [rows, setRows] = useState<Opportunity[]>([]);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [selected, setSelected] = useState<Opportunity | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scan, setScan] = useState<ScanSummary | null>(null);
  const [notice, setNotice] = useState('');
  const [auth, setAuth] = useState<{ authenticated: boolean; steamid: string | null }>({ authenticated: false, steamid: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalRows, setTotalRows] = useState(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams({ sort: filters.sort, page: String(page), pageSize: String(pageSize) });
    if (filters.search.trim()) params.set('search', filters.search.trim());
    if (filters.promotion) params.set('promotion', '1');
    if (filters.positive) params.set('positive', '1');
    if (filters.updatedOnly) params.set('updatedOnly', '1');
    if (filters.excludeFree) params.set('excludeFree', '1');
    if (filters.excludeUnavailable) params.set('excludeUnavailable', '1');
    const map: Array<[keyof Filters, string]> = [['priceMax', 'priceMax'], ['priceMin', 'priceMin'], ['roiMin', 'roiMin'], ['profitMin', 'profitMin'], ['discountMin', 'discountMin'], ['dropsMin', 'dropsMin'], ['cardsMin', 'cardsMin'], ['liquidityMin', 'volumeMin']];
    for (const [key, query] of map) if (filters[key]) params.set(query, filters[key] as string);
    try {
      const [opportunities, dashboard, scanStatus] = await Promise.all([
        fetch(`/api/opportunities?${params}`).then((response) => response.json()) as Promise<OpportunityPage>,
        fetch('/api/stats').then((response) => response.json()) as Promise<DashboardStats>,
        fetch('/api/scans/latest').then((response) => response.json()) as Promise<ScanSummary | null>
      ]);
      setRows(opportunities.data ?? []);
      setTotalRows(opportunities.total ?? opportunities.data?.length ?? 0);
      setStats(dashboard);
      setScan(scanStatus);
    } catch { setNotice('Não foi possível atualizar os dados. O último retrato continua visível.'); }
    finally { setLoading(false); }
  }, [filters, page, pageSize]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 220); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(true), 30_000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { void fetch('/api/auth/me').then((response) => response.json()).then((value: { authenticated: boolean; steamid: string | null }) => setAuth(value)).catch(() => undefined); }, []);

  const visibleRows = rows;
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / pageSize) : 0;
  const pageStart = totalRows > 0 ? ((page - 1) * pageSize) + 1 : 0;
  const pageEnd = totalRows > 0 ? Math.min(page * pageSize, totalRows) : 0;
  const paginationItems = getPaginationItems(page, totalPages);
  const catalogNote = stats
    ? scan?.status === 'running'
      ? `${number.format(stats.gamesAnalyzed)} análises prontas · ${number.format(scan.apps_cataloged)} tentativas concluídas · ${number.format(scan.errors)} falhas`
      : `${number.format(stats.totalCataloged)} candidatos no catálogo`
    : 'Carregando catálogo';

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => { setPage(1); setFilters((current) => ({ ...current, [key]: value })); };

  async function triggerScan() {
    setRefreshing(true); setNotice('Varredura iniciada: catálogo, loja e mercado serão atualizados em segundo plano.');
    try { await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 0 }) }); }
    catch { setNotice('Não foi possível iniciar a varredura.'); }
    finally { window.setTimeout(() => setRefreshing(false), 1200); }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">◆</div><div><strong>card<span>scope</span></strong><small>LABORATÓRIO DE ROI STEAM</small></div></div>
      <div className="side-section-label">ANÁLISES</div>
      <nav><a className="active" href="#oportunidades"><span>◈</span> Oportunidades</a><a href="#metodologia"><span>◌</span> Metodologia</a></nav>
      <div className="side-bottom"><div className="region-label">REGIÃO</div><button className="region-button"><span className="flag">🇧🇷</span><span>Brasil · BRL</span><span>⌄</span></button><div className="market-status"><i /> Mercado Steam conectado <span>·</span><b>público</b></div><a className="steam-login" href={auth.authenticated ? '/auth/steam/logout' : '/auth/steam'}>{auth.authenticated ? '✓ Steam conectado' : 'Entrar com Steam'}</a></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>Painel</span><b>/</b><strong>Oportunidades</strong></div><div className="top-actions"><div className="live-pill"><i /> DADOS AO VIVO</div><button className="icon-button" title="Atualizar" onClick={() => void load()} aria-label="Atualizar">↻</button><button className="avatar">CA</button></div></header>
      <div className="content-wrap">
        <section className="hero" id="oportunidades"><div><div className="eyebrow">CARTAS COLECIONÁVEIS STEAM <span>·</span> BRASIL</div><h1>Encontre as cartas<br /><span>que valem a pena.</span></h1><p>Ranking de oportunidades baseado em preços reais da loja, probabilidade normal de drop e liquidez do Mercado da Comunidade.</p></div><div className="hero-actions"><button className="button primary" onClick={() => void triggerScan()}>{refreshing ? 'Iniciando varredura…' : '↻  Atualizar catálogo'}</button><a className="button ghost" href="/api/export.csv">↓ Exportar CSV</a></div></section>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        <AccountMode authenticated={auth.authenticated} />
        <section className="metric-grid">
          <Metric label="Analisados com cartas" value={stats ? number.format(stats.gamesAnalyzed) : '—'} note={catalogNote} icon="◎" />
          <Metric label="ROI positivo" value={stats ? number.format(stats.positiveRoi) : '—'} note={stats && stats.gamesAnalyzed ? `${Math.round(stats.positiveRoi / stats.gamesAnalyzed * 100)}% dos analisados` : 'Aguardando varredura'} icon="↗" tone="green" />
          <Metric label="Maior ROI" value={stats?.topRoi ? percent(stats.topRoi.roi_bps) : '—'} note={stats?.topRoi?.name ?? 'Nenhuma oportunidade ainda'} icon="✦" tone="purple" />
          <Metric label="Maior lucro" value={stats?.topProfit ? money(stats.topProfit.profit_cents) : '—'} note={stats?.topProfit?.name ?? 'Nenhuma oportunidade ainda'} icon="◈" tone="amber" />
        </section>
        <div className="dashboard-grid">
          <aside className="filter-panel"><div className="panel-heading"><div><span className="eyebrow">PAINEL DE CONTROLE</span><h2>Filtros</h2></div><button className="reset" onClick={() => { setPage(1); setFilters(initialFilters); }}>Redefinir</button></div><label className="search-field"><span>⌕</span><input value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="Buscar jogo ou AppID" /></label><div className="filter-group"><div className="group-title">FILTROS RÁPIDOS</div><Toggle label="Em promoção" checked={filters.promotion} onChange={(value) => updateFilter('promotion', value)} /><Toggle label="Somente ROI positivo" checked={filters.positive} onChange={(value) => updateFilter('positive', value)} /><Toggle label="Somente dados recentes" checked={filters.updatedOnly} onChange={(value) => updateFilter('updatedOnly', value)} /></div><div className="filter-group"><div className="group-title">PREÇO E RETORNO</div><div className="dual-input"><label><span>Preço mínimo</span><input inputMode="decimal" value={filters.priceMin} onChange={(e) => updateFilter('priceMin', e.target.value)} placeholder="R$ 0" /></label><label><span>Preço máximo</span><input inputMode="decimal" value={filters.priceMax} onChange={(e) => updateFilter('priceMax', e.target.value)} placeholder="R$ 5" /></label></div><div className="dual-input"><label><span>ROI mínimo</span><input inputMode="numeric" value={filters.roiMin} onChange={(e) => updateFilter('roiMin', e.target.value)} placeholder="50%" /></label><label><span>Lucro mínimo</span><input inputMode="decimal" value={filters.profitMin} onChange={(e) => updateFilter('profitMin', e.target.value)} placeholder="R$ 1" /></label></div></div><div className="filter-group"><div className="group-title">QUALIDADE DOS DADOS</div><div className="dual-input"><label><span>Desconto mínimo</span><input inputMode="numeric" value={filters.discountMin} onChange={(e) => updateFilter('discountMin', e.target.value)} placeholder="80%" /></label><label><span>Liquidez mínima</span><input inputMode="numeric" value={filters.liquidityMin} onChange={(e) => updateFilter('liquidityMin', e.target.value)} placeholder="70" /></label></div><div className="dual-input"><label><span>Drops mínimos</span><input inputMode="numeric" value={filters.dropsMin} onChange={(e) => updateFilter('dropsMin', e.target.value)} placeholder="3" /></label><label><span>Tamanho mínimo do conjunto</span><input inputMode="numeric" value={filters.cardsMin} onChange={(e) => updateFilter('cardsMin', e.target.value)} placeholder="6" /></label></div><Toggle label="Excluir jogos grátis" checked={filters.excludeFree} onChange={(value) => updateFilter('excludeFree', value)} /><Toggle label="Disponível para compra no Brasil" checked={filters.excludeUnavailable} onChange={(value) => updateFilter('excludeUnavailable', value)} /></div><div className="filter-footnote"><span>ⓘ</span><p>O ranking exclui cartas foil. Os preços brutos são convertidos para o crédito líquido da Carteira Steam usando taxas calculadas em centavos.</p></div></aside>
          <section className="results-panel"><div className="results-header"><div><div className="eyebrow">RANKING <span className="count-badge">{number.format(totalRows)}</span></div><h2>Melhores oportunidades agora</h2></div><SortDropdown value={filters.sort} onChange={(value) => updateFilter('sort', value)} /></div><div className="table-shell">{loading ? <div className="loading-state"><div className="loader" /><p>Carregando dados atuais do mercado…</p></div> : visibleRows.length === 0 ? <EmptyState onScan={() => void triggerScan()} scanning={scan?.status === 'running'} progress={scan ? `${number.format(stats?.gamesAnalyzed ?? 0)} análises prontas · ${number.format(scan.apps_cataloged)} tentativas concluídas · ${number.format(scan.errors)} falhas` : ''} /> : <OpportunityTable rows={visibleRows} startIndex={(page - 1) * pageSize} onSelect={setSelected} />}</div><div className="pagination-bar"><div className="pagination-summary">{totalRows ? <>Exibindo <b>{number.format(pageStart)}–{number.format(pageEnd)}</b> de <b>{number.format(totalRows)}</b> oportunidades</> : scan?.status === 'running' ? 'Aguardando os primeiros dados calculados' : 'Nenhuma oportunidade encontrada'}</div><div className="pagination-controls"><StyledDropdown className="page-size-dropdown" label="Itens por página" value={String(pageSize)} options={pageSizeOptions} onChange={(value) => { setPageSize(Number(value)); setPage(1); }} /><div className="page-buttons" aria-label="Paginação"><button type="button" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>←</button>{paginationItems.map((item, index) => item === 'ellipsis' ? <span className="page-ellipsis" key={`ellipsis-${index}`}>…</span> : <button type="button" className={item === page ? 'current' : ''} aria-current={item === page ? 'page' : undefined} key={item} onClick={() => setPage(item)}>{item}</button>)}<button type="button" aria-label="Próxima página" disabled={!totalPages || page >= totalPages} onClick={() => setPage((current) => current + 1)}>→</button></div></div></div><div className="results-footer"><span>Página <b>{totalPages ? page : 0}</b> de <b>{number.format(totalPages)}</b></span><span><i className="fresh-dot" /> Última atualização: {shortDate(stats?.lastUpdated ?? null)}</span></div></section>
        </div>
        <section className="trust-strip" id="metodologia"><div className="trust-title"><span className="eyebrow">TRANSPARÊNCIA DO MODELO</span><h2>Números auditáveis.</h2></div><TrustItem title="Drops por conta" text="Quantidade exata restante quando a sessão Steam está configurada; estimativa caso contrário" /><TrustItem title="Crédito da carteira" text="5% Steam + 10% editora, calculados em centavos" /><TrustItem title="Ajustado pela liquidez" text="Volume, anúncios e confiança em cada classificação" /><TrustItem title="Sem automação de farming" text="Somente análise — nenhum bot de login ou venda" /></section>
        <footer><span>cardscope <b>·</b> Inteligência de cartas Steam</span><span>Os dados são um retrato, não uma recomendação financeira · <a href="https://steamcommunity.com/tradingcards/faq/" target="_blank" rel="noreferrer">FAQ da Steam ↗</a></span></footer>
      </div>
    </main>
    {selected && <DetailModal game={selected} onClose={() => setSelected(null)} />}
  </div>;
}

type DropdownOption = { value: string; label: string };
function StyledDropdown({ label, value, options, onChange, className = '' }: { label: string; value: string; options: DropdownOption[]; onChange: (value: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0] ?? { value: '', label: '' };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event: PointerEvent) => { if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOnOutsideClick); document.removeEventListener('keydown', closeOnEscape); };
  }, [open]);

  return <div className={`sort-dropdown ${className} ${open ? 'open' : ''}`} ref={dropdownRef}>
    <button type="button" className="sort-select" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}><span>{label}</span><strong>{selected.label}</strong><b>{open ? '⌃' : '⌄'}</b></button>
    {open && <div className="sort-menu" role="listbox" aria-label={label}>{options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={`sort-option ${option.value === value ? 'selected' : ''}`} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}</div>}
  </div>;
}

function SortDropdown({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <StyledDropdown label="Ordenar por" value={value} options={sortOptions} onChange={onChange} />; }
function Metric({ label, value, note, icon, tone = 'blue' }: { label: string; value: string; note: string; icon: string; tone?: string }) { return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong>{value}</strong><small>{note}</small></div><span className="metric-spark">⌁</span></div>; }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }
function TrustItem({ title, text }: { title: string; text: string }) { return <div className="trust-item"><div className="trust-check">✓</div><div><strong>{title}</strong><span>{text}</span></div></div>; }
function AccountMode({ authenticated }: { authenticated: boolean }) { return <div className="notice account-notice">{authenticated ? 'Steam conectado: o sistema pode consultar os drops restantes da sua conta quando a página de cartas do jogo estiver acessível.' : <><a href="/auth/steam">Entrar com Steam</a> para consultar os drops restantes da sua conta; a senha é digitada somente na Steam.</>}</div>; }

function OpportunityTable({ rows, startIndex = 0, onSelect }: { rows: Opportunity[]; startIndex?: number; onSelect: (row: Opportunity) => void }) { return <table><thead><tr><th className="rank-col">#</th><th>JOGO</th><th>COMPRAR AGORA</th><th>CONJUNTO / DROPS</th><th>RETORNO LÍQUIDO ESPERADO</th><th>LUCRO</th><th>ROI</th><th>LIQUIDEZ</th><th>CONFIANÇA</th><th /></tr></thead><tbody>{rows.map((row, index) => <tr key={row.appid} onClick={() => onSelect(row)}><td className="rank-col"><span className={`rank ${index < 3 ? 'top' : ''}`}>{String(startIndex + index + 1).padStart(2, '0')}</span></td><td><div className="game-cell"><img src={row.header_image ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${row.appid}/capsule_184x69.jpg`} alt="" /><div><strong>{row.name}</strong><small>#{row.appid} <span>·</span> {row.discount_percent ? `${row.discount_percent}% de desconto` : 'Preço normal'}</small></div></div></td><td><strong className="primary-number">{money(row.price_cents)}</strong>{row.normal_price_cents && row.normal_price_cents !== row.price_cents ? <small className="strike">{money(row.normal_price_cents)}</small> : null}</td><td><strong>{row.cards_count} cartas</strong><small>{row.drops} drops normais</small></td><td><strong>{money(row.expected_sell_cents)}</strong><small className="subtle">bruto {money(row.expected_gross_cents)}</small></td><td><strong className={row.profit_cents !== null && row.profit_cents > 0 ? 'positive' : 'negative'}>{row.profit_cents !== null && row.profit_cents > 0 ? '+' : ''}{money(row.profit_cents)}</strong><small className="subtle">mediana {money(row.median_cents)}</small></td><td><strong className={`roi ${row.roi_bps !== null && row.roi_bps > 0 ? 'positive' : 'negative'}`}>{percent(row.roi_bps)}</strong><small className="subtle">instantâneo {percent(row.instant_roi_bps)}</small></td><td><span className={`pill ${scoreTone(row.liquidity_score)}`}>{row.liquidity_label ?? 'Desconhecida'}</span><small className="subtle">{row.liquidity_score ?? '—'}/100</small></td><td><span className={`confidence ${scoreTone(row.confidence_score)}`}><i />{row.confidence_score ?? '—'}</span></td><td><button className="row-arrow" aria-label={`Abrir ${row.name}`}>→</button></td></tr>)}</tbody></table>; }

function EmptyState({ onScan, scanning, progress }: { onScan: () => void; scanning: boolean; progress: string }) { return scanning ? <div className="empty-state scanning-state"><div className="loader" /><h3>Coletando oportunidades…</h3><p>A loja e o Mercado da Steam ainda estão sendo consultados. Os primeiros jogos aparecem assim que tiverem preço e cartas normais calculados.</p><small>{progress}</small></div> : <div className="empty-state"><div className="empty-icon">◈</div><h3>Nenhuma oportunidade nesta visualização</h3><p>Tente relaxar algum filtro ou execute uma varredura ao vivo para coletar dados atualizados da loja e do mercado.</p><button className="button primary" onClick={onScan}>Executar varredura</button></div>; }

function DetailModal({ game, onClose }: { game: Opportunity; onClose: () => void }) {
  const [detail, setDetail] = useState<Opportunity>(game);
  useEffect(() => { void fetch(`/api/games/${game.appid}`).then((response) => response.json()).then((value: Opportunity) => setDetail(value)).catch(() => undefined); }, [game.appid]);
  const cards = detail.cards ?? [];
  const specialCards = detail.special_cards ?? [];
  const priced = cards.filter((card) => card.lowest_cents !== null);
  const typeLabel = detail.type === 'bundle' ? 'bundle' : 'jogo';
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="detail-modal"><button className="modal-close" onClick={onClose} aria-label="Fechar">×</button><div className="detail-hero"><img src={detail.header_image ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${detail.appid}/header.jpg`} alt="" /><div><span className="eyebrow">APPID {detail.appid} <span>·</span> {typeLabel}</span><h2>{detail.name}</h2><a href={detail.store_url ?? `https://store.steampowered.com/app/${detail.appid}/`} target="_blank" rel="noreferrer">Abrir na Steam ↗</a></div></div><div className="detail-kpis"><DetailKpi label="Comprar agora" value={money(detail.price_cents)} /><DetailKpi label="Retorno líquido esperado" value={money(detail.expected_sell_cents)} /><DetailKpi label="ROI esperado" value={percent(detail.roi_bps)} tone="green" /><DetailKpi label="ROI instantâneo" value={percent(detail.instant_roi_bps)} tone="amber" /></div><div className="detail-grid"><div className="distribution-card"><div className="card-heading"><div><span className="eyebrow">FAIXA DE RESULTADOS</span><h3>Distribuição dos drops</h3></div><span className="info-tag">{detail.drops} sorteios · com reposição</span></div><div className="range"><Range label="Pior caso" value={detail.worst_cents} /><Range label="Mediana / típico" value={detail.median_cents} active /><Range label="Retorno líquido esperado" value={detail.expected_sell_cents} /><Range label="Melhor caso" value={detail.best_cents} /></div><p className="formula">Cada carta normal tem a mesma probabilidade em cada sorteio. Duplicatas são permitidas; cartas foil ficam fora deste modelo.</p></div><div className="distribution-card"><div className="card-heading"><div><span className="eyebrow">SAÚDE DO CONJUNTO</span><h3>Confiança dos dados</h3></div><span className={`score-big ${scoreTone(detail.confidence_score)}`}>{detail.confidence_score ?? '—'}<small>/100</small></span></div><div className="confidence-bar"><i style={{ width: `${detail.confidence_score ?? 0}%` }} /></div><div className="quality-list"><span><b>Liquidez</b><em>{detail.liquidity_label} · {detail.liquidity_score ?? '—'}/100</em></span><span><b>Atualização do preço</b><em>{shortDate(detail.last_market_at)}</em></span><span><b>Cartas normais com preço</b><em>{priced.length} / {cards.length}</em></span><span><b>Variantes foil/especiais</b><em>{specialCards.length}</em></span></div></div></div><div className="cards-card"><div className="card-heading"><div><span className="eyebrow">CONJUNTO DE CARTAS NORMAIS</span><h3>{cards.length} cartas · {detail.drops} drops</h3></div><span className="info-tag">Incluídas no ROI</span></div><div className="card-list">{cards.length ? cards.map((card) => <CardRow key={card.hash_name} card={card} />) : <p className="muted-text">Os dados das cartas ainda estão sendo coletados.</p>}</div></div><div className="special-card-disclaimer"><strong>Foils e especiais ficam fora do ROI</strong><span>Os preços abaixo são somente para consulta. O ranking e o lucro usam exclusivamente as cartas normais.</span></div><div className="cards-card special-cards-card"><div className="card-heading"><div><span className="eyebrow">CARTAS FOIL E ESPECIAIS</span><h3>{specialCards.length} variantes encontradas</h3></div><span className="info-tag">Fora do ROI</span></div><p className="special-card-note">A Steam informa oficialmente apenas uma pequena chance de uma carta recebida ser foil. Para consulta, mostramos uma referência aproximada de 1% por drop e uma estimativa de 1% ÷ tamanho do conjunto por carta específica; a Steam não publica um percentual exato. <a href="https://steamcommunity.com/tradingcards/faq/" target="_blank" rel="noreferrer">Ler FAQ oficial ↗</a></p><div className="card-list">{specialCards.length ? specialCards.map((card) => <SpecialCardRow key={card.hash_name} card={card} setSize={cards.length} />) : <p className="muted-text">Nenhuma variante foil ou especial foi encontrada neste retrato do Mercado.</p>}</div></div><div className="modal-footer"><span>Última atualização do mercado: {shortDate(detail.last_market_at)}</span><a href="/api/export.json" target="_blank" rel="noreferrer">Exportar ranking completo ↗</a></div></section></div>;
}
function DetailKpi({ label, value, tone = '' }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><strong className={tone}>{value}</strong></div>; }
function Range({ label, value, active = false }: { label: string; value: number | null; active?: boolean }) { return <div className={active ? 'active' : ''}><span>{label}</span><strong>{money(value)}</strong></div>; }
function CardRow({ card }: { card: MarketCard }) { return <div className="card-row"><div className="card-id"><img src={card.icon_url ?? ''} alt="" /><span>{card.name}</span></div><div><small>Menor venda</small><strong>{money(card.lowest_cents)}</strong></div><div><small>Mediana</small><strong>{money(card.median_cents)}</strong></div><div><small>Volume em 24h</small><strong>{card.volume === null ? '—' : number.format(card.volume)}</strong></div><div><small>Anúncios</small><strong>{card.sell_listings === null ? '—' : number.format(card.sell_listings)}</strong></div></div>; }
function SpecialCardRow({ card, setSize }: { card: MarketCard; setSize: number }) { const chance = card.is_foil && setSize > 0 ? `~${(1 / setSize).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% por drop específico` : 'Não publicada pela Steam'; return <div className="card-row special-card-row"><div className="card-id special-card-id"><img src={card.icon_url ?? ''} alt="" /><div><span>{card.name}</span><small>{card.rarity ?? (card.is_foil ? 'Foil' : 'Especial')}</small></div></div><div><small>Menor venda</small><strong>{money(card.lowest_cents)}</strong></div><div><small>Mediana</small><strong>{money(card.median_cents)}</strong></div><div><small>Chance informativa</small><strong>{chance}</strong></div><div><small>Entra no ROI?</small><strong>Não</strong></div></div>; }
