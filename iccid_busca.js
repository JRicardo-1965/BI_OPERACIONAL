// Busca de ICCIDs da aba "Consulta de ICCID" (usado pelo server.js do Render e pelo local_server.js).
// O pacote (op_iccid.json.gz, gerado pelo cruza_iccid.js) traz 1 linha por venda de chip ORDENADA pelo ICCID; aqui ele
// fica em memoria como um texto unico + posicao de cada linha, e a busca e binaria (sem 1 objeto por chip).
// Vendas de dois sistemas: Mira (atual) e SGR (o sistema antigo, marcado com "S" no 9o campo). O SGR guarda o ICCID com
// 19 digitos (sem o digito verificador) quando a operadora nao tem a ativacao.
// Aceita ICCID de 20 digitos (exato + venda gravada so com os 19 primeiros) ou de 19 (casa pelo inicio).
const zlib = require('zlib');

function carregaPacote(buf) {
  const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
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

module.exports = { carregaPacote, consulta };
