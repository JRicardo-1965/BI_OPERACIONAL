// Backend do BI Operacional (Aqui Tem Mais) — login + filtro por empresa.
//
// Como funciona, em resumo:
// 1. O extract_op.ps1 (rodando no PC do Ricardo, único lugar com acesso ao Access) gera os dados
//    e envia num POST /api/sync protegido por um segredo compartilhado (SYNC_SECRET). Nada mais
//    além desse endpoint consegue gravar dados aqui.
// 2. Login (POST /api/login) confere e-mail+senha contra o snapshot mais recente sincronizado
//    (senha comparada com bcrypt — a senha em texto puro nunca é gravada em disco aqui, só o hash).
//    Mesmas credenciais dos outros BIs (USUARIOS/USUARIOS_EMPRESAS do mesmo Access), mas
//    sincronizadas por um pipeline totalmente separado — este backend não lê nada dos outros.
// 3. Cada requisição autenticada em GET / relê, na hora, quais empresas aquele e-mail tem vinculadas
//    em USUARIOS_EMPRESAS — e manda pro navegador só os dados dessas empresas, filtrados aqui no
//    servidor. O HTML que sai daqui nunca contém dado de empresa que o usuário não pode ver.
//
// Abas: "Faturamento & Pedidos" e "Vendas Detalhadas" — todas filtram por empresa (CodEmpresa).
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SYNC_SECRET = process.env.SYNC_SECRET;
// SSO_SHARED_SECRET habilita o login único vindo do Portal BI (rota /sso) - DIFERENTE do
// SESSION_SECRET. Opcional no boot: a rota /sso só fica ativa quando estiver configurado.
const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET;
const PORTAL_URL = process.env.PORTAL_URL || 'https://bi-portal-hyxm.onrender.com';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!SESSION_SECRET || !SYNC_SECRET) {
  console.error('ERRO: defina as variáveis de ambiente SESSION_SECRET e SYNC_SECRET antes de iniciar.');
  process.exit(1);
}
if (!SSO_SHARED_SECRET) {
  console.warn('Aviso: SSO_SHARED_SECRET não definido — login único via Portal BI (rota /sso) fica desativado até configurar.');
}

const DATA_FILE = path.join(__dirname, 'data', 'data.json');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'dashboard_template.html');
const LOGO_PATH = path.join(__dirname, 'logo_b64.txt');

const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8').replace(/^﻿/, '');
const LOGO_B64 = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH, 'utf8').replace(/^﻿/, '').trim() : '';

// Aba "Detalhamento Inadimplência": conjunto à parte (nome, CPF/CNPJ e títulos) - chega por
// POST /api/sync-inad e sai filtrado por empresa em GET /api/inadimplencia; nunca vai embutido no HTML.
const INAD_FILE = path.join(__dirname, 'data', 'inad.json');
let latestInad = null;
if (fs.existsSync(INAD_FILE)) {
  try {
    latestInad = JSON.parse(fs.readFileSync(INAD_FILE, 'utf8'));
  } catch (err) {
    console.error('Não consegui ler data/inad.json existente, começando sem inadimplência:', err.message);
  }
}

// Aba "Rastreio de Envios": mesmo esquema da inadimplência (nomes de clientes e códigos de rastreio) - chega por
// POST /api/sync-rastreio e sai filtrado por empresa em GET /api/rastreio; nunca vai embutido no HTML.
const RASTREIO_FILE = path.join(__dirname, 'data', 'rastreio.json');
let latestRastreio = null;
if (fs.existsSync(RASTREIO_FILE)) {
  try {
    latestRastreio = JSON.parse(fs.readFileSync(RASTREIO_FILE, 'utf8'));
  } catch (err) {
    console.error('Não consegui ler data/rastreio.json existente, começando sem rastreio:', err.message);
  }
}

// Aba "Consulta de ICCID": o pacote gzip (op_iccid.json.gz do cruza_iccid.js, ~715 mil chips) chega em
// POST /api/sync-iccid e fica em memória como texto ordenado + busca binária (iccid_busca.js); a página só consulta
// os ICCIDs colados em POST /api/iccid/consulta, filtrando pelas empresas do usuário. Nunca vai embutido no HTML.
// Vendas do SGR (o sistema antigo, empresas que não existem no Mira): visíveis para TODO usuário com a aba liberada,
// sem filtro de empresa (decisão do usuário em 28/10; antes era só para quem tinha todas as empresas).
const iccidBusca = require('./iccid_busca');
const ICCID_FILE = path.join(__dirname, 'data', 'iccid.json.gz');
let latestIccid = null;
if (fs.existsSync(ICCID_FILE)) {
  try {
    latestIccid = iccidBusca.carregaPacote(fs.readFileSync(ICCID_FILE));
    latestIccid.syncedAt = fs.statSync(ICCID_FILE).mtime.toISOString();
  } catch (err) {
    console.error('Não consegui ler data/iccid.json.gz existente, começando sem ICCIDs:', err.message);
  }
}

let latestData = null;
if (fs.existsSync(DATA_FILE)) {
  try {
    latestData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`Dados carregados do disco (sincronizados em ${latestData.syncedAt}).`);
  } catch (err) {
    console.error('Não consegui ler data/data.json existente, começando vazio:', err.message);
  }
}

const app = express();
app.disable('x-powered-by');
// trust proxy: o Render fica atras de um proxy reverso - sem isso req.ip devolve o IP interno
// do proxy, nao o do usuario de verdade.
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());

// --- log de acessos por aba (fase 2 - ver [[bi-ressuprimento-local-dashboard]] memoria) ------
// Mesmo padrao do Portal BI (fase 1, sistema): buffer em memoria aqui (efemero, some a cada
// redeploy), consumido pelo proprio extract_op.ps1 deste projeto (pull -> staging local ->
// INSERT reaproveitando a conexao ja testada) - sem depender de outro projeto dessa vez, porque
// este BI ja tem sua propria extracao com Access funcionando.
let eventosAba = [];
let proximoEventoAbaId = 1;
const SISTEMA_PROPRIO = 'OPERACIONAL';

function registrarAba(email, aba, ip) {
  eventosAba.push({
    id: proximoEventoAbaId++,
    usuario: email,
    sistema: SISTEMA_PROPRIO,
    dataHora: new Date().toISOString(),
    ip: ip || '',
    aba
  });
}

// --- helpers ---------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function filterByEmpresas(arr, allowed) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((row) => allowed.includes(String(row.CodEmpresa)));
}

// recalcula os totais Hoje/Mes/Projecao a partir de PorEmpresa já filtrado - não usa o total
// global vindo do sync, senão um usuário restrito veria faturamento de empresa não autorizada
// embutido na soma total.
function filterResumoPedidos(resumo, allowed) {
  const filtrarBloco = (bloco) => {
    const porEmpresa = filterByEmpresas((bloco && bloco.PorEmpresa) || [], allowed);
    const faturamento = porEmpresa.reduce((sum, e) => sum + (e.Faturamento || 0), 0);
    const produtos = porEmpresa.reduce((sum, e) => sum + (e.Produtos || 0), 0);
    return {
      Faturamento: Math.round(faturamento * 100) / 100,
      Produtos: Math.round(produtos * 100) / 100,
      PorEmpresa: porEmpresa
    };
  };
  return {
    Hoje: filtrarBloco(resumo && resumo.Hoje),
    Mes: filtrarBloco(resumo && resumo.Mes),
    Projecao: filtrarBloco(resumo && resumo.Projecao)
  };
}

// Empresas de acesso (28/10): o sync principal manda o cadastro de empresas que o módulo de Acessos mostra
// (CONSULTA_EMPRESA) e as empresas antigas da organização 21 fora dele, ligadas à empresa que atende a UF delas
// (ex. 182 RN e 183 PB -> 136). Quem tem a empresa atual vê também os dados das antigas ligadas a ela.
function empresasAcesso() {
  const a = latestData && latestData.empresasAcesso;
  return a && Array.isArray(a.catalogo) && a.catalogo.length ? a : null;
}
function empresasDoUsuario(email) {
  if (!latestData) return [];
  const alvo = String(email).toLowerCase();
  const lista = [...new Set(latestData.usuariosEmpresas
    .filter((v) => String(v.email).toLowerCase() === alvo)
    .map((v) => String(v.empresa)))];
  const ac = empresasAcesso();
  if (ac) for (const [antiga, atual] of Object.entries(ac.alias || {})) if (lista.includes(String(atual)) && !lista.includes(String(antiga))) lista.push(String(antiga));
  return lista;
}
// "todas as empresas" = todas as do cadastro do módulo de Acessos (sem o cadastro ainda: as que aparecem em USUARIOS_EMPRESAS)
function temTodasEmpresas(allowed) {
  const ac = empresasAcesso();
  const universo = ac ? ac.catalogo.map(String) : [...new Set(((latestData && latestData.usuariosEmpresas) || []).map((v) => String(v.empresa)))];
  return universo.length > 0 && universo.every((e) => allowed.includes(e));
}

function usuarioAtivo(email) {
  if (!latestData) return null;
  const alvo = String(email).toLowerCase();
  return latestData.usuarios.find((u) => String(u.email).toLowerCase() === alvo && u.ativo) || null;
}

// --- seletor "Trocar de módulo" (link de volta pro Portal BI) -----------------
// Cada BI é desacoplado e extrai sua PRÓPRIA cópia de USUARIOS_SIS_BI (mesma tabela que o
// Portal já lê) só pra montar essa lista - quem decide de verdade quem pode acessar o quê
// continua sendo o Portal (rota /ir/:sistema de lá, que confere de novo e faz o handoff via
// SSO). Isso aqui é só pra não mostrar um botão pra um sistema que o usuário não tem acesso.
const SISTEMA_INFO = {
  LOGISTICA: { label: 'Logística', cor: '#0f8a7a' },
  FINANCEIRO: { label: 'Financeiro', cor: '#2f5ea8' },
  COMERCIAL: { label: 'Comercial', cor: '#7a4fb5' },
  REABASTECIMENTO: { label: 'Reabastecimento', cor: '#c1651a' },
  OPERACIONAL: { label: 'Operacional', cor: '#3f6178' },
  CADASTROS: { label: 'Cadastros', cor: '#b3327f' },
  CLARO: { label: 'Claro', cor: '#e30613' },
  CLARO_VALIDACAO: { label: 'Claro - Validação', cor: '#8a1420' },
  VIVO: { label: 'Vivo', cor: '#660099' },
  VIVO_VALIDACAO: { label: 'Vivo - Validação', cor: '#660099' },
  CARTEIRA_CLARO: { label: 'Claro - Gestão de Carteira', cor: '#b0101b' },
  TERRITORIAL_VIVO: { label: 'Vivo - Gestão Territorial', cor: '#4a0070' }
};
// "LOGÍSTICA" vem do Access com acento - remove diacríticos antes de comparar com as chaves
// ASCII de SISTEMA_INFO acima (mesmo cuidado já usado no Portal, ver normalizaSistema lá).
function normalizaSistema(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function outrosSistemasDoUsuario(email) {
  if (!latestData) return [];
  const alvo = String(email).toLowerCase();
  return (latestData.usuariosSistemas || [])
    .filter((v) => String(v.email).toLowerCase() === alvo)
    .map((v) => normalizaSistema(v.sistema))
    .filter((s) => s !== 'OPERACIONAL' && SISTEMA_INFO[s])
    .map((s) => ({ sistema: s, label: SISTEMA_INFO[s].label, cor: SISTEMA_INFO[s].cor, url: `${PORTAL_URL}/ir/${s.toLowerCase()}` }));
}

// --- autenticação ------------------------------------------------------------

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.session;
  if (!token) return res.redirect('/login');
  let payload;
  try {
    payload = jwt.verify(token, SESSION_SECRET);
  } catch (err) {
    res.clearCookie('session');
    return res.redirect('/login');
  }
  const usuario = usuarioAtivo(payload.email);
  if (!usuario) {
    res.clearCookie('session');
    return res.redirect('/login?desativado=1');
  }
  req.userEmail = payload.email;
  req.userNome = usuario.nome || payload.email;
  req.abas = abasValidas(payload.abas); // null = todas as abas
  next();
}

// --- abas liberadas (2026-10-16, Modulo de Acessos -> Portal -> token do /sso) --------------------------
// O Portal manda no token do /sso a lista de abas do usuario neste BI SO quando ha restricao
// (USUARIOS_SIS_BI_ABAS); sem o campo = todas. A lista fica no cookie de sessao (assinado) e vale ate o
// proximo login pelo Portal. Aba nao liberada: some da tela E o servidor nao manda os dados dela.
const ABAS_OPERACIONAL = ['status', 'pedidos', 'vendas-detalhe', 'estoquefilial', 'faturamento', 'comparar', 'inadimplencia', 'rastreio', 'consultarastreio', 'consultaiccid'];
function abasValidas(abas) {
  if (!Array.isArray(abas)) return null;
  // lado seguro: lista que so tem abas desconhecidas vira "nenhuma aba", nunca "todas"
  return [...new Set(abas.map(String).filter((a) => ABAS_OPERACIONAL.includes(a)))];
}
const abaLiberada = (abas, aba) => !abas || abas.includes(aba);
const algumaLiberada = (abas, lista) => lista.some((a) => abaLiberada(abas, a));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Muitas tentativas de login. Tente de novo em alguns minutos.' }
});

// Login direto por senha DESATIVADO (2026-10-16): a permissao por aba so chega pelo token do Portal;
// um login direto abriria todas as abas. A pagina /login ja redirecionava para o Portal desde 08/2026.
app.post('/api/login', express.json(), loginLimiter, (req, res) => {
  res.status(403).json({ ok: false, error: 'Entre pelo Portal BI.', portal: `${PORTAL_URL}/login` });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

// --- login único (handoff vindo do Portal BI) ---------------------------------
app.get('/sso', (req, res) => {
  if (!SSO_SHARED_SECRET) return res.status(503).send('Login único não está configurado neste servidor ainda.');
  const token = String(req.query.token || '');
  if (!token) return res.redirect('/login');

  let payload;
  try {
    payload = jwt.verify(token, SSO_SHARED_SECRET);
  } catch (err) {
    return res.redirect('/login?erro=sso_invalido');
  }
  if (payload.sistema !== 'OPERACIONAL') return res.redirect('/login?erro=sso_sistema');

  const usuario = usuarioAtivo(payload.email);
  if (!usuario) return res.redirect('/login?desativado=1');

  const abas = abasValidas(payload.abas);
  const sessionToken = jwt.sign(abas != null ? { email: usuario.email, abas } : { email: usuario.email }, SESSION_SECRET, { expiresIn: '12h' });
  res.cookie('session', sessionToken, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  res.redirect('/');
});

// --- sincronização (só o extract_op.ps1 / local_server.js do Ricardo chama isso) -------------

app.post('/api/sync', express.json({ limit: '25mb' }), async (req, res) => {
  const secret = req.header('X-Sync-Secret');
  if (!secret || secret !== SYNC_SECRET) return res.status(403).json({ ok: false, error: 'Segredo de sincronização inválido.' });

  const body = req.body || {};
  try {
    const usuarios = await Promise.all((body.usuarios || []).map(async (u) => ({
      email: u.email,
      nome: u.nome || u.email,
      ativo: !!u.ativo,
      passwordHash: await bcrypt.hash(String(u.senhaPlano || ''), 10)
    })));

    latestData = {
      clientes: body.clientes || [],
      pedidos: body.pedidos || [],
      pedidosResumo: body.pedidosResumo || { Hoje: { PorEmpresa: [] }, Mes: { PorEmpresa: [] }, Projecao: { PorEmpresa: [] } },
      vendasDetalhe: body.vendasDetalhe || [],
      // estoque + transferencias vao SEM filtro por empresa (aba "Estoque por Filial" mostra tudo
      // pra todo mundo, mesma regra do BI Logistica).
      estoque: body.estoque || [],
      transferencias: body.transferencias || [],
      comparativo: body.comparativo || [],
      comparativoTotais: body.comparativoTotais || [],
      faturamento: body.faturamento || [],
      meta: body.meta || {},
      usuarios,
      usuariosEmpresas: (body.usuariosEmpresas || []).map((v) => ({ email: v.email, empresa: String(v.empresa) })),
      usuariosSistemas: (body.usuariosSistemas || []).map((v) => ({ email: v.email, sistema: v.sistema })),
      empresasAcesso: body.empresasAcesso && Array.isArray(body.empresasAcesso.catalogo)
        ? { catalogo: body.empresasAcesso.catalogo.map(String), alias: Object.fromEntries(Object.entries(body.empresasAcesso.alias || {}).map(([k, v]) => [String(k), String(v)])) }
        : null,
      syncedAt: new Date().toISOString()
    };

    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(latestData));

    console.log(`Sincronizado às ${latestData.syncedAt} — ${usuarios.length} usuários, ${latestData.pedidos.length} pedidos, ${latestData.vendasDetalhe.length} linhas de venda.`);
    res.json({ ok: true, syncedAt: latestData.syncedAt, usuarios: usuarios.length, pedidos: latestData.pedidos.length });
  } catch (err) {
    console.error('Erro processando /api/sync:', err);
    res.status(500).json({ ok: false, error: 'Erro ao processar sincronização.' });
  }
});

// --- Detalhamento Inadimplência (aqtm_prod x Mira org 21) ---------------------------------------
app.post('/api/sync-inad', express.json({ limit: '25mb' }), (req, res) => {
  const secret = req.header('X-Sync-Secret');
  if (!secret || secret !== SYNC_SECRET) return res.status(403).json({ ok: false, error: 'Segredo de sincronização inválido.' });
  const body = req.body || {};
  const det = body.detalhe || {};
  if (!Array.isArray(det.mira) || !Array.isArray(det.aqt)) return res.status(400).json({ ok: false, error: 'Detalhe inválido.' });
  try {
    latestInad = { mira: det.mira, aqt: det.aqt, meta: body.meta || {}, syncedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(INAD_FILE), { recursive: true });
    fs.writeFileSync(INAD_FILE, JSON.stringify(latestInad));
    res.json({ ok: true, syncedAt: latestInad.syncedAt, mira: det.mira.length, aqt: det.aqt.length });
  } catch (err) {
    console.error('Erro processando /api/sync-inad:', err);
    res.status(500).json({ ok: false, error: 'Erro ao processar sincronização da inadimplência.' });
  }
});

// Linha com codEmpresa: só para quem tem a empresa. Linha sem empresa (distribuidores antigos e
// faturas sem pedido): só para quem tem TODAS as empresas que existem em USUARIOS_EMPRESAS.
app.get('/api/inadimplencia', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!abaLiberada(req.abas, 'inadimplencia')) return res.status(403).json({ ok: false, motivo: 'aba_nao_liberada' });
  if (!latestInad) return res.json({ ok: false, motivo: 'sem_dados' });
  const allowed = empresasDoUsuario(req.userEmail);
  const temTodas = temTodasEmpresas(allowed);
  const pode = (r) => (r.codEmpresa ? allowed.includes(String(r.codEmpresa)) : temTodas);
  res.json({ ok: true, meta: latestInad.meta, mira: latestInad.mira.filter(pode), aqt: latestInad.aqt.filter(pode), temTodas });
});

// --- Rastreio de Envios (banco correios_gateway da API dos Correios x Aqui Tem+ x Mira org 21) -------------------
app.post('/api/sync-rastreio', express.json({ limit: '25mb' }), (req, res) => {
  const secret = req.header('X-Sync-Secret');
  if (!secret || secret !== SYNC_SECRET) return res.status(403).json({ ok: false, error: 'Segredo de sincronização inválido.' });
  const body = req.body || {};
  if (!Array.isArray(body.envios) || !Array.isArray(body.cobertura)) return res.status(400).json({ ok: false, error: 'Dados de rastreio inválidos.' });
  try {
    latestRastreio = { envios: body.envios, cobertura: body.cobertura, meta: body.meta || {}, syncedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(RASTREIO_FILE), { recursive: true });
    fs.writeFileSync(RASTREIO_FILE, JSON.stringify(latestRastreio));
    res.json({ ok: true, syncedAt: latestRastreio.syncedAt, envios: body.envios.length, cobertura: body.cobertura.length });
  } catch (err) {
    console.error('Erro processando /api/sync-rastreio:', err);
    res.status(500).json({ ok: false, error: 'Erro ao processar sincronização do rastreio.' });
  }
});

// Mesma regra da inadimplência: linha com codEmpresa só para quem tem a empresa; sem empresa, só para quem tem todas.
app.get('/api/rastreio', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  // os mesmos dados alimentam "Rastreio de Envios" (gráficos e análises) e "Consulta de Rastreios" (lista)
  if (!algumaLiberada(req.abas, ['rastreio', 'consultarastreio'])) return res.status(403).json({ ok: false, motivo: 'aba_nao_liberada' });
  if (!latestRastreio) return res.json({ ok: false, motivo: 'sem_dados' });
  const allowed = empresasDoUsuario(req.userEmail);
  const temTodas = temTodasEmpresas(allowed);
  const pode = (r) => (r.codEmpresa ? allowed.includes(String(r.codEmpresa)) : temTodas);
  res.json({ ok: true, meta: latestRastreio.meta, envios: latestRastreio.envios.filter(pode), cobertura: latestRastreio.cobertura.filter(pode), temTodas });
});

// --- Consulta de ICCID -------------------------------------------------------------
app.post('/api/sync-iccid', express.raw({ type: 'application/octet-stream', limit: '40mb' }), (req, res) => {
  const secret = req.header('X-Sync-Secret');
  if (!secret || secret !== SYNC_SECRET) return res.status(403).json({ ok: false, error: 'Segredo de sincronização inválido.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Pacote de ICCID vazio.' });
  try {
    const P = iccidBusca.carregaPacote(req.body);
    P.syncedAt = new Date().toISOString();
    latestIccid = P;
    fs.mkdirSync(path.dirname(ICCID_FILE), { recursive: true });
    fs.writeFileSync(ICCID_FILE, req.body);
    res.json({ ok: true, syncedAt: P.syncedAt, chips: P.pos.length });
  } catch (err) {
    console.error('Erro processando /api/sync-iccid:', err);
    res.status(500).json({ ok: false, error: 'Erro ao processar o pacote de ICCID.' });
  }
});
const ICCID_MAX = 5000;
app.get('/api/iccid/meta', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!abaLiberada(req.abas, 'consultaiccid')) return res.status(403).json({ ok: false, motivo: 'aba_nao_liberada' });
  if (!latestIccid) return res.json({ ok: false, motivo: 'sem_dados' });
  const m = latestIccid.meta || {}, sgr = m.sgr || null;
  res.json({ ok: true, meta: { geradoEm: m.geradoEm, vendaDe: m.vendaDe, vendaAte: m.vendaAte, corteAtivacao: m.corteAtivacao || {}, sgr: sgr ? { vendaDe: sgr.vendaDe, vendaAte: sgr.vendaAte, inicioAtivacao: sgr.inicioAtivacao || {} } : null }, syncedAt: latestIccid.syncedAt, limite: ICCID_MAX });
});
app.post('/api/iccid/consulta', requireAuth, express.json({ limit: '2mb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!abaLiberada(req.abas, 'consultaiccid')) return res.status(403).json({ ok: false, motivo: 'aba_nao_liberada' });
  if (!latestIccid) return res.json({ ok: false, motivo: 'sem_dados' });
  const lista = Array.isArray(req.body && req.body.iccids) ? req.body.iccids : [];
  if (lista.length > ICCID_MAX) return res.status(400).json({ ok: false, motivo: 'muitos', limite: ICCID_MAX });
  // chip do Mira de empresa que o usuário não tem volta como "não encontrado" (não revela que existe); SGR: todos veem
  const allowed = empresasDoUsuario(req.userEmail);
  const r = iccidBusca.consulta(latestIccid, lista, (e) => allowed.includes(String(e)), true);
  res.json(Object.assign({ ok: true, corteAtivacao: (latestIccid.meta || {}).corteAtivacao || {} }, r));
});

// --- log de acessos por aba (fase 2) ------------------------------------------
app.post('/api/registrar-aba', requireAuth, express.json(), (req, res) => {
  const aba = String((req.body && req.body.aba) || '').slice(0, 100);
  if (!aba) return res.status(400).json({ ok: false, error: 'Informe a aba.' });
  registrarAba(req.userEmail, aba, req.ip);
  res.json({ ok: true });
});

app.get('/api/eventos-aba', (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  res.json({ ok: true, eventos: eventosAba });
});

app.post('/api/eventos-aba/confirmar', express.json(), (req, res) => {
  if (req.query.secret !== SYNC_SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  const ateId = Number((req.body && req.body.ateId) || 0);
  eventosAba = eventosAba.filter((e) => e.id > ateId);
  res.json({ ok: true, restantes: eventosAba.length });
});

// --- páginas -----------------------------------------------------------------

app.get('/login', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(`${PORTAL_URL}/login${qs}`);
});

app.get('/', requireAuth, (req, res) => {
  if (!latestData) {
    return res.status(503).send('Ainda não há dados sincronizados neste servidor. Peça para o Ricardo rodar a atualização local.');
  }

  const allowed = empresasDoUsuario(req.userEmail);
  // Cada bloco de dados so vai se ALGUMA aba que o usa estiver liberada (mapa conferido nos init*Tab do template).
  const ab = req.abas;
  const se = (abas, valor, vazio) => (algumaLiberada(ab, abas) ? valor() : vazio);
  const clientes = se(['pedidos', 'comparar'], () => filterByEmpresas(latestData.clientes, allowed), []);
  const pedidos = se(['status', 'pedidos'], () => filterByEmpresas(latestData.pedidos, allowed), []);
  const pedidosResumo = filterResumoPedidos(latestData.pedidosResumo, algumaLiberada(ab, ['pedidos']) ? allowed : []);
  const vendasDetalhe = se(['vendas-detalhe'], () => filterByEmpresas(latestData.vendasDetalhe, allowed), []);
  // "Estoque por Filial" mostra TODAS as empresas pra todo usuario (sem filterByEmpresas).
  const estoque = se(['estoquefilial', 'vendas-detalhe'], () => latestData.estoque || [], []);
  const transferencias = se(['estoquefilial'], () => latestData.transferencias || [], []);
  const comparativo = se(['comparar'], () => filterByEmpresas(latestData.comparativo, allowed), []);
  const comparativoTotais = se(['comparar'], () => filterByEmpresas(latestData.comparativoTotais, allowed), []);
  const faturamento = se(['faturamento'], () => filterByEmpresas(latestData.faturamento, allowed), []);
  const meta = latestData.meta || {};
  const outrosSistemas = outrosSistemasDoUsuario(req.userEmail);

  const html = TEMPLATE
    .replaceAll('__VERSION__', 'hospedado')
    .replaceAll('__RELEASE__', 'login')
    .replaceAll('__LOGO_DATA_URI__', 'data:image/png;base64,' + LOGO_B64)
    .replaceAll('__CLIENTES_JSON__', jsonForScript(clientes))
    .replaceAll('__PEDIDOS_JSON__', jsonForScript(pedidos))
    .replaceAll('__PEDIDOS_RESUMO_JSON__', jsonForScript(pedidosResumo))
    .replaceAll('__VENDAS_DETALHE_JSON__', jsonForScript(vendasDetalhe))
    .replaceAll('__ESTOQUE_JSON__', jsonForScript(estoque))
    .replaceAll('__TRANSFERENCIAS_JSON__', jsonForScript(transferencias))
    .replaceAll('__COMPARATIVO_JSON__', jsonForScript(comparativo))
    .replaceAll('__COMPARATIVO_TOTAIS_JSON__', jsonForScript(comparativoTotais))
    .replaceAll('__FATURAMENTO_JSON__', jsonForScript(faturamento))
    .replaceAll('__TODAY_ISO__', new Date().toISOString().slice(0, 10))
    .replaceAll('__PROCESSADO_EM__', meta.ProcessadoEm || 'desconhecido')
    .replaceAll('__HOSTED_USER_LABEL__', escapeHtml(req.userNome))
    .replaceAll('__HOSTED_SESSION__', '1')
    .replaceAll('__OUTROS_SISTEMAS_JSON__', jsonForScript(outrosSistemas))
    .replaceAll('__ABAS_PERMITIDAS_JSON__', jsonForScript(ab == null ? null : ab));

  res.set('Cache-Control', 'no-store');
  res.send(html);
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`Backend do BI Operacional rodando na porta ${PORT}`);
});
