'use strict';
// =====================================================================================================================
// BI Operacional - base dos relatórios do BI antigo no servidor (19/11/2026 em diante). Hoje serve a aba Vendas Detalhadas.
//
// A aba "Relatórios" não foi publicada: os relatórios do BI antigo viraram incrementos das abas que já existiam (decisão
// do usuário, 23/11/2026). Daqui ficou só o que a aba Vendas Detalhadas usa: os dados chegam prontos do computador local
// (relatorios/monta_relatorios.js -> sync_relatorios.js) em POST /api/sync-relatorios e ficam em data/relatorios.json; a
// tela pede GET /api/relatorios/vendas, já filtrado pelas empresas do usuário (filial de destino) e pelo período, somado
// no servidor e compactado. O código da tela fica em vendas_tela.js (GET /vendas.js), com os componentes comuns em
// componentes_tela.js (GET /componentes.js).
// =====================================================================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CACHE_MAX = 24; // respostas prontas guardadas (por relatorio, empresas e periodo), zeradas a cada carga
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** periodo pedido, limitado ao que existe nos dados; sem periodo valido = do 1o dia do mes do ultimo dado ate ele */
function periodo(query, limites) {
  let de = DATA_RE.test(String(query.de || '')) ? query.de : null;
  let ate = DATA_RE.test(String(query.ate || '')) ? query.ate : null;
  if (!de || !ate || de > ate) { ate = limites.max; de = ate.slice(0, 8) + '01'; }
  return { de, ate };
}

/** Vendas (aba Vendas Detalhadas): as linhas pedido x produto do periodo, com so os PDVs, pedidos e produtos usados */
function vendas(dados, empresas, per) {
  const V = dados.vendas, ix = Object.fromEntries(V.cols.map((c, i) => [c, i]));
  const novo = () => ({ lista: [], pos: new Map() });
  const pdvs = novo(), peds = novo(), vend = novo();
  const pega = (m, i, linha) => { let p = m.pos.get(i); if (p == null) { p = m.lista.length; m.lista.push(linha); m.pos.set(i, p); } return p; };
  const linhas = [];
  for (const l of V.linhas) {
    const d = l[ix.dia];
    if (d < per.de || d > per.ate) continue;
    const pdv = dados.pdvs.linhas[l[ix.pdv]];
    if (!empresas.has(String(pdv[1]))) continue; // empD = filial de destino
    linhas.push([d, pega(pdvs, l[ix.pdv], pdv), pega(peds, l[ix.ped], V.pedidos.linhas[l[ix.ped]]), pega(vend, l[ix.vend], V.nomesVendidos[l[ix.vend]]), l[ix.prod], l[ix.qte], l[ix.unit], l[ix.total]]);
  }
  return { cols: V.cols, linhas, pdvCols: dados.pdvs.cols, pdvs: pdvs.lista, pedCols: V.pedidos.cols, pedidos: peds.lista, nomesVendidos: vend.lista, produtos: dados.produtos, grupos: dados.grupos, empresas: dados.empresas || {} };
}

const RELATORIOS = {
  vendas: { aba: 'vendas-detalhe', limites: (d) => d.limites.vendas, monta: vendas },
};

/**
 * Liga as rotas ao app do servidor.
 * deps: { requireAuth, abaLiberada, empresasDoUsuario, SYNC_SECRET, express, liberaMemoria, dataDir }
 */
module.exports = function rotasRelatorios(app, deps) {
  const { requireAuth, abaLiberada, empresasDoUsuario, SYNC_SECRET, express, liberaMemoria } = deps;
  const ARQUIVO = path.join(deps.dataDir, 'relatorios.json');
  let dados = null;
  if (fs.existsSync(ARQUIVO)) {
    try { dados = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch (err) { console.error('Não consegui ler data/relatorios.json, começando sem relatórios:', err.message); }
  }
  const cache = new Map();

  // carga vinda do computador local
  app.post('/api/sync-relatorios', express.json({ limit: '25mb' }), (req, res) => {
    const secret = req.header('X-Sync-Secret');
    if (!secret || secret !== SYNC_SECRET) return res.status(403).json({ ok: false, error: 'Segredo de sincronização inválido.' });
    const b = req.body || {};
    const V = b.vendas;
    if (b.versao !== 1 || !b.pdvs || !Array.isArray(b.pdvs.linhas) || !Array.isArray(b.produtos) || !V || !Array.isArray(V.linhas) || !V.linhas.length || !V.pedidos || !Array.isArray(V.pedidos.linhas)) {
      return res.status(400).json({ ok: false, error: 'Carga de relatórios inválida.' });
    }
    try {
      const dv = V.linhas.map((l) => l[0]).sort();
      b.limites = { vendas: { min: dv[0], max: dv[dv.length - 1] } };
      b.syncedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
      fs.writeFileSync(ARQUIVO + '.tmp', JSON.stringify(b));
      fs.renameSync(ARQUIVO + '.tmp', ARQUIVO);
      dados = b;
      cache.clear();
      res.json({ ok: true, syncedAt: b.syncedAt, pdvs: b.pdvs.linhas.length, vendas: V.linhas.length, pedidos: V.pedidos.linhas.length });
      liberaMemoria();
    } catch (err) {
      console.error('Erro processando /api/sync-relatorios:', err);
      res.status(500).json({ ok: false, error: 'Erro ao processar a carga dos relatórios.' });
    }
  });

  // situacao da carga (para o ciclo do computador local reenviar quando o servidor perdeu os dados numa publicacao)
  app.get('/api/relatorios-status', (req, res) => {
    const secret = req.header('X-Sync-Secret');
    if (!secret || secret !== SYNC_SECRET) return res.status(403).json({ ok: false });
    res.json({ ok: true, carregado: !!dados, syncedAt: dados ? dados.syncedAt : null });
  });

  // dados de um relatorio: empresas do usuario + periodo, ja somados, compactados e guardados ate a proxima carga
  app.get('/api/relatorios/:nome', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rel = RELATORIOS[req.params.nome];
    if (!rel) return res.status(404).json({ ok: false, motivo: 'desconhecido' });
    if (!abaLiberada(req.abas, rel.aba)) return res.status(403).json({ ok: false, motivo: 'aba_nao_liberada' });
    if (!dados || !rel.limites(dados)) return res.json({ ok: false, motivo: 'sem_dados' });
    const limites = rel.limites(dados);
    const per = periodo(req.query, limites);
    const empresas = empresasDoUsuario(req.userEmail).slice().sort();
    const k = [req.params.nome, per.de, per.ate, empresas.join(',')].join('|');
    let gz = cache.get(k);
    if (gz) cache.delete(k);
    else gz = zlib.gzipSync(JSON.stringify(Object.assign({ ok: true, syncedAt: dados.syncedAt, geradoEm: dados.geradoEm, periodo: per, limites }, rel.monta(dados, new Set(empresas), per))));
    cache.set(k, gz);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    res.type('application/json');
    res.set('Vary', 'Accept-Encoding');
    if (/gzip/.test(String(req.headers['accept-encoding'] || ''))) { res.set('Content-Encoding', 'gzip'); return res.send(gz); }
    res.send(zlib.gunzipSync(gz));
  });

  // codigo das telas (fica fora do HTML da pagina; so quem esta logado baixa): a aba Vendas Detalhadas e os componentes
  // comuns que ela usa (filtro de selecao multipla, cadeado)
  for (const [rota, arquivo] of [['/componentes.js', 'componentes_tela.js'], ['/vendas.js', 'vendas_tela.js']]) {
    const caminho = path.join(__dirname, arquivo);
    app.get(rota, requireAuth, (req, res) => {
      res.type('application/javascript; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      res.sendFile(caminho);
    });
  }

  return { temDados: () => !!dados };
};

module.exports.periodo = periodo;
module.exports.vendas = vendas;
