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

function empresasDoUsuario(email) {
  if (!latestData) return [];
  const alvo = String(email).toLowerCase();
  return latestData.usuariosEmpresas
    .filter((v) => String(v.email).toLowerCase() === alvo)
    .map((v) => String(v.empresa));
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
  OPERACIONAL: { label: 'Operacional', cor: '#3f6178' }
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
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Muitas tentativas de login. Tente de novo em alguns minutos.' }
});

app.post('/api/login', express.json(), loginLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const senha = String((req.body && req.body.senha) || '');
  if (!email || !senha) return res.status(400).json({ ok: false, error: 'Informe e-mail e senha.' });
  if (!latestData) return res.status(503).json({ ok: false, error: 'Ainda não há dados sincronizados neste servidor.' });

  const usuario = usuarioAtivo(email);
  if (!usuario) return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos.' });

  const ok = await bcrypt.compare(senha, usuario.passwordHash);
  if (!ok) return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos.' });

  const token = jwt.sign({ email: usuario.email }, SESSION_SECRET, { expiresIn: '12h' });
  res.cookie('session', token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  res.json({ ok: true });
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

  const sessionToken = jwt.sign({ email: usuario.email }, SESSION_SECRET, { expiresIn: '12h' });
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
      // acessos tambem sem filtro por empresa (nao tem esse conceito - e log de login por
      // sistema, mesma regra de "mostra tudo" do estoque/transferencias acima).
      acessos: body.acessos || [],
      meta: body.meta || {},
      usuarios,
      usuariosEmpresas: (body.usuariosEmpresas || []).map((v) => ({ email: v.email, empresa: String(v.empresa) })),
      usuariosSistemas: (body.usuariosSistemas || []).map((v) => ({ email: v.email, sistema: v.sistema })),
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
  const clientes = filterByEmpresas(latestData.clientes, allowed);
  const pedidos = filterByEmpresas(latestData.pedidos, allowed);
  const pedidosResumo = filterResumoPedidos(latestData.pedidosResumo, allowed);
  const vendasDetalhe = filterByEmpresas(latestData.vendasDetalhe, allowed);
  // "Estoque por Filial" mostra TODAS as empresas pra todo usuario (sem filterByEmpresas).
  const estoque = latestData.estoque || [];
  const transferencias = latestData.transferencias || [];
  const acessos = latestData.acessos || [];
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
    .replaceAll('__ACESSOS_JSON__', jsonForScript(acessos))
    .replaceAll('__TODAY_ISO__', new Date().toISOString().slice(0, 10))
    .replaceAll('__PROCESSADO_EM__', meta.ProcessadoEm || 'desconhecido')
    .replaceAll('__HOSTED_USER_LABEL__', escapeHtml(req.userNome))
    .replaceAll('__HOSTED_SESSION__', '1')
    .replaceAll('__OUTROS_SISTEMAS_JSON__', jsonForScript(outrosSistemas));

  res.set('Cache-Control', 'no-store');
  res.send(html);
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`Backend do BI Operacional rodando na porta ${PORT}`);
});
