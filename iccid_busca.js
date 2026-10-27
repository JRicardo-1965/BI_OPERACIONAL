// Busca de ICCIDs da aba "Consulta de ICCID" (usado pelo server.js do Render e pelo local_server.js).
// O pacote (op_iccid.json.gz, gerado pelo cruza_iccid.js) traz 1 linha por chip ORDENADA pelo ICCID; aqui ele fica em
// memoria como um texto unico + posicao de cada linha, e a busca e binaria (sem 1 objeto por chip).
// Aceita ICCID de 20 digitos (exato) ou de 19 (sem o digito verificador: casa pelo inicio).
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

// rotulo da situacao de ativacao, considerando ate quando cada operadora tem dados de ativacao no DW
function ativacaoDe(ativ, operadora, dataVenda, corte) {
  if (ativ === 'S') return { situacao: 'Ativado', data: '' };
  if (ativ) return { situacao: 'Ativado', data: ativ };
  const c = (corte || {})[operadora];
  if (!c) return { situacao: 'Sem dados de ativação da operadora', data: '' };
  if (dataVenda > c) return { situacao: 'Sem dados de ativação depois da venda', data: '', ate: c };
  return { situacao: 'Não ativado', data: '', ate: c };
}

function decodifica(P, linha) {
  const [iccid, dataVenda, o, empresa, p, pedido, c, ativ] = linha.split('\t');
  const op = (P.dic.operadoras || [])[+o] || '', cli = (P.dic.clientes || [])[+c] || [], prod = (P.dic.produtos || [])[+p] || [];
  return {
    iccid, dataVenda, operadora: op, codEmpresa: empresa, filial: (P.dic.filiais || {})[empresa] || empresa, pedido,
    comprador: cli[0] || '', tipoLoja: cli[1] || '', cidade: cli[2] || '', uf: cli[3] || '',
    produto: prod[0] || '', tipoChip: prod[1] || '', ativacao: ativacaoDe(ativ, op, dataVenda, P.meta.corteAtivacao),
  };
}

// iccids: textos digitados/colados; podeEmpresa(codEmpresa) -> bool (filtro do usuario). Chip de empresa que o usuario
// nao tem conta como "nao encontrado" (nao revela que existe).
function consulta(P, iccids, podeEmpresa) {
  const vistos = new Set(), resultados = [], naoEncontrados = [], invalidos = [];
  let repetidos = 0;
  for (const bruto of iccids) {
    const k = String(bruto == null ? '' : bruto).replace(/[^0-9]/g, '');
    if (!k) continue;
    if (vistos.has(k)) { repetidos++; continue; }
    vistos.add(k);
    if (k.length !== 19 && k.length !== 20) { invalidos.push(String(bruto).trim().slice(0, 40)); continue; }
    const achados = [];
    for (let i = limiteInferior(P, k); i < P.pos.length && P.s.substr(P.pos[i], k.length) === k; i++) {
      const r = decodifica(P, linhaEm(P, i));
      if (podeEmpresa(r.codEmpresa)) achados.push(r);
      if (achados.length >= 10) break;
    }
    if (achados.length) for (const r of achados) resultados.push(Object.assign({ consultado: k }, r));
    else naoEncontrados.push(k);
  }
  return { resultados, naoEncontrados, invalidos, repetidos };
}

module.exports = { carregaPacote, consulta };
