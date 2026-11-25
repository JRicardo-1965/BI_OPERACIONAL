// Busca de ICCIDs da aba "Consulta de ICCID" (usado pelo server.js do Render e pelo local_server.js).
// O pacote (op_iccid.json.gz, gerado pelo cruza_iccid.js) traz 1 linha por venda de chip ORDENADA pelo ICCID; aqui ele
// fica em memoria como um texto unico + posicao de cada linha, e a busca e binaria (sem 1 objeto por chip).
// Vendas de dois sistemas: Mira (atual) e SGR (o sistema antigo, marcado com "S" no 9o campo). O SGR guarda o ICCID com
// 19 digitos (sem o digito verificador) quando a operadora nao tem a ativacao.
// Aceita ICCID de 20 digitos (exato + venda gravada so com os 19 primeiros) ou de 19 (casa pelo inicio).
const zlib = require('zlib');

function carregaPacote(buf) {
  // descompacta num bloco unico (2026-11-06): o rodape do gzip guarda o tamanho descompactado (ISIZE, modulo 4 GB).
  // Sem isso o zlib junta milhares de pedacos de 16 KB e copia tudo de novo (2 x 69 MB fora do heap a cada carga).
  const isize = buf.length >= 4 ? buf.readUInt32LE(buf.length - 4) : 0;
  const chunkSize = Math.min(Math.max(isize + 64 * 1024, 64 * 1024), 512 * 1024 * 1024);
  const j = JSON.parse(zlib.gunzipSync(buf, { chunkSize }).toString('utf8'));
  const s = j.linhas || '';
  const pos = [];
  for (let p = 0; p < s.length;) { pos.push(p); const q = s.indexOf('\n', p); p = q < 0 ? s.length : q + 1; }
  return { meta: j.meta || {}, dic: j.dic || {}, s, pos: Uint32Array.from(pos) };
}

const linhaEm = (P, i) => { const ini = P.pos[i], fim = i + 1 < P.pos.length ? P.pos[i + 1] - 1 : P.s.length; return P.s.slice(ini, fim); };

// primeira linha cujo ICCID (prefixo do mesmo tamanho da chave) e >= chave
function limiteInferior(P, chave) {
  let lo = 0, hi = P.pos.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (P.s.substr(P.pos[m], chave.length) < chave) lo = m + 1; else hi = m; }
  return lo;
}

// rotulo da situacao de ativacao, considerando ate quando cada operadora tem dados de ativacao no DW e, no SGR, desde
// quando (o DW so tem as ativacoes de chips do SGR a partir de 2024)
function ativacaoDe(ativ, operadora, dataVenda, corte, inicio) {
  if (ativ === 'S') return { situacao: 'Ativado', data: '' };
  if (ativ) return { situacao: 'Ativado', data: ativ };
  const c = (corte || {})[operadora];
  if (!c) return { situacao: 'Sem dados de ativação da operadora', data: '' };
  if (dataVenda > c) return { situacao: 'Sem dados de ativação depois da venda', data: '', ate: c };
  const ini = (inicio || {})[operadora];
  if (ini && dataVenda < ini) return { situacao: 'Sem dados de ativação da época da venda', data: '', desde: ini };
  return { situacao: 'Não ativado', data: '', ate: c };
}

function decodifica(P, linha) {
  const [iccid, dataVenda, o, empresa, p, pedido, c, ativ, sis] = linha.split('\t');
  const sgr = sis === 'S', op = (P.dic.operadoras || [])[+o] || '', cli = (P.dic.clientes || [])[+c] || [], prod = (P.dic.produtos || [])[+p] || [];
  return {
    iccid, sistema: sgr ? 'SGR' : 'Mira', dataVenda, operadora: op, codEmpresa: empresa,
    filial: (sgr ? P.dic.filiaisSgr || {} : P.dic.filiais || {})[empresa] || empresa, pedido,
    comprador: cli[0] || '', tipoLoja: cli[1] || '', cidade: cli[2] || '', uf: cli[3] || '', segmentoSgr: sgr ? cli[5] || '' : '',
    produto: prod[0] || '', tipoChip: prod[1] || '',
    ativacao: ativacaoDe(ativ, op, dataVenda, P.meta.corteAtivacao, sgr ? (P.meta.sgr || {}).inicioAtivacao : null),
  };
}

// iccids: textos digitados/colados; podeEmpresa(codEmpresa) -> bool (filtro do usuario, vendas do Mira); podeSgr: vendas
// do SGR (so para quem tem todas as empresas). Chip que o usuario nao pode ver conta como "nao encontrado" (nao revela
// que existe). Cada resultado leva a referencia do ICCID consultado: Mira, SGR ou Mira e SGR.
function consulta(P, iccids, podeEmpresa, podeSgr) {
  const vistos = new Set(), resultados = [], naoEncontrados = [], invalidos = [];
  let repetidos = 0;
  const pode = (r) => (r.sistema === 'SGR' ? podeSgr === true : podeEmpresa(r.codEmpresa));
  for (const bruto of iccids) {
    const k = String(bruto == null ? '' : bruto).replace(/[^0-9]/g, '');
    if (!k) continue;
    if (vistos.has(k)) { repetidos++; continue; }
    vistos.add(k);
    if (k.length !== 19 && k.length !== 20) { invalidos.push(String(bruto).trim().slice(0, 40)); continue; }
    const achados = [];
    const varre = (chave, aceita) => {
      for (let i = limiteInferior(P, chave); i < P.pos.length && achados.length < 10 && P.s.substr(P.pos[i], chave.length) === chave; i++) {
        const l = linhaEm(P, i);
        if (!aceita(l)) continue;
        const r = decodifica(P, l);
        if (pode(r)) achados.push(r);
      }
    };
    varre(k, () => true);
    // 20 digitos: tambem a venda gravada so com os 19 primeiros (SGR sem ativacao na operadora)
    if (k.length === 20) varre(k.slice(0, 19), (l) => l.charAt(19) === '\t');
    if (achados.length) {
      const sis = new Set(achados.map((r) => r.sistema)), referencia = sis.size > 1 ? 'Mira e SGR' : [...sis][0];
      for (const r of achados) resultados.push(Object.assign({ consultado: k, referencia }, r));
    } else naoEncontrados.push(k);
  }
  return { resultados, naoEncontrados, invalidos, repetidos };
}

// Chips (ICCID) de cada pedido do Mira (2026-11-25, Excel da aba Faturamento & Pedidos: aba "Ativacoes por pedido"). O
// indice empresa|pedido -> linhas do pacote e montado na primeira vez e fica no proprio pacote (o proximo pacote monta o
// seu). So vendas do Mira: o pedido do SGR e outra numeracao.
function indicePorPedido(P) {
  if (P.porPedido) return P.porPedido;
  const lista = new Map();
  for (let i = 0; i < P.pos.length; i++) {
    const v = linhaEm(P, i).split('\t');
    if (v[8] === 'S' || !v[5]) continue;
    const k = v[3] + '|' + v[5], a = lista.get(k);
    if (a) a.push(i); else lista.set(k, [i]);
  }
  const m = new Map();
  for (const [k, a] of lista) m.set(k, Uint32Array.from(a));
  P.porPedido = m;
  return m;
}

// chaves: "empresa|pedido" dos pedidos exportados; podeEmpresa(codEmpresa) -> bool (pedido de empresa que o usuario nao
// tem fica de fora); teto: maximo de chips numa resposta (acima dele volta so o total, para a pagina avisar). Cada chip vai
// como [indice em pedidos, ICCID, data da venda, operadora, produto, situacao de ativacao, data da ativacao, dados de
// ativacao ate], na ordem do ICCID; operadora, produto e situacao vao como indice nas listas de dic (resposta menor).
function chipsDosPedidos(P, chaves, podeEmpresa, teto) {
  const idx = indicePorPedido(P), vistos = new Set(), achados = [];
  let total = 0;
  for (const bruto of chaves) {
    const k = String(bruto == null ? '' : bruto).trim();
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    const lin = idx.get(k);
    if (!lin || !podeEmpresa(k.split('|')[0])) continue;
    achados.push([k, lin]);
    total += lin.length;
  }
  if (teto && total > teto) return { excedeu: true, total, teto, pedidos: [], chips: [], dic: {} };
  const dic = { operadoras: [], produtos: [], situacoes: [] }, ix = { operadoras: new Map(), produtos: new Map(), situacoes: new Map() };
  const cod = (lista, chave, valor) => { let i = ix[lista].get(chave); if (i === undefined) { i = dic[lista].length; dic[lista].push(valor); ix[lista].set(chave, i); } return i; };
  const pedidos = [], chips = [];
  for (const [k, lin] of achados) {
    const pi = pedidos.length;
    pedidos.push(k);
    for (const i of lin) {
      const r = decodifica(P, linhaEm(P, i));
      chips.push([pi, r.iccid, r.dataVenda, cod('operadoras', r.operadora, r.operadora), cod('produtos', r.produto + '|' + r.tipoChip, [r.produto, r.tipoChip]),
        cod('situacoes', r.ativacao.situacao, r.ativacao.situacao), r.ativacao.data || '', r.ativacao.ate || '']);
    }
  }
  return { excedeu: false, total, teto, pedidos, chips, dic };
}
module.exports = { carregaPacote, consulta, chipsDosPedidos };
