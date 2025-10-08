// serve.js
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Armazena as sessões ativas por sessionId (use o user_id aqui)
const sessions = new Map();

// Middleware simples de API Key
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['api-key'] || req.headers['authorization'];
  if (!API_KEY) {
    logger.warn('API_KEY não configurada. Bloqueando acesso.');
    return res.status(500).json({ error: 'Server API key not configured' });
  }
  // Permite "Bearer {API_KEY}" ou valor direto
  const provided = (apiKey || '').replace(/^Bearer\s+/i, '').trim();
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Aplique autenticação em todas as rotas (ajuste se quiser públicos /health)
app.use(authenticate);

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      socket: null,
      qr: null,
      status: 'disconnected',
      phone: null,
      retryCount: 0,
      lastQrTime: null,
      authPath: path.resolve(`./baileys_auth_${sessionId}`),
    });
  }
  return sessions.get(sessionId);
}

async function sendWebhook(type, data, sessionId) {
  if (!WEBHOOK_URL) return;
  const payload = {
    type,
    sessionId,
    timestamp: new Date().toISOString(),
    data,
  };

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) return;
      logger.warn(`Webhook falhou (tentativa ${attempt}/${maxRetries}) status=${resp.status}`);
    } catch (e) {
      logger.warn(`Erro webhook (tentativa ${attempt}/${maxRetries}): ${e.message}`);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function cleanupSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    logger.info({ sessionId }, 'Limpando sessão...');
    if (s.socket) {
      try {
        await s.socket.logout();
      } catch (e) {
        logger.warn({ sessionId, err: e.message }, 'Erro ao fazer logout');
      }
      s.socket = null;
    }
    s.qr = null;
    s.status = 'disconnected';
    s.phone = null;
    s.retryCount = 0;
    s.lastQrTime = null;
  }
  // Remove pasta de auth
  const authPath = path.resolve(`./baileys_auth_${sessionId}`);
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      logger.info({ sessionId, authPath }, 'Auth dir removido');
    } catch (e) {
      logger.error({ sessionId, err: e.message }, 'Erro removendo auth dir');
    }
  }
}

async function createWhatsAppConnection(sessionId, opts = {}) {
  let s = getOrCreateSession(sessionId);
  logger.info({ sessionId, opts }, 'Criando conexão...');

  // Se pediu fresh/force, limpa completamente
  if (opts.force || opts.fresh) {
    await cleanupSession(sessionId);
    s = getOrCreateSession(sessionId);
  } else if (s.socket) {
    // Se já tem socket, tenta fechar
    try {
      await s.socket.logout();
    } catch (e) {
      logger.warn({ sessionId, err: e.message }, 'Erro ao fechar socket anterior');
    }
    s.socket = null;
  }

  // Garante pasta de auth
  if (!fs.existsSync(s.authPath)) {
    fs.mkdirSync(s.authPath, { recursive: true });
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(s.authPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      getMessage: async () => null,
    });

    s.socket = socket;
    s.status = 'connecting';
    s.qr = null;
    s.lastQrTime = Date.now();

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update || {};
      if (qr) {
        try {
          s.qr = await qrcode.toDataURL(qr);
          s.status = 'qr_ready';
          s.lastQrTime = Date.now();
          await sendWebhook('qr', { qr: s.qr }, sessionId);
          logger.info({ sessionId }, 'QR gerado');
        } catch (e) {
          logger.error({ sessionId, err: e.message }, 'Erro gerando QR');
        }
      }

      if (connection === 'open') {
        const phone = socket.user?.id?.split(':')[0] || null;
        s.status = 'connected';
        s.phone = phone;
        s.qr = null;
        s.retryCount = 0;
        await sendWebhook('connected', { phone }, sessionId);
        logger.info({ sessionId, phone }, 'Conectado');
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : undefined;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        logger.warn({ sessionId, code, shouldReconnect }, 'Desconectado');

        if (shouldReconnect && s.retryCount < 3) {
          s.retryCount++;
          setTimeout(() => createWhatsAppConnection(sessionId), 5000);
        } else {
          s.status = 'disconnected';
          s.socket = null;
          s.qr = null;
          s.phone = null;
          await sendWebhook('disconnected', {}, sessionId);
        }
      }
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages || []) {
        if (!m.message) continue;
        await sendWebhook(
          'message',
          {
            messageId: m.key.id,
            from: m.key.remoteJid,
            fromMe: m.key.fromMe,
            message: m.message,
            timestamp: m.messageTimestamp,
          },
          sessionId
        );
      }
    });

    return socket;
  } catch (e) {
    logger.error({ sessionId, err: e.message }, 'Erro criando conexão');
    s.status = 'error';
    s.socket = null;
    throw e;
  }
}

// ======== Rotas ========

// Cria/reconecta sessão (compatível com suas funções)
app.post('/create-session', async (req, res) => {
  try {
    const { session, sessionId, force, fresh } = req.body || {};
    const finalId = session || sessionId;
    if (!finalId) return res.status(400).json({ error: 'sessionId obrigatório' });

    await createWhatsAppConnection(finalId, { force, fresh });

    const s = getOrCreateSession(finalId);
    // espera curto por QR
    const until = Date.now() + 10_000;
    while (Date.now() < until && !s.qr && s.status === 'connecting') {
      await new Promise((r) => setTimeout(r, 400));
    }

    return res.json({
      success: true,
      status: s.status,
      qr: s.qr,
      qrcode: s.qr,
      phone: s.phone,
      sessionId: finalId,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// QR por sessão
app.get('/sessions/:sessionId/qrcode', (req, res) => {
  const { sessionId } = req.params || {};
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada' });
  const age = s.lastQrTime ? Date.now() - s.lastQrTime : null;
  const expired = age && age > 60_000;
  return res.json({
    status: s.status,
    qr: expired ? null : s.qr,
    qrcode: expired ? null : s.qr,
    phone: s.phone,
    qrExpired: !!expired,
    qrAge: age ?? null,
  });
});

// QR genérico (compatível com seu backend atual)
app.get('/qrcode', (req, res) => {
  const sessionId = req.query.sessionId;
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      const age = s.lastQrTime ? Date.now() - s.lastQrTime : null;
      const expired = age && age > 60_000;
      return res.json({
        status: s.status,
        qr: expired ? null : s.qr,
        qrcode: expired ? null : s.qr,
        phone: s.phone,
        sessionId,
      });
    }
  }
  // devolve primeiro QR válido
  for (const [id, s] of sessions.entries()) {
    const age = s.lastQrTime ? Date.now() - s.lastQrTime : null;
    const expired = age && age > 60_000;
    if (s.qr && !expired) {
      return res.json({
        status: s.status,
        qr: s.qr,
        qrcode: s.qr,
        phone: s.phone,
        sessionId: id,
      });
    }
  }
  return res.json({ status: 'disconnected', qr: null, qrcode: null, phone: null });
});

// Status
app.get('/status', (_req, res) => {
  const out = {};
  for (const [id, s] of sessions.entries()) {
    out[id] = {
      status: s.status,
      phone: s.phone,
      hasQr: !!s.qr,
      retryCount: s.retryCount,
    };
  }
  return res.json({ sessions: out, total: sessions.size });
});

// Remoção (compatibilidade: DELETE /sessions/:id e DELETE /session/:id?)
async function deleteSessionById(sessionId, res) {
  await cleanupSession(sessionId);
  sessions.delete(sessionId);
  return res.json({ success: true, message: 'Sessão removida' });
}

app.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatório' });
    return await deleteSessionById(sessionId, res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const { sessionId } = req.params || {};
    const bodyId = req.body?.sessionId;
    const finalId = sessionId || bodyId;
    if (!finalId) return res.status(400).json({ error: 'sessionId obrigatório' });
    return await deleteSessionById(finalId, res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Desconectar (compat: POST /sessions/:id/disconnect e POST /disconnect e POST /logout)
async function disconnectSession(sessionId, res) {
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada' });
  if (s.socket) {
    try {
      await s.socket.logout();
    } catch (e) {
      // segue
    }
    s.socket = null;
  }
  s.status = 'disconnected';
  s.qr = null;
  s.phone = null;
  await sendWebhook('disconnected', {}, sessionId);
  return res.json({ success: true, message: 'Sessão desconectada' });
}

app.post('/sessions/:sessionId/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.params || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatório' });
    return await disconnectSession(sessionId, res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatório' });
    return await disconnectSession(sessionId, res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId obrigatório' });
    return await disconnectSession(sessionId, res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, to, message } = req.body || {};
    if (!sessionId || !to || !message) {
      return res.status(400).json({ error: 'sessionId, to e message são obrigatórios' });
    }
    const s = sessions.get(sessionId);
    if (!s || !s.socket) {
      return res.status(404).json({ error: 'Sessão não encontrada ou desconectada' });
    }
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    const result = await s.socket.sendMessage(jid, { text: message });
    return res.json({ success: true, messageId: result?.key?.id, to: jid });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Inicia
app.listen(PORT, () => {
  logger.info(`Servidor Baileys ouvindo na porta ${PORT}`);
});

// Encerramento gracioso
process.on('SIGINT', async () => {
  logger.info('Encerrando...');
  for (const [id, s] of sessions.entries()) {
    if (s.socket) {
      try { await s.socket.logout(); } catch (_) {}
    }
  }
  process.exit(0);
});
