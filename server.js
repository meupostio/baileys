// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO (CommonJS)
// ============================================
// Node 18+ (Render/Railway)
// ============================================

const express = require('express');
const cors = require('cors');
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// --------------------------------------------
// Logger
// --------------------------------------------
const logger = P({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' }
});

// --------------------------------------------
// Sessões em memória
// --------------------------------------------
const sessions = new Map(); // sessionId -> { sock, qrCodeData, connectionStatus, phoneNumber, qrTimestamp }

// --------------------------------------------
// Helper: autenticação por header
// --------------------------------------------
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --------------------------------------------
// Webhook com retry (opcional)
// --------------------------------------------
async function sendWebhook(payload, retries = 3) {
  if (!WEBHOOK_URL) return;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        logger.info(`✅ Webhook enviado: ${payload.eventType}`);
        return;
      } else {
        logger.warn(`⚠️ Webhook falhou (${response.status}) tentativa ${i + 1}/${retries}`);
      }
    } catch (e) {
      logger.error(`❌ Erro webhook tentativa ${i + 1}/${retries}: ${e.message}`);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
  }
}

// --------------------------------------------
// Sessão: criar se não existe
// --------------------------------------------
async function getOrCreateSession(sessionId = 'default') {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const sessionData = {
    sock: null,
    qrCodeData: null,
    connectionStatus: 'disconnected',
    phoneNumber: null,
    qrTimestamp: null
  };

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  return sessionData;
}

// --------------------------------------------
// Sessão: cleanup seguro
// --------------------------------------------
async function cleanupSession(sessionId = 'default') {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;

  if (sessionData.sock) {
    logger.info(`[${sessionId}] Limpando socket...`);
    try {
      if (sessionData.sock.user) {
        // se estiver autenticado, faz logout
        await sessionData.sock.logout();
        logger.info(`[${sessionId}] Logout ok`);
      }
    } catch (e) {
      logger.warn(`[${sessionId}] Aviso ao fechar socket: ${e.message}`);
    }
    try {
      sessionData.sock.end?.(); // encerra WS se existir
    } catch (e) {
      /* ignore */
    }
    sessionData.sock = null;
  }

  sessionData.qrCodeData = null;
  sessionData.connectionStatus = 'disconnected';
  sessionData.phoneNumber = null;
  sessionData.qrTimestamp = null;
}

// --------------------------------------------
// Criar conexão WhatsApp (gera QR se preciso)
// --------------------------------------------
async function createWhatsAppConnection(sessionId = 'default', options = {}) {
  const sessionData = await getOrCreateSession(sessionId);

  // Evita múltiplos sockets vivos
  if (sessionData.sock) {
    await cleanupSession(sessionId);
  }

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !!options.printQR, // respeita parâmetro
    logger: P({ level: 'warn' }),
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 2_000
  });

  sessionData.sock = sock;
  sessionData.connectionStatus = 'connecting';

  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrTimestamp = Date.now();
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] 📱 QR Code gerado`);
      await sendWebhook({ eventType: 'qr', sessionId, qrCode: qr, timestamp: new Date().toISOString() });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;

      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);
      await sendWebhook({
        eventType: 'connected',
        sessionId,
        phoneNumber: sessionData.phoneNumber,
        timestamp: new Date().toISOString()
      });
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.data?.statusCode ??
        lastDisconnect?.error?.statusCode ??
        null;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      sessionData.connectionStatus = 'disconnected';
      sessionData.qrCodeData = null;
      sessionData.phoneNumber = null;

      logger.warn(`[${sessionId}] ❌ Desconectado. Motivo: ${statusCode}. Reconectar? ${shouldReconnect}`);

      await sendWebhook({
        eventType: 'disconnected',
        sessionId,
        reason: statusCode,
        timestamp: new Date().toISOString()
      });

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        logger.info(`[${sessionId}] 🔄 Tentativa de reconexão ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), 5000);
      } else if (!shouldReconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${sessionId}] ⛔ Não irá reconectar automaticamente`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const messageType = Object.keys(msg.message)[0];
      let content = '';

      if (messageType === 'conversation') content = msg.message.conversation;
      else if (messageType === 'extendedTextMessage') content = msg.message.extendedTextMessage.text;

      logger.info(`[${sessionId}] 💬 ${remoteJid}: ${(content || '').slice(0, 80)}...`);

      await sendWebhook({
        eventType: 'message',
        sessionId,
        from: remoteJid,
        message: {
          key: msg.key,
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName
        },
        timestamp: new Date().toISOString()
      });
    }
  });

  return sessionData;
}

// ============================================
// ROTAS
// ============================================

// Públicas (sem API key) — útil para front pegar QR/health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sessions: sessions.size
  });
});

app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);

    if (!sessionData) {
      return res.json({ status: 'disconnected', message: 'Sessão não encontrada' });
    }

    // expiração de QR (60s)
    if (sessionData.qrCodeData && sessionData.qrTimestamp) {
      const age = Date.now() - sessionData.qrTimestamp;
      if (age > 60_000) {
        logger.warn(`[${sessionId}] ⏰ QR expirado (${Math.floor(age / 1000)}s)`);
        sessionData.qrCodeData = null;
      }
    }

    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ status: 'qr_ready', qr: qrBase64, qrcode: qrBase64 });
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({ status: 'connected', phone: sessionData.phoneNumber });
    }

    return res.json({ status: sessionData.connectionStatus || 'disconnected' });
  } catch (e) {
    logger.error('❌ Erro em /qrcode:', e);
    res.status(500).json({ error: e.message });
  }
});

// Protegidas (exigem x-api-key)
app.post('/create-session', requireApiKey, async (req, res) => {
  try {
    const { sessionId, printQR } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] 🚀 POST /create-session`);

    const sessionData = await createWhatsAppConnection(sid, { printQR });

    // pequena espera pro QR aparecer
    await new Promise(r => setTimeout(r, 1500));

    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ success: true, status: 'qr_ready', qr: qrBase64, qrcode: qrBase64 });
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({ success: true, status: 'connected', phone: sessionData.phoneNumber });
    }

    return res.json({ success: true, status: sessionData.connectionStatus || 'connecting' });
  } catch (error) {
    logger.error('❌ Erro em /create-session:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/disconnect', requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || 'default';
    logger.info(`[${sid}] 🔌 POST /disconnect`);
    await cleanupSession(sid);
    res.json({ success: true, message: 'Desconectado' });
  } catch (error) {
    logger.error('❌ Erro em /disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/logout', requireApiKey, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || 'default';
    logger.info(`[${sid}] 🚪 POST /logout`);
    // limpa sessão + remove credenciais
    await cleanupSession(sid);
    const authDir = path.join(__dirname, 'auth_info', sid);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info(`[${sid}] 📁 Auth removida`);
    }
    res.json({ success: true, message: 'Logout efetuado e credenciais removidas' });
  } catch (error) {
    logger.error('❌ Erro em /logout:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/session/:sessionId?', requireApiKey, async (req, res) => {
  try {
    const sid = req.params.sessionId || req.body.sessionId || 'default';
    logger.info(`[${sid}] 🗑️ DELETE /session`);
    await cleanupSession(sid);
    const authDir = path.join(__dirname, 'auth_info', sid);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info(`[${sid}] 📁 Pasta de autenticação removida`);
    }
    sessions.delete(sid);
    res.json({ success: true, message: 'Sessão deletada' });
  } catch (error) {
    logger.error('❌ Erro em DELETE /session:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-message', requireApiKey, async (req, res) => {
  try {
    const { sessionId, phone, message, image, caption } = req.body;
    const sid = sessionId || 'default';

    if (!phone || (!message && !image)) {
      return res.status(400).json({ error: '`phone` e (`message` ou `image`) são obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

    if (image) {
      await sessionData.sock.sendMessage(jid, {
        image: { url: image },
        caption: caption || message || ''
      });
    } else {
      await sessionData.sock.sendMessage(jid, { text: message });
    }

    logger.info(`[${sid}] ✉️ Mensagem enviada para ${phone}`);
    res.json({ success: true, message: 'Mensagem enviada' });
  } catch (error) {
    logger.error('❌ Erro em /send-message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/status', requireApiKey, (req, res) => {
  const all = {};
  sessions.forEach((data, sid) => {
    all[sid] = {
      status: data.connectionStatus,
      phone: data.phoneNumber,
      hasQR: !!data.qrCodeData,
      qrAge: data.qrTimestamp ? Math.floor((Date.now() - data.qrTimestamp) / 1000) : null
    };
  });
  res.json({ success: true, totalSessions: sessions.size, sessions: all, uptime: process.uptime() });
});

// --------------------------------------------
// Servidor
// --------------------------------------------
app.listen(PORT, () => {
  logger.info(`🚀 Baileys Multi-usuário rodando na porta ${PORT}`);
  logger.info(`🔑 API_KEY configurado: ${API_KEY ? 'Sim' : 'Não'}`);
  logger.info(`🪝 WEBHOOK_URL configurado: ${WEBHOOK_URL ? 'Sim' : 'Não'}`);
});

// Cleanup ao desligar
async function gracefulShutdown(signal) {
  logger.info(`⏸️ ${signal} recebido, desligando...`);
  for (const [sid] of sessions.entries()) {
    await cleanupSession(sid);
  }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
