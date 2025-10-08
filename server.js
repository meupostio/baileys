// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO (Render Ready)
// ============================================
// Node 18+ | CommonJS
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

// --------------------------------------------
// CONFIGURAÇÕES BÁSICAS
// --------------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

// --------------------------------------------
// LOGGER
// --------------------------------------------
const logger = P({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty' }
});

// --------------------------------------------
// ESTRUTURA DE SESSÕES
// --------------------------------------------
const sessions = new Map(); // sessionId -> { sock, qrCodeData, connectionStatus, phoneNumber, qrTimestamp }

// --------------------------------------------
// MIDDLEWARE DE AUTENTICAÇÃO
// --------------------------------------------
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --------------------------------------------
// WEBHOOK (OPCIONAL)
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
      if (response.ok) return;
    } catch (e) {
      logger.warn(`Webhook erro (${i + 1}/${retries}): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

// --------------------------------------------
// FUNÇÕES AUXILIARES
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
  return sessionData;
}

async function cleanupSession(sessionId = 'default') {
  const data = sessions.get(sessionId);
  if (!data) return;
  if (data.sock) {
    try {
      await data.sock.logout?.();
    } catch {}
    try {
      await data.sock.ws?.close?.();
    } catch {}
  }
  data.sock = null;
  data.connectionStatus = 'disconnected';
  data.qrCodeData = null;
  data.phoneNumber = null;
}

// --------------------------------------------
// CRIAR CONEXÃO WHATSAPP
// --------------------------------------------
async function createWhatsAppConnection(sessionId = 'default', options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  await cleanupSession(sessionId);

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !!options.printQR,
    logger: P({ level: 'warn' })
  });

  sessionData.sock = sock;
  sessionData.connectionStatus = 'connecting';

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrTimestamp = Date.now();
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] QR pronto`);
    }

    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;
      logger.info(`[${sessionId}] ✅ Conectado: ${sessionData.phoneNumber}`);
      await sendWebhook({
        eventType: 'connected',
        sessionId,
        phoneNumber: sessionData.phoneNumber
      });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      sessionData.connectionStatus = 'disconnected';
      logger.warn(`[${sessionId}] Desconectado (${reason})`);
      if (shouldReconnect) {
        setTimeout(() => createWhatsAppConnection(sessionId, options), 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  return sessionData;
}

// --------------------------------------------
// ROTAS
// --------------------------------------------

// Health (público)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    sessions: sessions.size
  });
});

// QR público (para exibir no front)
app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const data = sessions.get(sessionId);
    if (!data) return res.json({ status: 'disconnected' });

    if (data.qrCodeData) {
      const base64 = await QRCode.toDataURL(data.qrCodeData);
      return res.json({ status: 'qr_ready', qr: base64 });
    }
    res.json({ status: data.connectionStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Criar sessão
app.post('/create-session', requireApiKey, async (req, res) => {
  try {
    const { sessionId, printQR } = req.body;
    const sid = sessionId || 'default';
    const data = await createWhatsAppConnection(sid, { printQR });

    await new Promise(r => setTimeout(r, 1500));
    if (data.qrCodeData) {
      const base64 = await QRCode.toDataURL(data.qrCodeData);
      return res.json({ success: true, status: 'qr_ready', qr: base64 });
    }

    res.json({ success: true, status: data.connectionStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar mensagem
app.post('/send-message', requireApiKey, async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    if (!phone || !message)
      return res.status(400).json({ error: 'phone e message obrigatórios' });
    const sid = sessionId || 'default';
    const data = sessions.get(sid);
    if (!data?.sock)
      return res.status(400).json({ error: 'Sessão não conectada' });
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await data.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Desconectar
app.post('/disconnect', requireApiKey, async (req, res) => {
  const sid = req.body.sessionId || 'default';
  await cleanupSession(sid);
  res.json({ success: true });
});

// Status geral
app.get('/status', requireApiKey, (req, res) => {
  const all = {};
  sessions.forEach((d, sid) => {
    all[sid] = {
      status: d.connectionStatus,
      phone: d.phoneNumber,
      hasQR: !!d.qrCodeData
    };
  });
  res.json({ success: true, sessions: all });
});

// --------------------------------------------
// INICIAR SERVIDOR
// --------------------------------------------
app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys rodando na porta ${PORT}`);
});

// Encerrar com limpeza
process.on('SIGINT', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
process.on('SIGTERM', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
