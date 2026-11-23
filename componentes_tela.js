// =====================================================================================================================
// BI Operacional - componentes de tela comuns (servidos em /componentes.js, só para quem está logado; ver relatorios.js).
// Nasceram na aba "Relatórios" (19/11/2026), que não foi publicada: os relatórios do BI antigo viraram incrementos das abas
// que já existiam (decisão do usuário, 23/11/2026). Hoje quem usa é a aba Vendas Detalhadas (vendas_tela.js):
//   - filtro de seleção múltipla (Msel), cadeado da página (fechado = só Revenda e Afiliados), formatadores e estilos .rel-*.
// Regra do projeto: nada de barra invertida neste arquivo.
// =====================================================================================================================
(function () {
  "use strict";
  const CHAVE_CADEADO = "op-rel-todos-segmentos";
  const SEGMENTOS_PADRAO = ["Revenda", "Afiliados"];
  let todosSegmentos = false;
  try { todosSegmentos = sessionStorage.getItem(CHAVE_CADEADO) === "1"; } catch (e) { /* sem armazenamento */ }
  const segmentoVisivel = (seg) => todosSegmentos || SEGMENTOS_PADRAO.includes(seg);

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtInt = (n) => Math.round(n || 0).toLocaleString("pt-BR");
  const fmtR = (v) => "R$ " + Math.round(v || 0).toLocaleString("pt-BR");
  const fmtData = (iso) => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "";
  const porNome = (a, b) => String(a).localeCompare(String(b), "pt-BR");
  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- estilos (classes .rel-*, usados pelas abas que usam estes componentes)
  const CSS = [
    ".rel-topo{ display:flex; justify-content:space-between; align-items:flex-start; gap:10px 16px; margin:0 0 14px; }",
    ".rel-topo h2{ margin:0; font-size:18px; color:var(--text); }",
    ".rel-topo p{ margin:3px 0 0; font-size:12px; color:var(--text-muted); max-width:780px; }",
    ".rel-cadeado{ flex:0 0 auto; width:36px; height:36px; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--border); background:var(--surface); border-radius:10px; font-size:17px; line-height:1; cursor:pointer; padding:0; }",
    ".rel-cadeado:hover{ border-color:var(--accent); }",
    ".rel-cadeado.is-aberto{ border-color:var(--warning); background:var(--warning-soft); }",
    ".rel-cartoes{ display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:12px; }",
    ".rel-filtros{ display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; margin:0 0 10px; }",
    ".rel-campo{ display:flex; flex-direction:column; gap:3px; min-width:0; }",
    ".rel-campo label, .rel-campo .rel-lbl{ font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-faint); font-weight:700; }",
    ".rel-campo input{ font:inherit; font-size:12.5px; padding:5px 8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); max-width:200px; }",
    ".rel-msel{ position:relative; }",
    ".rel-msel-btn{ font:inherit; font-size:12.5px; padding:5px 26px 5px 8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); min-width:120px; max-width:200px; text-align:left; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; position:relative; }",
    ".rel-msel-btn::after{ content:'▾'; position:absolute; right:8px; top:50%; transform:translateY(-50%); color:var(--text-faint); }",
    ".rel-msel-btn.is-ativo{ border-color:var(--accent); background:var(--accent-soft); font-weight:700; }",
    ".rel-msel-painel{ position:absolute; z-index:20; top:calc(100% + 4px); left:0; width:260px; max-width:80vw; background:var(--surface); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow); padding:8px; }",
    ".rel-msel-painel input{ width:100%; box-sizing:border-box; font:inherit; font-size:12.5px; padding:5px 8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); }",
    ".rel-msel-acoes{ display:flex; justify-content:space-between; gap:6px; margin:6px 0; }",
    ".rel-msel-acoes button{ border:0; background:none; color:var(--accent); font:inherit; font-size:11.5px; font-weight:700; cursor:pointer; padding:2px 0; }",
    ".rel-msel-lista{ max-height:260px; overflow:auto; }",
    ".rel-msel-lista label{ display:flex; gap:8px; align-items:center; padding:4px 4px; font-size:12.5px; color:var(--text); cursor:pointer; border-radius:6px; text-transform:none; letter-spacing:0; font-weight:500; }",
    ".rel-msel-lista label:hover{ background:var(--surface-2); }",
    ".rel-msel-lista input{ margin:0; width:auto; }",
    ".rel-msel-vazio{ font-size:12px; color:var(--text-faint); padding:6px 4px; }",
    ".rel-opcoes{ display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; margin:0 0 10px; }",
    ".rel-grupo{ display:inline-flex; align-items:center; gap:6px; }",
    ".rel-rot{ font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-faint); font-weight:700; }",
    ".rel-seg{ display:inline-flex; border:1px solid var(--border); border-radius:100px; overflow:hidden; }",
    ".rel-seg button{ border:0; background:var(--surface); color:var(--text-muted); font:inherit; font-size:11.5px; font-weight:700; padding:4px 11px; cursor:pointer; }",
    ".rel-seg button + button{ border-left:1px solid var(--border); }",
    ".rel-seg button.is-ativo{ background:var(--accent); color:#fff; }",
    ".rel-btn{ border:1px solid var(--border); background:var(--surface); color:var(--text); border-radius:100px; padding:4px 11px; font:inherit; font-size:11.5px; font-weight:700; cursor:pointer; }",
    ".rel-btn:hover{ border-color:var(--accent); }",
    ".rel-aviso{ padding:22px; text-align:center; color:var(--text-muted); font-size:13px; }",
    ".rel-resumo{ font-size:11.5px; color:var(--text-muted); margin:0 0 6px; }",
    ".rel-tabwrap{ overflow:auto; max-height:72vh; border:1px solid var(--border); border-radius:10px; background:var(--surface); }",
    ".rel-tab{ border-collapse:separate; border-spacing:0; font-size:12px; min-width:100%; }",
    ".rel-tab th, .rel-tab td{ padding:5px 9px; border-bottom:1px solid var(--border); white-space:nowrap; text-align:right; }",
    ".rel-tab thead th{ position:sticky; z-index:2; background:var(--surface-2); color:var(--text-muted); font-size:10px; text-transform:uppercase; letter-spacing:.04em; font-weight:700; cursor:pointer; }",
    ".rel-tab thead tr:first-child th{ top:0; }",
    ".rel-tab th.rel-ini, .rel-tab td.rel-ini{ position:sticky; left:0; z-index:1; text-align:left; background:var(--surface); max-width:340px; overflow:hidden; text-overflow:ellipsis; }",
    ".rel-tab thead th.rel-ini{ z-index:3; background:var(--surface-2); }",
    ".rel-tab td{ font-family:var(--mono); color:var(--text); font-variant-numeric:tabular-nums; }",
    ".rel-tab td.rel-ini{ font-family:var(--sans); }",
    ".rel-tab td.rel-sep, .rel-tab th.rel-sep{ border-left:1px solid var(--border); }",
    ".rel-tab tfoot td{ position:sticky; bottom:0; z-index:1; background:var(--accent-soft); font-weight:800; border-top:2px solid var(--border); }",
    ".rel-tab tfoot td.rel-ini{ z-index:2; }",
    "@media (max-width:680px){ .rel-msel-btn{ min-width:100px; max-width:150px; } .rel-campo input{ max-width:150px; } .rel-tab th.rel-ini, .rel-tab td.rel-ini{ max-width:180px; } }",
  ].join("");
  function garanteEstilo() {
    if (el("rel-estilo")) return;
    const s = document.createElement("style"); s.id = "rel-estilo"; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- filtro de seleção múltipla (comum a todos os relatórios)
  // def: { id, rot, sel: Set (vazio = todos), opcoes: () => [[valor, texto]] (calculadas ao abrir, já respeitando os outros
  // filtros), aoMudar: () => void }. A lista fica aberta enquanto se marcam vários itens; fecha ao clicar fora ou com Esc.
  const Msel = (() => {
    let aberto = null; // { def, raiz }
    const rotulo = (def, textos) => {
      if (def.rotulo) return def.rotulo(def.sel); // rótulo próprio (ex.: "9 de 22" no seletor de colunas)
      if (!def.sel.size) return "Todos";
      if (def.sel.size === 1) { const v = [...def.sel][0]; return (textos && textos.get(v)) || v; }
      return def.sel.size + " selecionados";
    };
    function html(def) {
      return `<div class="rel-campo"><span class="rel-lbl">${esc(def.rot)}</span><div class="rel-msel" id="${def.id}"><button type="button" class="rel-msel-btn${def.sel.size ? " is-ativo" : ""}" aria-haspopup="true">${esc(rotulo(def, new Map(def.opcoes())))}</button></div></div>`;
    }
    function fecha() { if (aberto) { const p = aberto.raiz.querySelector(".rel-msel-painel"); if (p) p.remove(); aberto = null; } }
    function atualizaBotao(def, raiz) {
      const b = raiz.querySelector(".rel-msel-btn");
      b.textContent = rotulo(def, new Map(def.opcoes()));
      b.classList.toggle("is-ativo", def.sel.size > 0);
    }
    function abre(def, raiz) {
      fecha();
      const painel = document.createElement("div");
      painel.className = "rel-msel-painel";
      painel.innerHTML = `<input type="search" placeholder="Buscar" aria-label="Buscar em ${esc(def.rot)}"><div class="rel-msel-acoes"><button type="button" data-a="marcar">Marcar todos</button><button type="button" data-a="limpar">Limpar</button></div><div class="rel-msel-lista"></div>`;
      raiz.appendChild(painel);
      aberto = { def, raiz };
      const busca = painel.querySelector("input"), lista = painel.querySelector(".rel-msel-lista");
      const visiveis = () => {
        const ops = def.opcoes(), b = busca.value.trim().toLowerCase();
        for (const v of def.sel) if (!ops.some((o) => o[0] === v)) ops.unshift([v, v]); // marcado que saiu da lista continua à vista
        return b ? ops.filter((o) => String(o[1]).toLowerCase().includes(b)) : ops;
      };
      const desenha = () => {
        const ops = visiveis();
        lista.innerHTML = ops.length ? ops.map(([v, t]) => `<label><input type="checkbox" value="${esc(v)}"${def.sel.has(v) ? " checked" : ""}>${esc(t)}</label>`).join("") : `<div class="rel-msel-vazio">Nada encontrado</div>`;
      };
      desenha();
      busca.oninput = desenha;
      lista.onchange = (e) => {
        const c = e.target.closest("input[type=checkbox]");
        if (!c) return;
        if (c.checked) def.sel.add(c.value); else def.sel.delete(c.value);
        atualizaBotao(def, raiz); def.aoMudar();
      };
      painel.querySelector(".rel-msel-acoes").onclick = (e) => {
        const a = e.target.closest("button[data-a]");
        if (!a) return;
        if (a.dataset.a === "limpar") def.sel.clear(); else for (const [v] of visiveis()) def.sel.add(v);
        desenha(); atualizaBotao(def, raiz); def.aoMudar();
      };
      busca.focus();
    }
    function liga(def) {
      const raiz = el(def.id);
      raiz.querySelector(".rel-msel-btn").onclick = () => { if (aberto && aberto.raiz === raiz) fecha(); else abre(def, raiz); };
    }
    document.addEventListener("mousedown", (e) => { if (aberto && !aberto.raiz.contains(e.target)) fecha(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecha(); });
    return { html, liga, fecha };
  })();

  // ---------------------------------------------------------------- cadeado da página (um só para todas as abas)
  function cadeadoHtml(id) {
    const dica = todosSegmentos ? "Todos os segmentos. Clique para mostrar só Revenda e Afiliados." : "Só Revenda e Afiliados. Clique para incluir Parceiros, Agentes Autorizados e Outros.";
    return `<button type="button" class="rel-cadeado${todosSegmentos ? " is-aberto" : ""}" id="${id}" title="${dica}" aria-label="${dica}">${todosSegmentos ? "🔓" : "🔒"}</button>`;
  }

  window.BiRel = {
    Msel, esc, fmtInt, fmtR, fmtData, porNome, garanteEstilo,
    todosSegmentos: () => todosSegmentos,
    segmentoVisivel,
    SEGMENTOS_PADRAO,
    cadeadoHtml,
    // quem usa o cadeado tira da própria seleção, ao fechar, o segmento que deixou de aparecer
    trocaCadeado: () => {
      todosSegmentos = !todosSegmentos;
      try { sessionStorage.setItem(CHAVE_CADEADO, todosSegmentos ? "1" : "0"); } catch (e) { /* sem armazenamento */ }
      Msel.fecha();
    },
  };
})();
