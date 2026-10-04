# Steam Card ROI

Ferramenta de análise de oportunidades de retorno com cartas colecionáveis da Steam para a região brasileira (BRL). O produto calcula o retorno esperado usando apenas drops normais, separa a venda pelo menor preço anunciado da venda instantânea por ordem de compra e reduz a pontuação de oportunidades com pouca liquidez. Ele não inicia jogos, não faz farming e não compra nem vende itens automaticamente.

## Início rápido

Requer Node.js 22.18 ou superior. O projeto usa `node:sqlite`, sem dependência de complemento nativo externo.

```bash
npm install
Copy-Item .env.example .env
npm run bootstrap
npm run dev
```

Abra `http://localhost:5173`. O comando `bootstrap` coleta um pequeno conjunto de jogos reais para a primeira visualização. A varredura completa usa a busca da Loja Steam filtrada por cartas colecionáveis, sem restringir idioma, e inclui aplicativos e pacotes (`Sub_`). Depois, confirma os dados da Loja e do Mercado. Use `npm run scan -- --limit 0` para percorrer todo o catálogo; o processo é incremental e respeita os tempos de validade definidos para cada fonte.

Para executar o servidor já compilado, use `npm run build` e depois `npm start`; nesse modo, abra `http://localhost:3000`. A primeira execução com banco vazio inicia um bootstrap ao subir a API.

### Docker

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Abra `http://localhost:3000`. O volume nomeado `steam_roi_data` mantém o banco e os caches entre reinícios; `docker compose down` não remove esse volume. Não use `docker compose down --volumes` sem confirmar que deseja apagar esses dados locais.

## Arquitetura

- Interface React + Vite, servida pelo Express em produção.
- API Node/Express com SQLite local e WAL. O esquema é relacional e pode ser migrado para PostgreSQL sem alterar a matemática.
- `SteamClient` descobre candidatos pela busca da Loja na categoria de cartas colecionáveis, sem filtro de idioma ou região, confirma os detalhes do aplicativo e consulta o Mercado da Comunidade. Pacotes são lidos por `packagedetails`, e o ROI soma as cartas de todos os jogos incluídos antes de descontar o preço único do pacote. O catálogo não depende de AppIDs cadastrados manualmente.
- Scanner incremental com tempo de validade por fonte, concorrência controlada, balde de tokens, novas tentativas com recuo progressivo e preservação do cache antigo quando uma fonte falha.
- Agendador opcional (`AUTO_SCAN_INTERVAL_MINUTES`) prioriza promoções, pontuações e dados antigos. Ele vem desligado por padrão para não consumir requisições do Mercado ao abrir a interface.
- Histórico agregado por captura para preços de jogos e cartas.
- Paginação no servidor: a interface começa com 20 resultados por página, permite escolher 10, 20, 50, 100 ou 200 e calcula o total de páginas sobre todos os resultados filtrados.

## Fontes e limitações

1. `steam-appdb` (espelho de PICS anônimo) é o fallback atual para descobrir AppIDs e nomes, porque a Valve removeu o acesso sem chave a `ISteamApps/GetAppList`. O catálogo é armazenado por 24 horas em `data/catalog.json`. Se o endpoint antigo voltar, ele será tentado primeiro.
2. `store.steampowered.com/api/appdetails?cc=br&l=brazilian`: preço regional, desconto, disponibilidade, tipo e categoria 29 (cartas colecionáveis da Steam). É um endpoint público não documentado; respeite o limite de requisições.
3. `steamcommunity.com/market/search/render`: nomes dos itens, anúncios e descoberta do conjunto normal. É um endpoint não documentado e costuma responder 10 itens por página.
4. `steamcommunity.com/market/priceoverview`: menor preço, mediana e volume na moeda solicitada (`currency=7`, BRL). Não exige login.

O histórico detalhado, as ordens de compra e algumas informações de liquidez dependem da sessão da Steam e não são forçados pelo aplicativo. Sem isso, a venda instantânea aparece como indisponível e a confiança é reduzida. O saldo da Carteira Steam é crédito interno, não dinheiro sacável.

## Drops exatos por conta

A regra pública da Steam é “cerca de metade do conjunto”. Sem autenticação, o modo público usa `ceil(cards / 2)` e registra a origem como `estimated_half_set`; isso é uma estimativa, não uma contagem exata.

A quantidade realmente restante é específica da conta e aparece na página autenticada de insígnias/cartas. Para ativar esse modo, preencha localmente `STEAM_EXACT_DROPS=true`, `STEAM_SESSION_ID` e `STEAM_LOGIN_SECURE` no arquivo `.env`. O scanner consulta a página de cartas de cada jogo e registra `account_badges_exact`; jogos sem drops restantes são excluídos da lista de oportunidades. Nunca envie esses valores pelo chat nem os versione no repositório.

## Matemática

- Drops normais: `ceil(cardSetSize / 2)`, seguindo a FAQ oficial da Steam (“about half”). As cartas são sorteadas com reposição, permitindo duplicatas.
- Valor esperado: soma dos preços líquidos individuais multiplicada por `drops / cardSetSize`.
- Pior/melhor caso: todos os drops vêm da carta normal mais barata ou mais cara. São limites teóricos, não promessa de resultado.
- Típico: mediana exata da distribuição da soma obtida por convolução discreta, quando os valores estão disponíveis.
- Cartas foil e outras variantes especiais: o scanner consulta separadamente a borda foil e guarda preço, liquidez e eventual etiqueta de raridade apenas para consulta no detalhe do jogo. Elas não aumentam `cards_count`, `drops`, retorno esperado, lucro, ROI ou qualquer pontuação do ranking. A FAQ oficial informa somente que existe uma pequena chance de um drop ser foil; a interface mostra a referência aproximada de 1% e deixa explícito que o percentual exato não é publicado pela Steam.
- Taxa padrão: 5% de taxa da Steam e 10% de taxa da editora, cada uma com mínimo de 1 centavo e arredondamento para baixo sobre o valor-base do vendedor. Para um preço pago pelo comprador, o crédito da carteira é invertido em centavos; não é `gross * .85`.
- ROI: `(retorno líquido esperado - preço atual do jogo) / preço atual do jogo * 100`.
- Liquidez: combinação logarítmica de volume, anúncios de venda e dados de spread/ordens quando disponíveis. Volume zero e ausência de ordem de compra limitam a pontuação.
- Confiança: atualização (30), preço do jogo (20), conjunto completo (20), cobertura de preços (20) e liquidez (10), com penalidade para dados antigos ou erros.
- Pontuação de oportunidade: ROI e lucro são primeiro multiplicados por `min(liquidez, confiança)/100`; depois, usa-se `0.45 * ROI/250 + 0.25 * lucro/R$10 + 0.20 * liquidez + 0.10 * confiança`, exibido de 0 a 100. Isso impede que um preço isolado e sem liquidez domine o ranking.

## Paginação

O endpoint `GET /api/opportunities` aplica os filtros e calcula o total antes de devolver a página solicitada. Os parâmetros principais são:

- `page`: número da página, começando em 1.
- `pageSize`: quantidade de itens por página. A interface oferece 10, 20, 50, 100 e 200; a API aceita até 500.
- `search`: busca por nome do jogo ou AppID em todo o conjunto filtrado.

A resposta tem o formato `{ "data": [...], "total": 123 }`. A interface calcula `ceil(total / pageSize)`, exibe a posição dos itens e mantém a numeração do ranking entre páginas. `limit` e `offset` continuam aceitos para compatibilidade com chamadas antigas.

### Configuração principal

As variáveis ficam no arquivo `.env`, que não deve ser versionado. As mais importantes são:

- `CATALOG_SCAN_LIMIT`: limite padrão de aplicativos por varredura; `0` percorre todo o catálogo.
- `AUTO_SCAN_INTERVAL_MINUTES`: intervalo da varredura automática; `0` mantém o agendador desligado.
- `STEAM_MARKET_PRICE_DETAILS`: habilita consultas adicionais de mediana e volume.
- `STEAM_MARKET_BUY_ORDERS`: habilita a tentativa de consultar ordens de compra quando houver sessão válida.
- `PUBLIC_BASE_URL`: URL pública usada no callback do OpenID da Steam; em desenvolvimento, use `http://localhost:3000`.
- `AUTH_COOKIE_SECRET`: segredo estável e longo para assinar o cookie local de autenticação. Se ficar vazio, um segredo aleatório é criado a cada inicialização e os cookies deixam de valer após reiniciar o processo.

## Comandos

```bash
npm run typecheck
npm test
npm run build
npm start
npm run bootstrap
npm run scan -- --limit 250
```

API principal: `GET /api/games`, `GET /api/opportunities`, `GET /api/opportunities/top`, `GET /api/games/:appid`, `GET /api/games/:appid/history`, `GET /api/cards/:appid`, `GET /api/market/cards/:appid/:hashName/history`, `GET /api/stats`, `GET /api/scans/latest`, `POST /api/scan`, `GET /api/export.csv` e `GET /api/export.json`.

### Parâmetros de consulta das oportunidades

`sort=roi|profit|price|expected|discount|liquidity|drops|instant`, `search`, `page`, `pageSize`, `promotion=1`, `positive=1`, `roiMin`, `priceMax`, `priceMin`, `profitMin`, `dropsMin`, `cardsMin`, `discountMin`, `volumeMin`, `updatedOnly=1`, `excludeFree=1`, `excludeUnavailable=1`, `limit` e `offset`.

## Segurança

O botão “Entrar com Steam” usa OpenID 2.0 e redireciona a autenticação para a própria Steam. O site recebe somente o SteamID e grava um cookie local assinado. A leitura de drops exatos por conta, disponível em `GET /api/account/drops/:appid`, depende de uma página de insígnias/cartas acessível e de uma sessão Steam válida configurada localmente; OpenID não entrega a senha nem um cookie de sessão Steam ao servidor. Não coloque cookies, chaves ou credenciais no código. O servidor não faz farming nem compra ou venda automática.

O catálogo acelerado usa a busca da Loja filtrada pela categoria de cartas colecionáveis e depois confirma preço, disponibilidade e categoria em cada AppID. O Mercado usa o menor preço em BRL retornado pela busca na primeira passagem; detalhes de mediana e volume podem ser habilitados com `STEAM_MARKET_PRICE_DETAILS=true`, ao custo de mais requisições.
