// =====================================================================================================================
// Aba "Vendas Detalhadas" do BI Operacional - tela (servida em /vendas.js, carregada depois de /relatorios.js).
// 23/11/2026: incrementada com o que o "Relatório de Vendas" do BI antigo tinha (decisão do usuário: incrementar a aba
// em vez de criar uma lista paralela): cluster, segmento, consultores, CNPJ/CPF, grupo da meta, pedido do Aqui Tem+,
// situação do pagamento, tipo de pedido, quem digitou, tipo de envio; período De/Até; filtros de seleção múltipla; cadeado.
// Para não poluir: a lista mostra as colunas principais e o resto entra pelo botão "Colunas" (o Excel sai com todas);
// "Resumir por" troca a lista por um resumo (substitui a antiga janela de Sumarização e o detalhe por filial dos cartões).
// Dados: GET /api/relatorios/vendas (montados com as regras do Comercial em relatorios/monta_relatorios.js).
// Regra do projeto: nada de barra invertida neste arquivo.
// =====================================================================================================================
(function () {
  "use strict";
  const R = window.BiRel;
  if (!R) return; // sem os componentes comuns (versão local do BI): a aba mostra o aviso do template
  const { Msel, esc, fmtInt, fmtR, fmtData, porNome } = R;
  const el = (id) => document.getElementById(id);
  const raiz = () => el("vd-raiz");
  const POR_PAGINA = 300;

  // ---------------------------------------------------------------- estilos próprios (o resto vem da aba Relatórios)
  const CSS = [
    "#vd-raiz [hidden]{ display:none !important; }", // o display das classes abaixo não pode vencer o hidden
    "#vd-raiz .vd-kpis{ display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin:0 0 12px; }",
    "@media (max-width:760px){ #vd-raiz .vd-kpis{ grid-template-columns:repeat(2, minmax(0, 1fr)); } }",
    "#vd-raiz .vd-kpi{ border:1px solid var(--border); background:var(--surface); border-radius:12px; padding:10px 12px; box-shadow:var(--shadow); min-width:0; }",
    "#vd-raiz .vd-kpi b{ display:block; font-family:var(--mono); font-size:19px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
    "#vd-raiz .vd-kpi span{ font-size:11px; color:var(--text-muted); }",
    "#vd-raiz .vd-kpi small{ display:block; font-size:10.5px; color:var(--text-faint); margin-top:2px; }",
    "#vd-raiz .vd-mais{ border:0; background:none; color:var(--accent); font:inherit; font-size:12px; font-weight:700; cursor:pointer; padding:5px 2px; align-self:flex-end; }",
    "#vd-raiz .vd-filtros-extra{ display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin:-2px 0 10px; padding:8px 10px; border:1px dashed var(--border); border-radius:10px; }",
    "#vd-raiz .vd-pag{ display:flex; justify-content:center; gap:8px; margin:10px 0 0; }",
    "#vd-raiz .vd-tag{ display:inline-block; font-size:10.5px; font-weight:700; border-radius:100px; padding:1px 8px; border:1px solid var(--border); font-family:var(--sans); }",
    "#vd-raiz .vd-tag.t-vencido{ color:var(--danger); border-color:var(--danger); background:var(--danger-soft); }",
    "#vd-raiz .vd-tag.t-avencer{ color:var(--warning); border-color:var(--warning); background:var(--warning-soft); }",
    "#vd-raiz .vd-tag.t-pago{ color:var(--ok); border-color:var(--ok); background:var(--ok-soft); }",
    "#vd-raiz .vd-tag.t-outro{ color:var(--text-muted); }",
    "#vd-raiz .rel-tab td.vd-txt{ font-family:var(--sans); text-align:left; }",
    "#vd-raiz .rel-tab th.vd-txt{ text-align:left; }",
    "#vd-raiz .rel-tab td.vd-cod{ font-family:var(--mono); text-align:left; color:var(--text-muted); }",
    "#vd-raiz .vd-col-lista label{ text-transform:none; letter-spacing:0; }",
  ].join("");
  function garanteEstilo() {
    R.garanteEstilo();
    if (el("vd-estilo")) return;
    const s = document.createElement("style"); s.id = "vd-estilo"; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- dados
  const vd = {
    dados: null, de: "", ate: "", busca: "", maisFiltros: false, visao: "lista", resumir: "produto",
    ordem: { k: "data", asc: false }, limite: POR_PAGINA, filtros: {}, colunas: null,
  };
  async function carrega() {
    Msel.fecha();
    raiz().innerHTML = `<div class="rel-aviso">Carregando as vendas…</div>`;
    let d;
    try {
      const q = vd.de && vd.ate ? "?de=" + vd.de + "&ate=" + vd.ate : "";
      const r = await fetch("/api/relatorios/vendas" + q, { credentials: "same-origin" });
      d = r.status === 403 ? { ok: false, motivo: "aba_nao_liberada" } : r.ok ? await r.json() : { ok: false, motivo: "erro" };
    } catch (e) { d = { ok: false, motivo: "erro" }; }
    if (!d.ok) {
      const motivos = { sem_dados: "Os dados de vendas ainda não chegaram ao servidor. Tente de novo em alguns minutos.", aba_nao_liberada: "A aba Vendas Detalhadas não está liberada para o seu usuário.", erro: "Não consegui carregar as vendas. Tente de novo." };
      raiz().innerHTML = `<div class="rel-aviso">${esc(motivos[d.motivo] || motivos.erro)}</div>`;
      return;
    }
    const ixP = Object.fromEntries(d.pdvCols.map((c, i) => [c, i])), ixD = Object.fromEntries(d.pedCols.map((c, i) => [c, i]));
    const pdvs = d.pdvs.map((p) => ({ emp: p[ixP.emp], empD: p[ixP.empD], cod: p[ixP.cod], nome: p[ixP.nome], seg: p[ixP.seg], uf: p[ixP.uf], cid: p[ixP.cid], cl: p[ixP.cl] || "Sem cluster", ce: p[ixP.ce] || "Sem consultor", vi: p[ixP.vi] || "Sem vendedor", doc: p[ixP.doc] || "" }));
    const peds = d.pedidos.map((p) => ({ emp: p[ixD.emp], ped: p[ixD.ped], aqt: p[ixD.aqt], dig: p[ixD.dig] || "—", env: p[ixD.env] || "—", pag: p[ixD.pag], tipo: p[ixD.tipo] || "—", proc: p[ixD.proc], aberto: p[ixD.aberto] || 0, vencido: p[ixD.vencido] || 0 }));
    d.lista = d.linhas.map((l) => ({ dia: l[0], pdv: pdvs[l[1]], ped: peds[l[2]], vend: d.nomesVendidos[l[3]], prod: d.produtos[l[4]], qte: l[5], unit: l[6], total: l[7] }));
    vd.dados = d; vd.de = d.periodo.de; vd.ate = d.periodo.ate; vd.limite = POR_PAGINA;
    desenha();
  }
  const nomeFilial = (cod) => (vd.dados.empresas || {})[cod] || "Filial " + cod;

  // ---------------------------------------------------------------- colunas da lista (o Excel sai com todas)
  const COLUNAS = [
    { k: "data", rot: "Data", padrao: true, val: (l) => l.dia, html: (l) => fmtData(l.dia), x: ["d", (l) => l.dia] },
    { k: "filial", rot: "Filial", val: (l) => nomeFilial(l.pdv.empD), x: ["t"] },
    { k: "pedido", rot: "Pedido", padrao: true, val: (l) => l.ped.emp + "." + l.ped.ped, cls: "vd-cod", x: ["t"] },
    { k: "aqt", rot: "Pedido AQT+", val: (l) => l.ped.aqt || "", cls: "vd-cod", x: ["t"] },
    { k: "pdv", rot: "PDV", padrao: true, val: (l) => l.pdv.nome, x: ["t"] },
    { k: "codigo", rot: "Código", val: (l) => l.pdv.emp + "/" + l.pdv.cod, cls: "vd-cod", x: ["t"] },
    { k: "doc", rot: "CNPJ/CPF", val: (l) => l.pdv.doc, cls: "vd-cod", x: ["t"] },
    { k: "seg", rot: "Segmento", val: (l) => l.pdv.seg, x: ["t"] },
    { k: "cidade", rot: "Cidade-UF", padrao: true, val: (l) => (l.pdv.cid || "—") + "-" + (l.pdv.uf || ""), x: ["t"] },
    { k: "cl", rot: "Cluster", padrao: true, val: (l) => l.pdv.cl, x: ["t"] },
    { k: "ce", rot: "Consultor", val: (l) => l.pdv.ce, x: ["t"] },
    { k: "vi", rot: "Vendedor interno", val: (l) => l.pdv.vi, x: ["t"] },
    { k: "grupo", rot: "Grupo", val: (l) => l.prod.g, x: ["t"] },
    { k: "produto", rot: "Produto/Serviço", padrao: true, val: (l) => l.vend, x: ["t"] },
    { k: "qte", rot: "Qtd", padrao: true, num: true, val: (l) => l.qte, html: (l) => fmtInt(l.qte), x: ["n0"] },
    { k: "unit", rot: "Vr. unit.", num: true, val: (l) => l.unit, html: (l) => "R$ " + l.unit.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), x: ["n"] },
    { k: "total", rot: "Valor", padrao: true, num: true, val: (l) => l.total, html: (l) => fmtR(l.total), x: ["n"] },
    { k: "pag", rot: "Pagamento (AQT+)", padrao: true, val: (l) => l.ped.pag, html: (l) => tagPag(l.ped.pag), x: ["t"] },
    // valores do PEDIDO (não do item): repetem nas linhas do mesmo pedido; o Total e o Excel contam cada pedido uma vez
    { k: "aberto", rot: "Em aberto do pedido (AQT+)", num: true, porPedido: true, val: (l) => l.ped.aberto, html: (l) => (l.ped.aberto ? fmtR(l.ped.aberto) : "–"), x: ["n"] },
    { k: "vencido", rot: "Vencido do pedido (AQT+)", num: true, porPedido: true, val: (l) => l.ped.vencido, html: (l) => (l.ped.vencido ? fmtR(l.ped.vencido) : "–"), x: ["n"] },
    { k: "tipo", rot: "Tipo de pedido", val: (l) => l.ped.tipo, x: ["t"] },
    { k: "dig", rot: "Digitado por", val: (l) => l.ped.dig, x: ["t"] },
    { k: "env", rot: "Tipo de envio", val: (l) => l.ped.env, x: ["t"] },
    { k: "proc", rot: "Processado em", val: (l) => l.ped.proc, html: (l) => l.ped.proc ? fmtData(l.ped.proc) + l.ped.proc.slice(10) : "", x: ["t"] },
  ];
  vd.colunas = new Set(COLUNAS.filter((c) => c.padrao).map((c) => c.k));
  // situação do pedido no Aqui Tem+ (mesma regra da Detalhamento Inadimplência: pago em parte com saldo vencido = vencido)
  function tagPag(p) {
    const t = String(p || "");
    const cls = /a vencer/i.test(t) ? "t-avencer" : /vencido/i.test(t) ? "t-vencido" : /^Pago($| com saldo)/.test(t) ? "t-pago" : "t-outro";
    return `<span class="vd-tag ${cls}">${esc(t)}</span>`;
  }
  /** soma de um valor do pedido contando cada pedido uma vez */
  const porPedido = (linhas, campo) => { const vistos = new Set(); let s = 0; for (const l of linhas) { const k = l.ped.emp + "." + l.ped.ped; if (!vistos.has(k)) { vistos.add(k); s += l.ped[campo]; } } return s; };

  // ---------------------------------------------------------------- filtros (seleção múltipla; os principais à vista)
  const FILTROS = [
    { k: "filial", rot: "Filial", val: (l) => String(l.pdv.empD), texto: (v) => nomeFilial(v) },
    { k: "cl", rot: "Cluster", val: (l) => l.pdv.cl },
    { k: "ce", rot: "Consultor", val: (l) => l.pdv.ce },
    { k: "grupo", rot: "Grupo", val: (l) => l.prod.g },
    { k: "produto", rot: "Produto/Serviço", val: (l) => l.vend },
    { k: "seg", rot: "Segmento", val: (l) => l.pdv.seg, extra: true },
    { k: "vi", rot: "Vendedor interno", val: (l) => l.pdv.vi, extra: true },
    { k: "uf", rot: "UF", val: (l) => l.pdv.uf || "—", extra: true },
    { k: "cid", rot: "Cidade", val: (l) => l.pdv.cid || "—", extra: true },
    { k: "pag", rot: "Pagamento", val: (l) => l.ped.pag, extra: true },
    { k: "tipo", rot: "Tipo de pedido", val: (l) => l.ped.tipo, extra: true },
    { k: "dig", rot: "Digitado por", val: (l) => l.ped.dig, extra: true },
    { k: "env", rot: "Tipo de envio", val: (l) => l.ped.env, extra: true },
  ];
  for (const f of FILTROS) vd.filtros[f.k] = new Set();
  function filtradas(exceto) {
    const b = vd.busca.trim().toLowerCase(), bDig = b.split("").filter((c) => c >= "0" && c <= "9").join("");
    return vd.dados.lista.filter((l) => R.segmentoVisivel(l.pdv.seg)
      && FILTROS.every((f) => f.k === exceto || !vd.filtros[f.k].size || vd.filtros[f.k].has(f.val(l)))
      && (!b || l.pdv.nome.toLowerCase().includes(b) || String(l.ped.ped).includes(b) || String(l.ped.aqt).includes(b) || (bDig.length >= 4 && l.pdv.doc.split("").filter((c) => c >= "0" && c <= "9").join("").includes(bDig))));
  }
  const algumExtraAtivo = () => FILTROS.some((f) => f.extra && vd.filtros[f.k].size);

  // ---------------------------------------------------------------- resumo
  const RESUMOS = [
    ["produto", "Produto/Serviço", (l) => l.vend], ["grupo", "Grupo", (l) => l.prod.g], ["filial", "Filial", (l) => nomeFilial(l.pdv.empD)],
    ["cl", "Cluster", (l) => l.pdv.cl], ["ce", "Consultor", (l) => l.pdv.ce], ["pdv", "PDV", (l) => l.pdv.nome + " · " + l.pdv.emp + "/" + l.pdv.cod],
    ["dia", "Dia", (l) => l.dia], ["pag", "Pagamento", (l) => l.ped.pag], ["tipo", "Tipo de pedido", (l) => l.ped.tipo],
  ];
  function resumo(linhas) {
    const f = RESUMOS.find((r) => r[0] === vd.resumir)[2], m = new Map();
    for (const l of linhas) {
      const k = f(l); let e = m.get(k);
      if (!e) { e = { k, qte: 0, total: 0, peds: new Set(), pdvs: new Set(), aberto: 0, vencido: 0 }; m.set(k, e); }
      e.qte += l.qte; e.total += l.total; e.pdvs.add(l.pdv.emp + "/" + l.pdv.cod);
      const kp = l.ped.emp + "." + l.ped.ped;
      if (!e.peds.has(kp)) { e.peds.add(kp); e.aberto += l.ped.aberto; e.vencido += l.ped.vencido; } // valor do pedido, uma vez
    }
    const arr = [...m.values()];
    const ordem = vd.ordem.k;
    if (vd.resumir === "dia" && (ordem === "data" || ordem === "k")) arr.sort((a, b) => (a.k < b.k ? -1 : 1) * (vd.ordem.asc ? 1 : -1));
    else if (ordem === "k") arr.sort((a, b) => porNome(a.k, b.k) * (vd.ordem.asc ? 1 : -1));
    else { const v = (e) => (ordem === "qte" ? e.qte : ordem === "peds" ? e.peds.size : ordem === "pdvs" ? e.pdvs.size : ordem === "aberto" ? e.aberto : ordem === "vencido" ? e.vencido : e.total); arr.sort((a, b) => (v(a) - v(b)) * (vd.ordem.asc ? 1 : -1)); }
    return arr;
  }

  // ---------------------------------------------------------------- tela: topo, cartões, filtros e opções (fixos)
  function desenha() {
    garanteEstilo();
    Msel.fecha();
    const d = vd.dados;
    const meses = [];
    for (let m = d.limites.max.slice(0, 7); m >= d.limites.min.slice(0, 7);) { meses.push(m); const [a, mm] = m.split("-").map(Number); m = new Date(Date.UTC(a, mm - 2, 1)).toISOString().slice(0, 7); }
    const mesAtual = vd.de.slice(0, 7) === vd.ate.slice(0, 7) && vd.de.endsWith("-01") ? vd.de.slice(0, 7) : "";
    const defs = FILTROS.map((f) => ({
      id: "vd-f-" + f.k, rot: f.rot, sel: vd.filtros[f.k], extra: f.extra,
      opcoes: () => [...new Set(filtradas(f.k).map(f.val))].map((v) => [v, f.texto ? f.texto(v) : v]).sort((a, b) => porNome(a[1], b[1])),
      aoMudar: () => { vd.limite = POR_PAGINA; atualiza(); },
    }));
    const visiveis = defs.filter((x) => !x.extra), extras = defs.filter((x) => x.extra);
    const segBtns = (id, ops, atual) => `<span class="rel-seg" id="${id}">${ops.map(([v, t]) => `<button type="button" data-v="${v}" class="${v === atual ? "is-ativo" : ""}">${t}</button>`).join("")}</span>`;
    const colunasDef = { id: "vd-colunas", rot: "Colunas", sel: vd.colunas, opcoes: () => COLUNAS.map((c) => [c.k, c.rot]), rotulo: (sel) => sel.size + " de " + COLUNAS.length, aoMudar: () => tabela() };
    raiz().innerHTML = `<div class="rel-topo"><div><h2>Vendas Detalhadas</h2><p>Itens vendidos linha a linha (pedido × produto), com cluster e consultores pelas regras do Comercial, grupo da meta, pedido do Aqui Tem+ e situação do pagamento no Aqui Tem+ (mesma base da Consulta de Títulos; vencido inclui o pago em parte, como na Detalhamento Inadimplência). Frete fora. Dados de ${fmtData(d.limites.min)} a ${fmtData(d.limites.max)}.</p></div>${R.cadeadoHtml("vd-cadeado")}</div>`
      + `<div class="vd-kpis" id="vd-kpis"></div>`
      + `<div class="rel-filtros"><div class="rel-campo"><label for="vd-mes">Mês</label><select id="vd-mes" class="rel-btn"><option value="">Período livre</option>${meses.map((m) => `<option value="${m}"${m === mesAtual ? " selected" : ""}>${m.slice(5)}/${m.slice(0, 4)}</option>`).join("")}</select></div>`
      + `<div class="rel-campo"><label for="vd-de">De</label><input type="date" id="vd-de" value="${vd.de}" min="${d.limites.min}" max="${d.limites.max}"></div><div class="rel-campo"><label for="vd-ate">Até</label><input type="date" id="vd-ate" value="${vd.ate}" min="${d.limites.min}" max="${d.limites.max}"></div>`
      + visiveis.map(Msel.html).join("")
      + `<div class="rel-campo"><label for="vd-busca">Busca</label><input type="search" id="vd-busca" placeholder="PDV, pedido ou CNPJ/CPF" value="${esc(vd.busca)}"></div>`
      + `<button type="button" class="vd-mais" id="vd-mais">${vd.maisFiltros ? "− Menos filtros" : "+ Mais filtros"}${algumExtraAtivo() ? " •" : ""}</button><button type="button" class="rel-btn" id="vd-limpar">Limpar filtros</button></div>`
      + `<div class="vd-filtros-extra" id="vd-extra"${vd.maisFiltros ? "" : " hidden"}>${extras.map(Msel.html).join("")}</div>`
      + `<div class="rel-opcoes"><span class="rel-grupo"><span class="rel-rot">Ver</span>${segBtns("vd-visao", [["lista", "Lista"], ["resumo", "Resumo"]], vd.visao)}</span>`
      + `<span class="rel-grupo" id="vd-resumir-grupo"${vd.visao === "resumo" ? "" : " hidden"}><span class="rel-rot">Resumir por</span><select id="vd-resumir" class="rel-btn">${RESUMOS.map(([k, t]) => `<option value="${k}"${k === vd.resumir ? " selected" : ""}>${t}</option>`).join("")}</select></span>`
      + `<span id="vd-colunas-grupo"${vd.visao === "lista" ? "" : " hidden"}>${Msel.html(colunasDef)}</span>`
      + `<button type="button" class="rel-btn" id="vd-excel">Exportar Excel</button></div>`
      + `<p class="rel-resumo" id="vd-resumo"></p><div id="vd-tabela"></div>`;
    // o rótulo "Colunas" do seletor fica ao lado do botão, não em cima (está numa linha de opções)
    const lblCol = raiz().querySelector("#vd-colunas-grupo .rel-lbl"); if (lblCol) lblCol.className = "rel-rot";
    const cg = raiz().querySelector("#vd-colunas-grupo .rel-campo"); if (cg) { cg.style.flexDirection = "row"; cg.style.alignItems = "center"; cg.style.gap = "6px"; }
    defs.forEach(Msel.liga); Msel.liga(colunasDef);
    el("vd-cadeado").onclick = () => { R.trocaCadeado(); if (!R.todosSegmentos()) for (const v of [...vd.filtros.seg]) if (!R.SEGMENTOS_PADRAO.includes(v)) vd.filtros.seg.delete(v); desenha(); };
    const novoPeriodo = (de, ate) => { if (!de || !ate || de > ate) return; vd.de = de; vd.ate = ate; carrega(); };
    el("vd-mes").onchange = () => {
      const m = el("vd-mes").value; if (!m) return;
      const [a, mm] = m.split("-").map(Number);
      const fim = m + "-" + String(new Date(a, mm, 0).getDate()).padStart(2, "0");
      novoPeriodo(m + "-01", fim > d.limites.max ? d.limites.max : fim);
    };
    el("vd-de").onchange = el("vd-ate").onchange = () => novoPeriodo(el("vd-de").value, el("vd-ate").value);
    let espera = 0;
    el("vd-busca").oninput = () => { clearTimeout(espera); espera = setTimeout(() => { vd.busca = el("vd-busca").value; vd.limite = POR_PAGINA; atualiza(); }, 250); };
    el("vd-mais").onclick = () => { vd.maisFiltros = !vd.maisFiltros; el("vd-extra").hidden = !vd.maisFiltros; el("vd-mais").textContent = (vd.maisFiltros ? "− Menos filtros" : "+ Mais filtros") + (algumExtraAtivo() ? " •" : ""); };
    el("vd-limpar").onclick = () => { for (const s of Object.values(vd.filtros)) s.clear(); vd.busca = ""; vd.limite = POR_PAGINA; desenha(); };
    el("vd-visao").onclick = (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      vd.visao = b.dataset.v; vd.ordem = vd.visao === "lista" ? { k: "data", asc: false } : { k: "total", asc: false };
      el("vd-visao").querySelectorAll("button").forEach((x) => x.classList.toggle("is-ativo", x === b));
      el("vd-resumir-grupo").hidden = vd.visao !== "resumo"; el("vd-colunas-grupo").hidden = vd.visao !== "lista";
      tabela();
    };
    el("vd-resumir").onchange = () => { vd.resumir = el("vd-resumir").value; vd.ordem = { k: vd.resumir === "dia" ? "k" : "total", asc: vd.resumir === "dia" }; tabela(); };
    el("vd-excel").onclick = exporta;
    el("vd-tabela").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-ord]");
      if (th) { const k = th.dataset.ord; vd.ordem = vd.ordem.k === k ? { k, asc: !vd.ordem.asc } : { k, asc: k === "k" }; tabela(); return; }
      const mais = e.target.closest("[data-mais]");
      if (mais) { vd.limite = mais.dataset.mais === "todos" ? Infinity : vd.limite + POR_PAGINA; tabela(); }
    });
    atualiza();
  }
  function atualiza() {
    if (el("vd-mais")) el("vd-mais").textContent = (vd.maisFiltros ? "− Menos filtros" : "+ Mais filtros") + (algumExtraAtivo() ? " •" : "");
    cartoes();
    tabela();
  }

  // ---------------------------------------------------------------- cartões: itens, valor, pedidos, PDVs (+ projeção do mês corrente)
  function cartoes() {
    const ls = filtradas(null), d = vd.dados;
    const qte = ls.reduce((s, l) => s + l.qte, 0), total = ls.reduce((s, l) => s + l.total, 0);
    const peds = new Set(ls.map((l) => l.ped.emp + "." + l.ped.ped)).size, pdvs = new Set(ls.map((l) => l.pdv.emp + "/" + l.pdv.cod)).size;
    // projeção só quando o período é o mês corrente desde o dia 1 até o último dia com dado
    const ultimo = d.limites.max, [a, m] = ultimo.slice(0, 7).split("-").map(Number), diasMes = new Date(a, m, 0).getDate(), dia = Number(ultimo.slice(8, 10));
    const projeta = vd.de === ultimo.slice(0, 8) + "01" && vd.ate === ultimo && dia < diasMes;
    const proj = (v) => projeta ? `<small>projeção do mês: ${v}</small>` : "";
    // situação no Aqui Tem+ dos pedidos filtrados (cada pedido uma vez; mesma base da Consulta de Títulos e da Inadimplência)
    const aberto = porPedido(ls, "aberto"), vencido = porPedido(ls, "vencido");
    const fin = aberto > 0.5 ? `<small>em aberto no AQT+: ${fmtR(aberto)}${vencido > 0.5 ? " · vencido " + fmtR(vencido) : ""}</small>` : "";
    el("vd-kpis").innerHTML = `<div class="vd-kpi"><b>${fmtInt(qte)}</b><span>Itens vendidos</span>${proj(fmtInt((qte / dia) * diasMes))}</div>`
      + `<div class="vd-kpi"><b>${fmtR(total)}</b><span>Valor vendido</span>${proj(fmtR((total / dia) * diasMes))}${fin}</div>`
      + `<div class="vd-kpi"><b>${fmtInt(peds)}</b><span>Pedidos</span>${peds ? `<small>ticket médio ${fmtR(total / peds)}</small>` : ""}</div>`
      + `<div class="vd-kpi"><b>${fmtInt(pdvs)}</b><span>PDVs que compraram</span></div>`;
  }

  // ---------------------------------------------------------------- tabela (lista paginada ou resumo)
  function tabela() {
    const ls = filtradas(null);
    const totQ = ls.reduce((s, l) => s + l.qte, 0), totV = ls.reduce((s, l) => s + l.total, 0);
    const seta = (k) => (vd.ordem.k === k ? (vd.ordem.asc ? " ▴" : " ▾") : "");
    const segTxt = R.todosSegmentos() ? "todos os segmentos" : "só Revenda e Afiliados";
    if (!ls.length) { el("vd-resumo").textContent = `Período ${fmtData(vd.de)} a ${fmtData(vd.ate)} · ${segTxt}`; el("vd-tabela").innerHTML = `<div class="rel-aviso">Nenhuma venda nesse período e filtros.</div>`; return; }
    if (vd.visao === "resumo") {
      const arr = resumo(ls), rot = RESUMOS.find((r) => r[0] === vd.resumir)[1];
      el("vd-resumo").textContent = `${fmtInt(arr.length)} ${rot.toLowerCase()}(s) · ${fmtInt(ls.length)} itens de venda · período ${fmtData(vd.de)} a ${fmtData(vd.ate)} · ${segTxt}`;
      const nome = (e) => vd.resumir === "dia" ? fmtData(e.k) : vd.resumir === "pag" ? tagPag(e.k) : esc(e.k);
      const rs = (v) => (v > 0.5 ? fmtR(v) : "–");
      el("vd-tabela").innerHTML = `<div class="rel-tabwrap"><table class="rel-tab"><thead><tr><th class="rel-ini vd-txt" data-ord="k">${esc(rot)}${seta("k")}</th><th data-ord="qte">Itens${seta("qte")}</th><th data-ord="total">Valor${seta("total")}</th><th>% do valor</th><th data-ord="peds">Pedidos${seta("peds")}</th><th data-ord="pdvs">PDVs${seta("pdvs")}</th><th class="rel-sep" data-ord="aberto" title="Em aberto no Aqui Tem+ dos pedidos (cada pedido uma vez)">Em aberto (AQT+)${seta("aberto")}</th><th data-ord="vencido" title="Em aberto e vencido, inclusive o pago em parte (como a Detalhamento Inadimplência)">Vencido (AQT+)${seta("vencido")}</th></tr></thead>`
        + `<tbody>${arr.map((e) => `<tr><td class="rel-ini">${nome(e)}</td><td>${fmtInt(e.qte)}</td><td>${fmtR(e.total)}</td><td>${totV ? ((e.total / totV) * 100).toFixed(1).replace(".", ",") + "%" : "–"}</td><td>${fmtInt(e.peds.size)}</td><td>${fmtInt(e.pdvs.size)}</td><td class="rel-sep">${rs(e.aberto)}</td><td>${rs(e.vencido)}</td></tr>`).join("")}</tbody>`
        + `<tfoot><tr><td class="rel-ini">Total</td><td>${fmtInt(totQ)}</td><td>${fmtR(totV)}</td><td>100%</td><td>${fmtInt(new Set(ls.map((l) => l.ped.emp + "." + l.ped.ped)).size)}</td><td>${fmtInt(new Set(ls.map((l) => l.pdv.emp + "/" + l.pdv.cod)).size)}</td><td class="rel-sep">${rs(porPedido(ls, "aberto"))}</td><td>${rs(porPedido(ls, "vencido"))}</td></tr></tfoot></table></div>`;
      return;
    }
    const cols = COLUNAS.filter((c) => vd.colunas.has(c.k));
    if (!cols.length) { el("vd-tabela").innerHTML = `<div class="rel-aviso">Escolha ao menos uma coluna.</div>`; return; }
    const col = COLUNAS.find((c) => c.k === vd.ordem.k) || COLUNAS[0];
    const ord = ls.slice().sort((a, b) => {
      const x = col.val(a), y = col.val(b);
      const c = col.num ? x - y : porNome(x, y);
      return (c || (a.ped.ped - b.ped.ped)) * (vd.ordem.asc ? 1 : -1);
    });
    const mostra = ord.slice(0, vd.limite);
    el("vd-resumo").textContent = `${fmtInt(ls.length)} itens de venda${mostra.length < ls.length ? ` (mostrando ${fmtInt(mostra.length)})` : ""} · período ${fmtData(vd.de)} a ${fmtData(vd.ate)} · ${segTxt} · clique no título de uma coluna para ordenar`;
    const cel = (c, l, primeira) => `<td class="${primeira ? "rel-ini " : ""}${c.num ? "" : c.cls || "vd-txt"}">${c.html ? c.html(l) : esc(c.val(l))}</td>`;
    const totalCol = (c) => (c.k === "qte" ? fmtInt(totQ) : c.k === "total" ? fmtR(totV) : c.porPedido ? fmtR(porPedido(ls, c.k)) : "");
    const rodape = cols.map((c, i) => `<td class="${i === 0 ? "rel-ini" : c.num ? "" : "vd-txt"}">${i === 0 ? "Total" : totalCol(c)}</td>`).join("");
    el("vd-tabela").innerHTML = `<div class="rel-tabwrap"><table class="rel-tab"><thead><tr>${cols.map((c, i) => `<th class="${i === 0 ? "rel-ini " : ""}${c.num ? "" : "vd-txt"}" data-ord="${c.k}">${esc(c.rot)}${seta(c.k)}</th>`).join("")}</tr></thead>`
      + `<tbody>${mostra.map((l) => `<tr>${cols.map((c, i) => cel(c, l, i === 0)).join("")}</tr>`).join("")}</tbody><tfoot><tr>${rodape}</tr></tfoot></table></div>`
      + (mostra.length < ls.length ? `<div class="vd-pag"><button type="button" class="rel-btn" data-mais="mais">Mostrar mais ${fmtInt(Math.min(POR_PAGINA, ls.length - mostra.length))}</button><button type="button" class="rel-btn" data-mais="todos">Mostrar todos (${fmtInt(ls.length)})</button></div>` : "");
  }

  // ---------------------------------------------------------------- Excel: a lista com todas as colunas, ou o resumo
  function exporta() {
    if (typeof BiXlsx === "undefined") { alert("Exportação indisponível nesta página."); return; }
    const ls = filtradas(null);
    let blob, nome;
    if (vd.visao === "resumo") {
      const rot = RESUMOS.find((r) => r[0] === vd.resumir)[1];
      const cols = [[rot, vd.resumir === "dia" ? "d" : "t", (e) => e.k], ["Itens", "n0", (e) => e.qte], ["Valor", "n", (e) => e.total], ["Pedidos", "n0", (e) => e.peds.size], ["PDVs", "n0", (e) => e.pdvs.size], ["Em aberto (AQT+)", "n", (e) => e.aberto], ["Vencido (AQT+)", "n", (e) => e.vencido]];
      blob = BiXlsx.montaXlsx([{ nome: "Resumo por " + rot.toLowerCase(), xml: BiXlsx.planilhaXml(cols, resumo(ls)) }]);
      nome = `Vendas_por_${vd.resumir}_${vd.de}_a_${vd.ate}.xlsx`;
    } else {
      // valores do pedido só na 1ª linha de cada pedido (somar a coluna no Excel dá o total certo)
      const ord = ls.slice().sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : a.ped.ped - b.ped.ped));
      const primeira = new Set(), vistos = new Set();
      for (const l of ord) { const k = l.ped.emp + "." + l.ped.ped; if (!vistos.has(k)) { vistos.add(k); primeira.add(l); } }
      const cols = COLUNAS.map((c) => [c.rot, c.x[0], c.porPedido ? (l) => (primeira.has(l) ? c.val(l) : null) : (c.x[1] || c.val)]);
      blob = BiXlsx.montaXlsx([{ nome: "Vendas", xml: BiXlsx.planilhaXml(cols, ord) }]);
      nome = `Vendas_${vd.de}_a_${vd.ate}.xlsx`;
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------------------------------------------------------------- entrada (chamada pela troca de aba da página)
  window.renderVendasDetalhe = function () {
    garanteEstilo();
    if (!vd.dados) carrega(); else desenha(); // redesenha ao voltar (o cadeado pode ter mudado em outra aba)
  };
  const conteudo = el("tab-content-vendas-detalhe");
  if (conteudo && !conteudo.classList.contains("is-hidden")) window.renderVendasDetalhe();
})();
