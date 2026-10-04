# Pesquisa técnica — fontes e decisões

Pesquisa realizada em 06/09/2026. O produto consulta a Steam diretamente para os valores que mudam rapidamente e usa uma fonte de catálogo baseada em PICS anônimo somente para descobrir AppIDs.

| Dado | Fonte | Confiabilidade / custo | Decisão |
| --- | --- | --- | --- |
| AppIDs e catálogo | `steam-appdb`, alimentado por PICS anônimo; tenta `ISteamApps/GetAppList` primeiro | Atualiza a cada aproximadamente 2 horas na fonte; espelho de terceiros; exige cache | Usado como fallback porque o endpoint antigo sem chave retornou 404 na validação real. O cache local dura 24 horas e guarda o tipo para excluir DLC e software antes da consulta à Loja. |
| Tipo, nome, preço, desconto e disponibilidade | Detalhes do aplicativo na Loja, com `cc=br&l=brazilian` | Endpoint público não documentado; um AppID por requisição; sujeito a limite de requisições | Fonte primária para o preço brasileiro atual. Uma falha não apaga o retrato anterior. |
| Existência de cartas e conjunto normal | Categoria 29 da Loja + busca do Mercado com `category_753_Game[]=tag_app_APPID`, classe 2 e borda 0 | A busca do Mercado é um endpoint não documentado; responde páginas pequenas e há um limite operacional de aproximadamente 20 requisições por minuto | O conjunto é descoberto automaticamente; cartas foil nunca entram na base normal. |
| Cartas foil e variantes especiais | Busca do Mercado repetida com `tag_cardborder_1`; etiquetas de raridade só são usadas quando fornecidas nos metadados | A FAQ pública da Steam confirma apenas uma “pequena chance” de foil; não publica percentual exato por drop ou por carta | Preços e etiquetas aparecem em uma seção separada do detalhe. São dados informativos e nunca entram na matemática do ROI. |
| Menor preço, mediana e volume | `market/priceoverview`, `currency=7`, `country=BR` | Público, sem login; volume é a métrica disponibilizada pela Steam | Cada item recebe o valor em BRL e o volume atual. Os anúncios vêm da busca do Mercado. |
| Ordens de compra | `itemordershistogram` + `Market_LoadOrderSpread` | Pode exigir sessão/cookies; contrato não documentado | Ativação opcional via `.env`; sem sessão, a venda instantânea fica explicitamente indisponível. |
| Histórico detalhado | `pricehistory` / histórico da página do item | Requer autenticação em muitos casos | O sistema já agrega seus próprios retratos no SQLite; o histórico detalhado externo permanece opcional. |

## Achados importantes

- A FAQ oficial da Steam diz que a maioria dos jogos solta aproximadamente metade do conjunto; o código usa `ceil(n / 2)`, logo 5→3, 6→3 e 8→4.
- A FAQ oficial também diz que qualquer carta recebida pode ter uma borda foil com uma pequena chance. Como não há percentual oficial exato, a interface mostra aproximadamente 1% por drop como referência de mercado e calcula a chance de uma carta foil específica como uma estimativa de `1% / tamanho do conjunto`; nenhuma dessas duas referências é usada no ROI.
- `priceoverview` em BRL funcionou com `currency=7` e `country=BR` durante a validação. O conteúdo da busca não deve ser tratado como BRL: em alguns casos a descrição retornou USD; por isso o preço final da carta é lido no `priceoverview`.
- O limite do Mercado não é um contrato oficial estável. O cliente separa Loja e Mercado em baldes de tokens, usa novas tentativas exponenciais para erros 5xx e espera 65 segundos para respostas 429. Um 429 individual de carta produz cobertura parcial, não o descarte do jogo.
- A taxa padrão documentada pela Steam é 5% de taxa de transação; a taxa padrão da editora usada para jogos com cartas é 10%. Cada taxa tem mínimo de 1 centavo e é arredondada para baixo sobre o valor-base do vendedor. O total pago pelo comprador é invertido em centavos para calcular o crédito da Carteira.
- O Mercado da Comunidade Steam fornece crédito da Carteira, não um retorno em dinheiro sacável; isso é exibido como uma limitação do produto.

## Projetos avaliados

`steam-market-search` e `steam-market-api` ajudaram a confirmar os parâmetros públicos e o formato do Mercado, mas o coletor não depende de uma biblioteca de terceiros para reduzir o risco de contrato quebrado e problemas de licença. `ArchiSteamFarm` ficou fora do escopo porque este produto não inicia jogos, não faz farming, não realiza login automático e não vende itens.

## Links de referência

- [FAQ das cartas colecionáveis da Steam](https://steamcommunity.com/tradingcards/faq/)
- [FAQ do Mercado da Comunidade Steam](https://help.steampowered.com/en/faqs/view/61F0-72B7-9A18-C70B)
- [Documentação do serviço da Loja Steam](https://partner.steamgames.com/doc/webapi/IStoreService)
- [Espelho do catálogo steam-appdb](https://github.com/Austrum-lab/steam-appdb)
- [Parâmetros da busca do Mercado Steam](https://github.com/DrKain/steam-market-search)
