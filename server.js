// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO (CommonJS)
// ============================================
// Deploy no Render.com com Node 18+
// ============================================

const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// ============================================
// ESTRUTURA MULTI-USUÁRIO
// ============================================
const sessions = new Map(); // sessionId -> { sock, qrCodeData, connectionStatus, phoneNumber }

// Logger
const logger = P({ 
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty' }
});

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authenticate);

// ============================================
// FUNÇÃO: Cleanup de sessão
// ============================================
async function cleanupSession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;

  // Fechar socket com segurança
  if (sessionData.sock) {
    logger.info(`[${sessionId}] Limpando socket...`);
    try {
      // ✅ SÓ TENTA LOGOUT SE ESTIVER AUTENTICADO
      if (sessionData.sock.user) {
        await sessionData.sock.logout();
        logger.info(`[${sessionId}] Socket fechado com sucesso`);
      } else {
        logger.warn(`[${sessionId}] Socket não autenticado, pulando logout`);
      }
    } catch (e) {
      logger.warn(`[${sessionId}] Socket já estava fechado: ${e.message}`);
    }
    sessionData.sock = null;
  }

  // Limpar dados
  sessionData.qrCodeData = null;
  sessionData.connectionStatus = 'disconnected';
  sessionData.phoneNumber = null;
}

// ============================================
// FUNÇÃO: Obter ou criar sessão
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  // Criar nova sessão
  const sessionData = {
    sock: null,
    qrCodeData: null,
    connectionStatus: 'disconnected',
    phoneNumber: null,
    qrTimestamp: null
  };

  // Criar pasta de autenticação isolada
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  
  return sessionData;
}

// ============================================
// FUNÇÃO: Enviar webhook com retry
// ============================================
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
        logger.info(`✅ Webhook enviado: ${payload.event}`);
        return;
      } else {
        logger.warn(`⚠️ Webhook falhou (tentativa ${i + 1}/${retries}): ${response.status}`);
      }
    } catch (e) {
      logger.error(`❌ Erro ao enviar webhook (tentativa ${i + 1}/${retries}):`, e.message);
    }

    if (i < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2s entre tentativas
    }
  }
}

// ============================================
// FUNÇÃO: Criar conexão WhatsApp
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  // ✅ LIMPAR SOCKET ANTERIOR COM SEGURANÇA
  await cleanupSession(sessionId);

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR || true,
    logger: P({ level: 'warn' }),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000
  });

  sessionData.sock = sock;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;

  // ============================================
  // EVENT: Connection Update
  // ============================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code gerado
    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrTimestamp = Date.now();
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] 📱 QR Code gerado`);

      await sendWebhook({
        eventType: 'qr',
        sessionId,
        qrCode: qr,
        timestamp: new Date().toISOString()
      });
    }

    // Conectado
    if (connection === 'open') {
      reconnectAttempts = 0;
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null; // Limpar QR ao conectar
      
      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);
      
      await sendWebhook({
        eventType: 'connected',
        sessionId,
        phoneNumber: sessionData.phoneNumber,
        timestamp: new Date().toISOString()
      });
    }

    // Desconectado
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
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

      // Reconectar com limite
      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        logger.info(`[${sessionId}] 🔄 Tentativa de reconexão ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), 5000);
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${sessionId}] ⛔ Limite de reconexões atingido`);
      }
    }
  });

  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // EVENT: Mensagens recebidas
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      // Ignorar mensagens próprias ou vazias
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const messageType = Object.keys(msg.message)[0];
      let content = '';

      if (messageType === 'conversation') {
        content = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage.text;
      }

      logger.info(`[${sessionId}] 💬 Mensagem de ${remoteJid}: ${content.substring(0, 50)}...`);

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
// ENDPOINTS
// ============================================

// Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    sessions: sessions.size
  });
});

// 1. Criar sessão
app.post('/create-session', async (req, res) => {
  try {
    const { sessionId, reconnect, force, printQR } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] 🚀 POST /create-session`);

    const sessionData = await createWhatsAppConnection(sid, { printQR });
    
    // Aguarda 2s para gerar QR
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      
      return res.json({
        success: true,
        status: 'qr_ready',
        qr: qrBase64,
        qrcode: qrBase64
      });
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        success: true,
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    return res.json({
      success: true,
      status: sessionData.connectionStatus,
      message: 'Sessão iniciada, aguarde QR code'
    });
  } catch (error) {
    logger.error('❌ Erro em /create-session:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Obter QR Code
app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);

    if (!sessionData) {
      return res.json({ status: 'disconnected', message: 'Sessão não encontrada' });
    }

    // QR expirado? (60 segundos)
    if (sessionData.qrCodeData && sessionData.qrTimestamp) {
      const qrAge = Date.now() - sessionData.qrTimestamp;
      if (qrAge > 60000) {
        logger.warn(`[${sessionId}] ⏰ QR Code expirado (${Math.floor(qrAge / 1000)}s)`);
        sessionData.qrCodeData = null;
      }
    }

    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ 
        status: 'qr_ready',
        qr: qrBase64,
        qrcode: qrBase64 
      });
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    logger.error('❌ Erro em /qrcode:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Desconectar (compatibilidade com múltiplos endpoints)
app.post('/disconnect', async (req, res) => {
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

// Endpoints de compatibilidade
app.post('/sessions/:sessionId/disconnect', async (req, res) => {
  req.body.sessionId = req.params.sessionId;
  return app._router.handle(req, res);
});

app.post('/logout', async (req, res) => {
  return app._router.handle(req, res);
});

// 4. Deletar sessão (compatibilidade com múltiplos formatos)
app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const sessionId = req.params.sessionId || req.body.sessionId || 'default';

    logger.info(`[${sessionId}] 🗑️ DELETE /session`);

    await cleanupSession(sessionId);

    // Remover pasta de autenticação
    const authDir = path.join(__dirname, 'auth_info', sessionId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info(`[${sessionId}] 📁 Pasta de autenticação removida`);
    }

    sessions.delete(sessionId);
    
    res.json({ success: true, message: 'Sessão deletada' });
  } catch (error) {
    logger.error('❌ Erro em /delete-session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint alternativo
app.delete('/sessions/:sessionId', async (req, res) => {
  req.params.sessionId = req.params.sessionId;
  return app._router.handle(req, res);
});

// 5. Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message, image, caption } = req.body;
    const sid = sessionId || 'default';

    if (!phone || (!message && !image)) {
      return res.status(400).json({ error: 'phone e (message ou image) são obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    
    // Enviar imagem ou texto
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

// 6. Status geral
app.get('/status', (req, res) => {
  const allSessions = {};
  sessions.forEach((data, sid) => {
    allSessions[sid] = {
      status: data.connectionStatus,
      phone: data.phoneNumber,
      hasQR: !!data.qrCodeData,
      qrAge: data.qrTimestamp ? Math.floor((Date.now() - data.qrTimestamp) / 1000) : null
    };
  });

  res.json({
    success: true,
    totalSessions: sessions.size,
    sessions: allSessions,
    uptime: process.uptime()
  });
});

// Endpoint de compatibilidade
app.get('/sessions/:sessionId/qrcode', async (req, res) => {
  req.query.sessionId = req.params.sessionId;
  return app._router.handle(req, res);
});

// ============================================
// SERVIDOR
// ============================================
app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys Multi-usuário rodando na porta ${PORT}`);
  logger.info(`📱 Suporte para múltiplas sessões simultâneas`);
  logger.info(`🔑 API_KEY configurado: ${API_KEY ? 'Sim' : 'Não'}`);
  logger.info(`🪝 WEBHOOK_URL configurado: ${WEBHOOK_URL ? 'Sim' : 'Não'}`);
});

// Cleanup ao desligar
process.on('SIGINT', async () => {
  logger.info('⏸️ Desligando servidor...');
  for (const [sid] of sessions.entries()) {
    await cleanupSession(sid);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('⏸️ SIGTERM recebido, desligando...');
  for (const [sid] of sessions.entries()) {
    await cleanupSession(sid);
  }
  process.exit(0);
});
